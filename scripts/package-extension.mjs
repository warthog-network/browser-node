/**
 * Build the Chromium extension and zip it for website / GitHub download.
 *
 *   npm run extension:package
 *   → public/downloads/warthog-browser-node-extension.zip
 *
 * Zip layout (Load unpacked after extract):
 *   warthog-browser-node/manifest.json
 *   warthog-browser-node/… (UI + WASM triad)
 *
 * Chrome does not install from a URL; users download, unzip, then
 * chrome://extensions → Developer mode → Load unpacked.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.join(root, 'extension');
const downloadsDir = path.join(root, 'public', 'downloads');
const zipName = 'warthog-browser-node-extension.zip';
const zipPath = path.join(downloadsDir, zipName);
const stagingName = 'warthog-browser-node';
const stagingRoot = path.join(root, '.extension-package');
const stagingDir = path.join(stagingRoot, stagingName);

/** Files/dirs that must not ship (Chrome local state, VCS noise). */
const EXCLUDE = new Set([
  '_metadata',
  '.git',
  '.gitignore',
  '.DS_Store',
]);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyTree(src, dest) {
  ensureDir(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(ent.name)) continue;
    if (ent.name.startsWith('.')) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyTree(from, to);
    } else if (ent.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function runBuild() {
  console.log('[package] building extension…');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-extension.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function assertExtensionReady() {
  const manifest = path.join(extensionDir, 'manifest.json');
  const wasm = path.join(extensionDir, 'node', 'wart-node.wasm');
  if (!fs.existsSync(manifest) || !fs.existsSync(wasm)) {
    console.error('[package] extension/ incomplete after build (missing manifest or WASM)');
    process.exit(1);
  }
}

function writeInstallNote(dir) {
  const text = `Warthog Browser Node — Chromium extension
========================================

Same full WASM node as the website, as a loadable extension
(Chrome / Brave / Edge). Side panel stays open while you browse.

Install (unpacked)
------------------
1. Unzip this archive (you should get a folder named warthog-browser-node).
2. Open chrome://extensions (or brave://extensions / edge://extensions).
3. Enable Developer mode (top right).
4. Click "Load unpacked" and select the warthog-browser-node folder
   (the one that contains manifest.json).
5. Pin the extension, click the toolbar icon → side panel opens.
6. Confirm Isolation OK + Shared memory OK, then Start node.

Do not run the node in the website tab and the extension at the same time
if you care about duplicate peers; each origin has its own OPFS chain DB.

Rebuild from source
-------------------
  npm install
  npm run extension:package

https://github.com/warthog-network/browser-node-bodega
`;
  fs.writeFileSync(path.join(dir, 'INSTALL.txt'), text, 'utf8');
}

function zipStaging() {
  ensureDir(downloadsDir);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  // Prefer system zip (available on Netlify Linux build image + local dev).
  const r = spawnSync(
    'zip',
    ['-r', '-q', zipPath, stagingName, '-x', '*/.DS_Store'],
    { cwd: stagingRoot, stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('[package] zip failed — is the `zip` CLI installed?');
    process.exit(r.status ?? 1);
  }
}

// --- main ---
runBuild();
assertExtensionReady();

rmrf(stagingRoot);
ensureDir(stagingDir);
copyTree(extensionDir, stagingDir);
writeInstallNote(stagingDir);

zipStaging();
rmrf(stagingRoot);

const bytes = fs.statSync(zipPath).size;
const miB = (bytes / (1024 * 1024)).toFixed(2);
console.log(`[package] wrote ${path.relative(root, zipPath)} (${miB} MiB)`);
console.log('[package] serve path: /downloads/warthog-browser-node-extension.zip');
console.log('[package] install: unzip → Load unpacked → select warthog-browser-node/');
