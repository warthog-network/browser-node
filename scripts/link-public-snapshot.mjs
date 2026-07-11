#!/usr/bin/env node
/**
 * Link a local chain.db3 into public/snapshot/ and refresh manifest.json.
 *
 * Usage:
 *   node scripts/link-public-snapshot.mjs
 *   node scripts/link-public-snapshot.mjs ~/Downloads/chain.db3
 *
 * Does NOT commit the multi‑GB file (gitignored). Safe for local/dev hosting.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const snapDir = path.join(root, 'public', 'snapshot');
const destDb = path.join(snapDir, 'chain.db3');
const destManifest = path.join(snapDir, 'manifest.json');

const src = path.resolve(
  process.argv[2]
    || path.join(process.env.HOME || '', 'Downloads', 'chain.db3'),
);

if (!fs.existsSync(src)) {
  console.error(`Source not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(snapDir, { recursive: true });

// Prefer hardlink (no extra disk). Fall back to symlink, then copy.
try {
  if (fs.existsSync(destDb)) fs.unlinkSync(destDb);
  fs.linkSync(src, destDb);
  console.log(`hardlinked ${src} → ${destDb}`);
} catch (e) {
  try {
    if (fs.existsSync(destDb)) fs.unlinkSync(destDb);
    fs.symlinkSync(src, destDb);
    console.log(`symlinked ${src} → ${destDb}`);
  } catch (e2) {
    console.warn(`link failed (${e2.message}); copying (slow / disk heavy)…`);
    fs.copyFileSync(src, destDb);
    console.log(`copied ${src} → ${destDb}`);
  }
}

const st = fs.statSync(destDb);

// Height via python sqlite3 (always available here); optional.
let height = null;
let journalMode = null;
const py = `
import sqlite3, json
c=sqlite3.connect(${JSON.stringify(`file:${destDb}?mode=ro`)}, uri=True)
print(json.dumps({
  "height": c.execute("SELECT max(height) FROM Blocks").fetchone()[0],
  "journal": c.execute("PRAGMA journal_mode").fetchone()[0],
}))
c.close()
`;
const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
if (r.status === 0) {
  try {
    const j = JSON.parse(r.stdout.trim());
    height = j.height;
    journalMode = j.journal;
  } catch {
    // ignore
  }
}

// Default local same-origin. Production uses Official1 absolute URL
// (see docs/OFFICIAL1-SNAPSHOT.md). Override: SNAPSHOT_PUBLIC_URL=https://…
const publicUrl = String(
  process.env.SNAPSHOT_PUBLIC_URL
  || process.env.PUBLIC_SNAPSHOT_URL
  || '/snapshot/chain.db3',
).trim();

const manifest = {
  name: 'chain.db3',
  url: publicUrl,
  bytes: st.size,
  height,
  journalMode,
  network: 'mainnet',
  preparedAt: new Date(st.mtimeMs).toISOString(),
  publishedAt: new Date().toISOString(),
  note:
    'Checkpointed DELETE-mode mainnet chain for browser WASM fast-start. '
    + (publicUrl.startsWith('http')
      ? `Hosted at ${publicUrl} (needs CORP: cross-origin under COEP).`
      : 'Served same-origin under /snapshot/ (COEP-safe local/dev).'),
};

fs.writeFileSync(destManifest, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('wrote', destManifest);
console.log(JSON.stringify(manifest, null, 2));
console.log(
  `\nOne-click import uses ${manifest.url} (${(st.size / (1024 ** 3)).toFixed(2)} GiB`
  + (height != null ? `, height ${height}` : '')
  + ').',
);
console.log('Remember: public/snapshot/chain.db3 is gitignored — do not force-add to git.');
