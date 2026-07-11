# Browser WASM triad

Shipped files in this directory:

| File | Role |
|------|------|
| `wart-node.js` | Emscripten glue (MODULARIZE factory) + pthread entry |
| `wart-node.wasm` | Full node binary |
| `wart-node.worker.js` | Placeholder only (emsdk 3.1.74 uses `new Worker(new URL("wart-node.js", …))`) |

| Field | Value |
|-------|--------|
| Version | **0.9.6** (must match Official1 bridge) |
| Base core commit | `0eaafc39` (`v0.9.6: ban on bad RTC connection messages`) |
| Built | 2026-07-11 (emsdk **3.1.74** rebuild) |
| Toolchain | `emscripten/emsdk:3.1.74` (was 3.1.60) |
| `MAXIMUM_MEMORY` | **2048 MB** (was 768 MB — OOM ~¾ IBD) |
| Sync tunables | window **32**, maxRequests **32**, WebRTC **on**, SQLite `synchronous=NORMAL` + 128 MiB cache |
| **OPFS file offset** | **64-bit (`i64` pos + `bigintToI53Checked`)** — multi‑GiB chain.db3 OK |
| Stock upstream 0.9.6? | **No** — see patches below |

### OPFS offsets (fixed in this build)

`wart-node.wasm` imports `_wasmfs_opfs_read_access` / `_write_access` as
`(i32,i32,i32,i64)→i32` — file position is **i64** (emsdk i53abi). A 3.25 GiB
`journal_mode=DELETE` tip snapshot can open under OPFS.

```bash
wasm-objdump -x public/node/wart-node.wasm | grep opfs_read_access
# expect sig with i64 position, e.g. type (i32, i32, i32, i64) -> i32
```

Old **3.1.60** triad (i32 pos, 2 GiB wall): `backup-v0.9.6-emsdk3160/`.

**Important:** the live triad is **not** a clean export of the 0.9.6 tag. It is
`0eaafc39` **plus local patches** (InitMsgV3 + browser/Emscripten adaptations).
Rebuild only from that patched tree (or a core release that already includes the
InitMsgV3 fix **and** Emscripten-friendly filelock).

Older triads (do not use as default): `backup-v0.7.58/`, `backup-v0.9.15/`,
`backup-v0.9.6-emsdk3160/`.

---

## What to remember (short)

```text
Browser node WASM = v0.9.6 (0eaafc39)
  + InitMsgV3 type 30 send
  + Init type-0-as-V3 recv compat
  + Emscripten filelock skip
  + MAXIMUM_MEMORY=2048mb (stage-apply heap for full IBD)
  + download window 32 / maxRequests 32 / WebRTC default on
  + SQLite NORMAL sync + larger cache (OPFS IBD)
  + emsdk 3.1.74 (i64 OPFS offsets — multi‑GiB chain.db3)
  + small browser/build fixes
App (this repo) = COOP/COEP + WS glue v4 + OPFS lifecycle + Official1 bridge care
  + UI OOM detection · multi-peer · sync rate/ETA · chain.db3 snapshot import
```

- **GRUNT wire version** must stay **0.9.6** → `0x00000906`.
- **Stock 0.9.6 WASM** → GRUNT may succeed, then **Init → close 1006**.
- Upstream Init fix later landed as core `58031328` (*fix InitMsgV3 bug*); this
  build backports that idea onto 0.9.6 so the browser node matches Official1’s
  advertised version.

---

## Critical protocol fix (why Init no longer should 1006)

Upstream bug in 0.9.6: `InitMsgGeneratorV3` used `MsgCode<0>` (Init **V1** type)
while packing a **V3** body (+ RTC byte). Official1 then either:

- fails `EMSGINTEGRITY` (leftover RTC byte after V1 parse), or
- rejects with `EINITV1` on a v3 peer

→ WebSocket dies right after our ~61B Init (`close 1006`). That is a
**post-handshake** failure, not “can’t open /ws”.

Patches applied before this build (same direction as core `58031328` + recv
compat):

| Change | Typical file (core tree) | Why |
|--------|--------------------------|-----|
| **Send** type **30** (`MsgCode<InitMsgV3::msgcode>`) | `src/node/communication/messages.cpp` | Correct Init V3 on the wire |
| **Recv** compat: type `0` + full V3 body → accept as V3 | `src/node/communication/buffers/recvbuffer.cpp` | Talk to older buggy peers that still send mis-tagged V3 |

Without these, connect can look fine until first Init.

---

## Other core patches used for this browser WASM build

These are **build / browser adaptations**, not P2P protocol changes:

| Patch | Purpose |
|-------|---------|
| `filelock_unix.hpp` — skip flock under `__EMSCRIPTEN__` | OPFS does not behave like Unix `open`+`flock` on the DB path |
| `browser.cpp` — null-check `WS_PEERS` before `strlen` | Avoid crash if env is unset |
| `src/node/meson.build` — `-sMAXIMUM_MEMORY=2048mb` | 768 MB hard-capped heap aborted mid-IBD (`add_stage` / `Cannot enlarge memory`) |
| Block download window 32, `maxRequests` 32 | Parallel batches when multi-peer / WebRTC peers appear |
| Browser WebRTC default on | Official1 can introduce RTC peers for parallel download |
| SQLite `synchronous=NORMAL` + `cache_size=-131072` | Faster OPFS stage apply during IBD |
| `dockerfiles/build_emscripten` + meson | Clean cache, `-Dcpp_std=c++20`, pin project version `0.9.6`, export triad reliably |
| Small includes (`view.hpp`, `log_memory.hpp`, `rtc_connection.hpp`, spdlog wrap) | Build cleanly with emsdk 3.1.60 |

Local working tree for the build historically lived beside this monorepo as
`core-wasm-build-0.9.6` (detached HEAD at `0eaafc39` with the diffs above).

---

## Wire version

| Client | GRUNT packed version |
|--------|----------------------|
| This WASM node | **0.9.6** → `0x00000906` |

Must stay aligned with Official1’s expected peer version for the public bridge.

Outbound GRUNT (same as core `ConnectionBase`):

```text
→ 24B  "WARTHOG GRUNT?" + u32be version + zeros + u16be port
← 22B  "WARTHOG GRUNT!" + u32be version + zeros
→ 1B   0x00 ACK
```

CLI check from this repo: `npm run test:handshake`.

---

## Not core — app-layer requirements (this repo)

Still required for a working product, but **not** changes inside the 0.9.6 C++ tree:

| Piece | Location / note |
|-------|-----------------|
| **COOP + COEP** isolation | `netlify.toml`, `public/_headers`, `src/middleware.js`, `astro.config.mjs` — SharedArrayBuffer / pthreads |
| **WS handshake glue v4** | `src/lib/wasmNode.js` — delay WASM `onopen` ~250ms; **C++** sends real GRUNT (do **not** dual-handshake in JS) |
| **`WS_PEERS`** | Set on Module `ENV` from the UI / `?peers=`; semicolon-separated |
| **Local dev proxy** | Vite `/ws-bridge` → Official1 (browser stays same-origin) |
| **OPFS lifecycle** | One tab per origin; Clear / Recover / Stop kill workers; Stop leaves DBs intact |
| **Official1 care** | ~1 `/ws` connect per public IP (~30s); failed/timeout GRUNT can ban longer |
| **WASM OOM detection** | `isWasmOomError` in `src/lib/wasmNode.js`; UI badge/banner in `WasmBrowserNode.jsx` |
| **Multi-peer + sync rate** | Semicolon `WS_PEERS`; blocks/s + ETA vs network tip |
| **Snapshot import** | `src/lib/opfsSnapshot.js` — file/URL → OPFS `chain.db3` before Start |

UI: Start / Stop / Advanced tools live in `src/components/WasmBrowserNode.jsx`.

---

## Rebuild checklist

1. Start from core **0.9.6** (`0eaafc39`) or a release that already has InitMsgV3 type 30.
2. Ensure **send** uses `InitMsgV3::msgcode` and **recv** has type-0→V3 compat if you still need buggy-peer support.
3. Keep **Emscripten filelock skip** (or equivalent) so OPFS SQLite can open.
4. Keep **`-sMAXIMUM_MEMORY=2048mb`** (or higher) in `src/node/meson.build` — 768 MB dies ~¾ full sync.
5. Build with **emsdk ≥ 3.1.74** (Dockerfile pins this; need i53abi OPFS offsets):

```bash
cd core-wasm-build-0.9.6
docker build . -f dockerfiles/build_emscripten --target export-stage -o ./wasm-out-i53
cp wasm-out-i53/wasm/wart-node.js wasm-out-i53/wasm/wart-node.wasm \
   ../warthog-browser-node/public/node/
# pthread worker is the main glue (no separate .worker required)
```

6. Verify glue: heap max **2147483648** (2048 MiB); OPFS read/write `pos` is **i64**.
7. Smoke-test: Isolation OK → import multi‑GiB DELETE-mode snapshot → Start → GRUNT complete → height near tip; no Init `1006`.
8. Update this file’s **Built** date and toolchain if either changes.

---

## Symptom → cause

| Symptom | Likely cause |
|---------|----------------|
| Isolation false / SAB missing | COOP/COEP headers not on HTML |
| GRUNT never completes / open fails | Bridge down, rate-limit, ban, wrong `WS_PEERS` |
| GRUNT OK then close after ~61B Init | Stock 0.9.6 InitMsgV3 type bug (rebuild with patches) |
| `Cannot enlarge memory` / stack in `add_stage` ~¾ sync | WASM heap cap too low (need ≥2048 MB triad) |
| `readonly database` / OPFS locked | Another tab or stale pthread handles — Stop/Recover/Clear |
| Start right after Stop fails reconnect | Official1 connect slot (~30s) — wait and retry |
