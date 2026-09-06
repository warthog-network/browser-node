/**
 * Source patches for emsdk 5.0.7 pthread glue (DeFi `/node/defi/wart-node.js`).
 *
 * Chrome / Brave stable kill DeFi Start with:
 *   Pthread 0x… wart-node.js:401  TypeError: Cannot read properties of undefined (reading 'buffer')
 * Line 401 is `self.onunhandledrejection` rethrowing. The real access is
 * `growMemViews()` (`wasmMemory.buffer != HEAP8.buffer`) or `createWasm()`
 * running before HEAP views exist.
 *
 * Official1 0.9.6 glue is a different toolchain — do not apply these there.
 */

const GROW_MEM_VIEWS_OLD = `function growMemViews() {
  // \`updateMemoryViews\` updates all the views simultaneously, so it's enough to check any of them.
  if (wasmMemory.buffer != HEAP8.buffer) {
    updateMemoryViews();
  }
}`;

const GROW_MEM_VIEWS_NEW = `function growMemViews() {
  // HEAP8 is unset until the pthread "load" message installs wasmMemory.
  // Chrome/Brave stable can run growMemViews in that window; .buffer on
  // undefined becomes an unhandledrejection (glue line ~401).
  if (!wasmMemory) return;
  if (!HEAP8 || wasmMemory.buffer != HEAP8.buffer) {
    updateMemoryViews();
  }
}`;

const PTHREAD_LOAD_OLD = `        wasmMemory = msgData.wasmMemory;
        updateMemoryViews();
        wasmModule = msgData.wasmModule;
        createWasm();
        run();`;

const PTHREAD_LOAD_NEW = `        wasmMemory = msgData.wasmMemory;
        wasmModule = msgData.wasmModule;
        if (!wasmMemory) {
          throw new Error("pthread load: wasmMemory missing from main thread");
        }
        updateMemoryViews();
        // createWasm is async; a throw becomes an unhandled rejection (line 401)
        // if we do not chain. Do not call run() until the instance exists.
        Promise.resolve(createWasm()).then(() => {
          run();
        }).catch((ex) => {
          err(\`worker: createWasm failed: \${ex}\`);
          if (ex?.stack) err(ex.stack);
          throw ex;
        });`;

const UPDATE_MEMORY_VIEWS_OLD = `function updateMemoryViews() {
  var b = wasmMemory.buffer;`;

const UPDATE_MEMORY_VIEWS_NEW = `function updateMemoryViews() {
  if (!wasmMemory) {
    abort("updateMemoryViews: wasmMemory is not set (pthread load race)");
  }
  var b = wasmMemory.buffer;`;

export function patchEmscriptenPthreadGlue(source) {
  let out = String(source);
  // Official1 0.9.6 uses GROWABLE_HEAP_* not growMemViews — leave it alone.
  if (!out.includes('function growMemViews()')) return out;
  if (out.includes(GROW_MEM_VIEWS_OLD)) {
    out = out.replace(GROW_MEM_VIEWS_OLD, GROW_MEM_VIEWS_NEW);
  }
  if (out.includes(PTHREAD_LOAD_OLD)) {
    out = out.replace(PTHREAD_LOAD_OLD, PTHREAD_LOAD_NEW);
  }
  if (out.includes(UPDATE_MEMORY_VIEWS_OLD) && !out.includes('pthread load race')) {
    out = out.replace(UPDATE_MEMORY_VIEWS_OLD, UPDATE_MEMORY_VIEWS_NEW);
  }
  return out;
}

export function pthreadGluePatchApplied(source) {
  const s = String(source);
  return s.includes('if (!wasmMemory) return;')
    && s.includes('pthread load: wasmMemory missing from main thread')
    && s.includes('pthread load race');
}
