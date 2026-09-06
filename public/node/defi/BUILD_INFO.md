# DeFi testnet WASM triad (0.10.22)

Pin: core `a73c6cda` (`0.10.22`), same as VPS `warthog-api` on 217 (`--testnet`).

Do **not** mix with Official1 `public/node/` (0.9.6). Different GRUNT
(`TESTNET GRUNT?` vs `WARTHOG GRUNT?`), different DB schema, `--testnet`.

| Field | Value |
|-------|--------|
| Version | **0.10.22** → GRUNT `0x000A16` |
| Base core commit | `a73c6cda` |
| Toolchain | `emscripten/emsdk:5.0.7` |
| Host path | `/node/defi/wart-node.{js,wasm}` (pthread worker inlined in glue) |
| Glue / wasm | 179 KiB / 6.9 MiB |
| Heap | `WebAssembly.Memory` maximum **32768 pages = 2 GiB** |
| OPFS session | `/opfs/defi` (`--session /opfs/defi`) |
| Default peer | `wss://warthog-defitestnet.duckdns.org/ws` |
| App switch | `?network=defi` |

## Rebuild

```bash
export DOCKER_HOST=unix:///var/run/docker.sock
cd core-wasm-build-0.10.22
docker build --progress=plain . -f dockerfiles/build_emscripten --target export-stage -o ./wasm-out
mkdir -p ../warthog-browser-node/public/node/defi
cp -a wasm-out/wasm/wart-node.js wasm-out/wasm/wart-node.wasm \
  ../warthog-browser-node/public/node/defi/
# copy worker if present (emsdk 5.0.7 may inline pthreads)
test -f wasm-out/wasm/wart-node.worker.mjs \
  && cp wasm-out/wasm/wart-node.worker.mjs ../warthog-browser-node/public/node/defi/
test -f wasm-out/wasm/wart-node.worker.js \
  && cp wasm-out/wasm/wart-node.worker.js ../warthog-browser-node/public/node/defi/
```

Keep `public/node/` as the Official1 0.9.6 triad.
