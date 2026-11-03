# DeFi testnet WASM triad (0.10.38)

Pin: core `f5e4e152` (`0.10.38`, "don't crash on duplicate hashes"), same commit
as VPS `warthog-api` on 217 (`--testnet`, `v0.10.38 "f5e4e152"`).

Do **not** mix with Official1 `public/node/` (0.9.6). Different GRUNT
(`TESTNET GRUNT?` vs `WARTHOG GRUNT?`), different DB schema, `--testnet`.

Stock emsdk 5.0.7 glue crashes Chrome/Brave stable pthreads (`undefined.buffer`
in `growMemViews` / WebRTC `Module.HEAPU8.buffer` after growth). After copy,
always run `scripts/patch-defi-glue.mjs`. The website loader imports this file
directly (no blob) so workers share the same script URL.

| Field | Value |
|-------|--------|
| Version | **0.10.38** → GRUNT `0x000A26` |
| Base core commit | `f5e4e152` |
| Toolchain | `emscripten/emsdk:5.0.7` |
| Host path | `/node/defi/wart-node.{js,wasm}` (pthread worker inlined in glue) |
| Glue / wasm | 182 KiB / 6.9 MiB |
| Heap | `WebAssembly.Memory` maximum **32768 pages = 2 GiB** |
| OPFS session | `/opfs/defi` (`--session /opfs/defi`) |
| Default peer | `wss://warthog-defitestnet.duckdns.org/ws` |
| App switch | `?network=defi` |

## Rebuild

```bash
export DOCKER_HOST=unix:///var/run/docker.sock
cd core-wasm-build-0.10.38
docker build --progress=plain --build-arg WARTHOG_COMMIT=f5e4e152 \
  . -f dockerfiles/build_emscripten --target export-stage -o ./wasm-out
mkdir -p ../warthog-browser-node/public/node/defi
cp -a wasm-out/wasm/wart-node.js wasm-out/wasm/wart-node.wasm \
  ../warthog-browser-node/public/node/defi/
# copy worker if present (emsdk 5.0.7 may inline pthreads)
test -f wasm-out/wasm/wart-node.worker.mjs \
  && cp wasm-out/wasm/wart-node.worker.mjs ../warthog-browser-node/public/node/defi/
test -f wasm-out/wasm/wart-node.worker.js \
  && cp wasm-out/wasm/wart-node.worker.js ../warthog-browser-node/public/node/defi/
# Chrome/Brave stable: growMemViews + async createWasm guards (not in stock emsdk 5.0.7)
node ../warthog-browser-node/scripts/patch-defi-glue.mjs
```

Keep `public/node/` as the Official1 0.9.6 triad.

Browser patches on this tree (not upstream): skip OPFS flock, null-check
`WS_PEERS`, 2048mb heap, drop `-mwasm64`, libc++ `-include wasm_std_compat.hpp`,
and the WASM endpoint surface `hook_endpoints.hxx` expects.
