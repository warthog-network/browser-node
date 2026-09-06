#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patchEmscriptenPthreadGlue,
  pthreadGluePatchApplied,
} from '../src/lib/emscriptenPthreadGlue.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defi = fs.readFileSync(path.join(root, 'public', 'node', 'defi', 'wart-node.js'), 'utf8');
const official = fs.readFileSync(path.join(root, 'public', 'node', 'wart-node.js'), 'utf8');

if (!pthreadGluePatchApplied(defi)) {
  throw new Error('DeFi glue is missing pthread heap-view guards');
}
if (patchEmscriptenPthreadGlue(defi) !== defi) {
  throw new Error('DeFi glue patch is not idempotent');
}
if (defi.includes('if (wasmMemory.buffer != HEAP8.buffer)')) {
  throw new Error('DeFi glue still has unguarded growMemViews');
}
if (defi.includes('createWasm();\n        run();')) {
  throw new Error('DeFi glue still calls createWasm() without awaiting');
}
if (defi.includes('Module["HEAPU8"].buffer')) {
  throw new Error('DeFi glue still uses Module["HEAPU8"].buffer (WebRTC)');
}
if (!defi.includes('installLiveHeapExports')) {
  throw new Error('DeFi glue missing live HEAP getters');
}
if (!defi.includes('wasmfsOPFSIsStaleHandle')) {
  throw new Error('DeFi glue missing OPFS InvalidStateError retry');
}
if (!defi.includes('wasmfsOPFSRefreshRoot')) {
  throw new Error('DeFi glue missing OPFS root-handle refresh');
}
if (patchEmscriptenPthreadGlue(official) !== official) {
  throw new Error('Official1 glue must not be rewritten');
}
if (pthreadGluePatchApplied(official)) {
  throw new Error('Official1 glue unexpectedly has DeFi pthread patch markers');
}

console.log('ok: DeFi glue patched, Official1 untouched');
