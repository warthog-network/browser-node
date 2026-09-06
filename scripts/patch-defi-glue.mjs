#!/usr/bin/env node
/**
 * Apply emsdk 5.0.7 pthread heap-view guards to the vendored DeFi glue.
 *
 *   node scripts/patch-defi-glue.mjs
 *
 * Run after copying wasm-out/wasm/wart-node.js → public/node/defi/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patchEmscriptenPthreadGlue,
  pthreadGluePatchApplied,
} from '../src/lib/emscriptenPthreadGlue.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gluePath = path.join(root, 'public', 'node', 'defi', 'wart-node.js');

if (!fs.existsSync(gluePath)) {
  console.error(`[patch-defi-glue] missing ${gluePath}`);
  process.exit(1);
}

const before = fs.readFileSync(gluePath, 'utf8');
if (pthreadGluePatchApplied(before)) {
  console.log('[patch-defi-glue] already applied');
  process.exit(0);
}

const after = patchEmscriptenPthreadGlue(before);
if (after === before) {
  console.error('[patch-defi-glue] glue did not match expected emsdk 5.0.7 snippets — update src/lib/emscriptenPthreadGlue.js');
  process.exit(1);
}
if (!pthreadGluePatchApplied(after)) {
  console.error('[patch-defi-glue] patch ran but markers missing');
  process.exit(1);
}

fs.writeFileSync(gluePath, after);
console.log(`[patch-defi-glue] patched ${path.relative(root, gluePath)} (${before.length} → ${after.length} bytes)`);
