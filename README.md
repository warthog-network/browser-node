# Warthog Browser Full Node (WASM)

Run a real **Warthog full node in the browser** (Emscripten WASM + pthreads + OPFS), not a remote RPC dashboard.

| Piece | Location |
|--------|----------|
| WASM triad | `public/node/wart-node.{js,wasm,worker.js}` (**v0.9.6 patched**, matches Official1) |
| UI | `src/components/WasmBrowserNode.jsx` |
| Boot + WS glue | `src/lib/wasmNode.js` |
| Official1 defaults | `src/lib/bridge.js` → `wss://warthognode.duckdns.org/ws` |
| Core / rebuild notes | [`public/node/BUILD_INFO.md`](public/node/BUILD_INFO.md) |

## Requirements

Page must be **cross-origin isolated**:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Set in `netlify.toml`, `public/_headers`, and `astro.config.mjs` (dev).

## Chromium extension (Chrome / Brave / Edge)

Same full WASM node as a **loadable unpacked extension**. Extension pages get COOP/COEP from the manifest (SharedArrayBuffer works even when Brave Shields break the website).

### Download (production site)

Netlify build runs `extension:package` and publishes:

```text
/downloads/warthog_node_extension.zip
```

Install: unzip → `chrome://extensions` → Developer mode → **Load unpacked** → select `warthog_node_extension/` (contains `manifest.json`). The website UI also links this zip.

Chrome will **not** install the extension from a URL alone; zip + Load unpacked (or later Chrome Web Store) is required.

### Local build / package

```bash
npm install
npm run extension:build      # refresh extension/ (Load unpacked from that folder)
npm run extension:package    # build + zip → public/downloads/….zip
# chrome://extensions → Developer mode → Load unpacked → select extension/
# Click toolbar icon → side panel opens (stays open while you browse, like Leo)
# Isolation OK → Start node  ·  Expand to tab for a full-page view
```

Optional GitHub Release (same artifact as the site):

```bash
npm run extension:package
gh release create browser-node-extension-v1.5.1 \
  public/downloads/warthog_node_extension.zip \
  --title "Browser Node extension v1.5.1" \
  --notes "Unzip → Load unpacked → select warthog_node_extension/"
```

Details: [`extension/README.md`](extension/README.md). Rebuild after UI/WASM changes.

## Local development

```bash
npm install
npm run dev
# open http://127.0.0.1:4321/
# Isolation badge must be OK → click "Start full WASM node" once
```

### Peer URL

| Environment | Default `WS_PEERS` |
|-------------|-------------------|
| **localhost** | `ws://…/ws-bridge` (Vite proxies to Official1) |
| **Netlify / production** | `wss://warthognode.duckdns.org/ws` (direct) |

Override anytime:

```text
?peers=wss://warthognode.duckdns.org/ws
```

Or UI buttons: **Use public Official1** / **Use local /ws-bridge**.

### CLI GRUNT test (network truth)

```bash
npm run test:handshake
npm run test:handshake:wait   # 35s cool-down then handshake
```

Wire format (outbound client):

```text
→ 24B  WARTHOG GRUNT? + u32be version + port
← 22B  WARTHOG GRUNT! + u32be version
→ 1B   0x00 ACK
```

Do **not** spam Probe /ws on Official1 (rate-limit / ban).

## Deploy to Netlify + GitHub

1. Create a GitHub repo and push this folder:

```bash
cd warthog-browser-node
git init
git add .
git commit -m "Initial Warthog browser full node (WASM)"
git branch -M main
git remote add origin git@github.com:YOUR_USER/warthog-browser-node.git
git push -u origin main
```

2. [Netlify](https://app.netlify.com) → **Add new site** → **Import from Git** → pick the repo.

3. Build settings (usually auto from `netlify.toml`):

   - Build command: `npm run build`
   - Publish directory: `dist`
   - Node: `22`

4. Deploy. Open the site → **Isolation OK** → **Start full WASM node**.

5. Production uses **public** `wss://warthognode.duckdns.org/ws` (no `/ws-bridge`).

### Netlify checklist

After deploy, hard-refresh the live URL and confirm:

- [ ] Badge is **Isolation OK** (not “Need COOP/COEP”)
- [ ] Runtime: `crossOriginIsolated` = **true**, SharedArrayBuffer = **available**
- [ ] DevTools → Network → first document → response headers include:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- [ ] Console after Start shows `installed v4`
- [ ] Production uses public `wss://warthognode.duckdns.org/ws` (no `/ws-bridge`)

**If isolation is still false:** headers never reached the HTML. This repo sets them in
`src/middleware.js` (SSR), `netlify.toml`, and `public/_headers`. Redeploy the latest
commit; do not use a static-only publish that drops SSR.

## Known behavior

- OPFS stores chain DBs in the browser; **one tab** per origin. Keep the tab **focused** during IBD (background tabs get throttled).
- **Stop** kills workers in this tab and leaves OPFS intact; **Start** again after a short settle (Official1 may need ~30s between connects).
- **Faster sync:** multi-peer `WS_PEERS` (`;`-separated), WebRTC on by default, larger download window; optional **public chain.db3 snapshot** (hero / Advanced) to skip most of genesis→tip.
- **Transactions / virtual RPC** (not a website-wallet node URL): see **[`docs/TRANSACTIONS.md`](docs/TRANSACTIONS.md)**.

### Public chain snapshot (optional)

Serve a prepared mainnet `chain.db3` at same-origin `/snapshot/chain.db3` (COEP-safe):

```bash
# links ~/Downloads/chain.db3 → public/snapshot/chain.db3 + refreshes manifest.json
npm run snapshot:link
# or: npm run snapshot:link -- /path/to/chain.db3
```

- `public/snapshot/manifest.json` is committed (height / size metadata).
- `public/snapshot/chain.db3` is **gitignored** (multi‑GB — do not force-add or Netlify-deploy).
- UI probes the `.db3` URL on load; **Import snapshot** only appears when the file is reachable.
- **Local:** `npm run snapshot:link` + `npm run dev` → same-origin path works.
- **Production:** host on **Official1** (`https://warthognode.duckdns.org/snapshot/chain.db3`).
  Full ops: **[`docs/OFFICIAL1-SNAPSHOT.md`](docs/OFFICIAL1-SNAPSHOT.md)**  
  (nginx `location /snapshot/` + checkpointed copy under `/var/www/warthog-snapshot/`).
  - `manifest.json` already points at that absolute URL once the VPS file exists.
  - Optional Netlify env: `PUBLIC_SNAPSHOT_URL=https://warthognode.duckdns.org/snapshot/chain.db3`
  - Host must send `Cross-Origin-Resource-Policy: cross-origin` (COEP) + CORS GET
  - never route multi‑GB through `/api/proxy`
  - Until the VPS serves 200, UI hides one-click import; users can still **Choose file…**
- Override also: `?snapshot=https://…/chain.db3`
- Official1 may rate-limit ~1 `/ws` connect per public IP (~30s); failed GRUNT can ban longer.
- If GRUNT succeeds then socket closes after first Init (`tx 61B` → `1006`), that is a **post-handshake** issue (not “can’t connect”) — see InitMsgV3 notes below.

## Core WASM: not stock 0.9.6

The files under `public/node/` are a **full node** compiled from Warthog core
**v0.9.6 (`0eaafc39`) plus local patches**. Do not assume a clean 0.9.6 tag
export will work against Official1.

Full detail: **[`public/node/BUILD_INFO.md`](public/node/BUILD_INFO.md)**.

### What to remember

```text
Browser node WASM = v0.9.6 (0eaafc39)
  + InitMsgV3 type 30 send
  + Init type-0-as-V3 recv compat
  + Emscripten filelock skip
  + MAXIMUM_MEMORY=2048mb (full IBD stage-apply heap)
  + small browser/build fixes
App (this repo) = COOP/COEP + WS glue v4 + OPFS lifecycle + Official1 bridge care
  + UI detects "Cannot enlarge memory" (Out of memory badge)
```

| Area | Notes |
|------|--------|
| **Must-have protocol fix** | Stock 0.9.6 sent Init **V3 body** with type **0** (V1). Official1 can fail integrity / reject → WS **1006** after GRUNT. Patched send uses type **30**; recv accepts mis-tagged V3 for buggy peers. Same idea as later core `58031328`. |
| **Browser/build patches** | Skip Unix flock under Emscripten (OPFS); null-safe `WS_PEERS`; **`-sMAXIMUM_MEMORY=2048mb`** (768 MB OOM’d ~¾ IBD in `add_stage`); emsdk 3.1.60 Docker/meson export of the triad. |
| **Wire version** | GRUNT must advertise **0.9.6** (`0x00000906`) to match Official1. |
| **Not core (this app)** | Isolation headers; JS WS glue **v4** (delay onopen; C++ does GRUNT — no dual handshake in JS); OPFS one-tab / Recover / Stop; bridge rate-limit care; WASM OOM detection. |
| **Rebuild** | Only from the patched tree (or core that already has InitMsgV3 + Emscripten filelock). Keep ≥2048 MB max heap. Update `BUILD_INFO.md` when commit/date changes. |
| **Backups** | `public/node/backup-v0.7.58/`, `backup-v0.9.15/` — older; not the default triad. |

### Symptom → cause (quick)

| Symptom | Likely cause |
|---------|----------------|
| Isolation false / SAB missing | COOP/COEP headers not on HTML |
| GRUNT never completes | Bridge down, rate-limit, ban, wrong `WS_PEERS` |
| GRUNT OK then close after ~61B Init | Stock 0.9.6 InitMsgV3 type bug — need patched WASM |
| `Cannot enlarge memory` / crash ~¾ sync | Old 768 MB heap triad — need 2048 MB build |
| `readonly database` / OPFS locked | Another tab or stale workers — Stop / Recover / Clear |
| Start fails right after Stop | Official1 connect slot (~30s) — wait and retry |

## License / assets

WASM binary is built from Warthog core (patched 0.9.6 as above); ship only what your project license allows.
