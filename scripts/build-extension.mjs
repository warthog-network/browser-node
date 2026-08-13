/**
 * Assemble an unpacked Chromium extension (Chrome / Brave / Edge).
 *
 *   npm run extension:build
 *   → load unpacked folder: extension/
 *
 * - Bundles the React dashboard with esbuild
 * - Copies WASM triad + logo
 * - Writes manifest with COOP/COEP for SharedArrayBuffer (pthreads)
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const EXT_VERSION = String(pkg.version || '1.3.0');
const outDir = path.join(root, 'extension');
const nodeSrc = path.join(root, 'public', 'node');
const imgSrc = path.join(root, 'public', 'img');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

// Clean previous bundle artifacts but keep README if present
for (const name of [
  'app.js',
  'app.css',
  'app.js.map',
  'background.js',
  'node.html',
  'popup.html',
  'sidepanel.html',
  'manifest.json',
  'rules.json',
  'node',
  'img',
  'icons',
]) {
  rmrf(path.join(outDir, name));
}
ensureDir(outDir);

console.log('[extension] bundling UI…');
await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'extension-entry.jsx')],
  bundle: true,
  outfile: path.join(outDir, 'app.js'),
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.css': 'css', '.js': 'js' },
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
  // Do NOT bundle the multi‑MB Emscripten glue — loaded at runtime from /node/
  external: [],
  logLevel: 'info',
  sourcemap: false,
  minify: false,
});

// WASM triad
const nodeOut = path.join(outDir, 'node');
ensureDir(nodeOut);
for (const f of [
  'wart-node.js',
  'wart-node.wasm',
  'wart-node.worker.js',
  'wart-node.worker.mjs',
]) {
  const src = path.join(nodeSrc, f);
  if (fs.existsSync(src)) {
    copyFile(src, path.join(nodeOut, f));
  }
}
if (fs.existsSync(path.join(nodeSrc, 'BUILD_INFO.md'))) {
  copyFile(path.join(nodeSrc, 'BUILD_INFO.md'), path.join(nodeOut, 'BUILD_INFO.md'));
}

// Logo / icons — full wordmark for UI; square mark for favicon + extension chrome
const logo = path.join(imgSrc, 'main_logo.png');
if (fs.existsSync(logo)) {
  copyFile(logo, path.join(outDir, 'img', 'main_logo.png'));
}
const iconsSrc = path.join(root, 'public', 'icons');
ensureDir(path.join(outDir, 'icons'));
for (const size of [16, 32, 48, 128]) {
  const icon = path.join(iconsSrc, `icon${size}.png`);
  if (fs.existsSync(icon)) {
    copyFile(icon, path.join(outDir, 'icons', `icon${size}.png`));
  } else {
    // Fallback: square favicon if sized set missing
    const fav = path.join(root, 'public', 'favicon.png');
    if (fs.existsSync(fav)) copyFile(fav, path.join(outDir, 'icons', `icon${size}.png`));
  }
}

// Shared shell: OPFS bootstrap + React mount (popup = MetaMask dropdown, node = full tab)
function makeShellHtml({ title }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="icon" type="image/png" href="icons/icon32.png" />
    <link rel="stylesheet" href="app.css" />
    <script>
      // Wipe OPFS before React/WASM mounts when recovering from locked SQLite DBs.
      window.__wartOpfsBootstrap = (async function wartOpfsBootstrap() {
        try {
          var params = new URLSearchParams(location.search);
          var reset =
            params.get('resetDb') === '1' ||
            params.get('resetdb') === '1' ||
            (function () {
              try {
                return sessionStorage.getItem('wartOpfsNeedsReset') === '1';
              } catch (e) {
                return false;
              }
            })();
          if (!reset) return { skipped: true };
          if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
            return { ok: false, error: 'no OPFS' };
          }
          var root = await navigator.storage.getDirectory();
          var removed = [];
          var failed = [];
          var names = [];
          for await (var entry of root.entries()) {
            names.push(entry[0]);
          }
          for (var i = 0; i < names.length; i++) {
            var name = names[i];
            try {
              await root.removeEntry(name, { recursive: true });
              removed.push(name);
            } catch (e) {
              failed.push(name + ': ' + (e && e.message ? e.message : e));
            }
          }
          if (failed.length === 0) {
            try { sessionStorage.removeItem('wartOpfsNeedsReset'); } catch (e) {}
            console.info('[opfs-bootstrap] wiped:', removed.length ? removed.join(', ') : '(empty)');
            return { ok: true, removed: removed };
          }
          console.warn('[opfs-bootstrap] partial wipe:', failed.join('; '));
          return { ok: false, removed: removed, failed: failed };
        } catch (e) {
          console.warn('[opfs-bootstrap]', e);
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="app.js"></script>
  </body>
</html>
`;
}
fs.writeFileSync(
  path.join(outDir, 'popup.html'),
  makeShellHtml({ title: 'Warthog Node' }),
  'utf8',
);
fs.writeFileSync(
  path.join(outDir, 'sidepanel.html'),
  makeShellHtml({ title: 'Warthog Node' }),
  'utf8',
);
fs.writeFileSync(
  path.join(outDir, 'node.html'),
  makeShellHtml({ title: 'Warthog Browser Node' }),
  'utf8',
);

// Background: side panel (stays open) + full tab helpers
const backgroundJs = `// Warthog browser node — service worker helpers.
// Default: toolbar icon opens the browser side panel (stays open while browsing).
// Optional: full tab for a larger dashboard. Don't run the node in two surfaces at once.
let dashboardTabId = null;

async function enableSidePanelOnAction() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn('[wart] setPanelBehavior failed', e);
  }
  try {
    await chrome.sidePanel.setOptions({
      path: 'sidepanel.html',
      enabled: true,
    });
  } catch (e) {
    console.warn('[wart] setOptions failed', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelOnAction();
});
chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnAction();
});
// Also on SW wake
enableSidePanelOnAction();

async function openFullDashboard() {
  const url = chrome.runtime.getURL('node.html');
  if (dashboardTabId != null) {
    try {
      const tab = await chrome.tabs.get(dashboardTabId);
      if (tab && tab.id != null) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      }
    } catch {
      dashboardTabId = null;
    }
  }
  const created = await chrome.tabs.create({ url });
  dashboardTabId = created.id ?? null;
}

async function openSidePanel(sender) {
  // Prefer the window that asked; fall back to current window.
  let windowId = sender?.tab?.windowId;
  if (windowId == null) {
    const win = await chrome.windows.getCurrent();
    windowId = win?.id;
  }
  if (windowId == null) {
    throw new Error('No windowId for side panel');
  }
  await chrome.sidePanel.open({ windowId });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === dashboardTabId) dashboardTabId = null;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'wart-open-full-tab') {
    openFullDashboard()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error('[wart]', e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true;
  }
  if (msg && msg.type === 'wart-open-side-panel') {
    openSidePanel(sender)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error('[wart]', e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true;
  }
  return false;
});
`;
fs.writeFileSync(path.join(outDir, 'background.js'), backgroundJs, 'utf8');

// Inject CORP on Official1 responses so COEP require-corp fetch/snapshot works
writeJson(path.join(outDir, 'rules.json'), [
  {
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        {
          header: 'Cross-Origin-Resource-Policy',
          operation: 'set',
          value: 'cross-origin',
        },
      ],
    },
    condition: {
      urlFilter: '||warthognode.duckdns.org',
      resourceTypes: ['xmlhttprequest', 'other', 'media', 'image', 'font', 'script', 'stylesheet'],
    },
  },
  {
    id: 2,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        {
          header: 'Cross-Origin-Resource-Policy',
          operation: 'set',
          value: 'cross-origin',
        },
      ],
    },
    condition: {
      urlFilter: '||warthog-defitestnet.duckdns.org',
      resourceTypes: ['xmlhttprequest', 'other', 'media'],
    },
  },
  {
    id: 3,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        {
          header: 'Cross-Origin-Resource-Policy',
          operation: 'set',
          value: 'cross-origin',
        },
      ],
    },
    condition: {
      urlFilter: '||cartesi-bridge.duckdns.org',
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  },
]);

// Manifest V3 — COOP/COEP enable SharedArrayBuffer for WASM pthreads
writeJson(path.join(outDir, 'manifest.json'), {
  manifest_version: 3,
  name: 'Warthog Browser Node',
  version: EXT_VERSION,
  description:
    'Run a Warthog full node in the browser (WASM + pthreads + OPFS). Icon opens the side panel (stays open while you browse).',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    // No default_popup: openPanelOnActionClick opens the side panel (Leo-style).
    default_title: 'Warthog Node (side panel)',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  background: {
    service_worker: 'background.js',
  },
  // Opt into cross-origin isolation → SharedArrayBuffer for Emscripten pthreads
  cross_origin_embedder_policy: {
    value: 'require-corp',
  },
  cross_origin_opener_policy: {
    value: 'same-origin',
  },
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  permissions: [
    'storage',
    'unlimitedStorage',
    'sidePanel',
    'declarativeNetRequestWithHostAccess',
  ],
  host_permissions: [
    'https://warthognode.duckdns.org/*',
    'wss://warthognode.duckdns.org/*',
    'https://warthog-defitestnet.duckdns.org/*',
    'wss://warthog-defitestnet.duckdns.org/*',
    'https://cartesi-bridge.duckdns.org/*',
  ],
  declarative_net_request: {
    rule_resources: [
      {
        id: 'corp_inject',
        enabled: true,
        path: 'rules.json',
      },
    ],
  },
});

const readme = `# Warthog Browser Node — Extension

Unpacked Chromium extension (Chrome, Brave, Edge). Same WASM full node as the website,
running on \`chrome-extension://…\` with COOP/COEP so SharedArrayBuffer / pthreads work.

## UI

| Entry | Behavior |
|-------|----------|
| **Toolbar icon** | Opens the **side panel** (like Brave Leo) — **stays open** while you browse |
| **Expand to tab** | Full dashboard (\`node.html\`) for a larger view |
| \`popup.html\` | Still built (optional); default action uses the side panel |

The side panel does **not** close when you click a web page. Closing the side panel
(or the full tab) **stops the node** — WASM lives in that document.

Do not Start the node in two surfaces at once (OPFS lock is exclusive per origin).

## Build

From the repo root:

\`\`\`bash
npm run extension:build      # refresh extension/ for Load unpacked
npm run extension:package    # also write public/downloads/….zip for the website
\`\`\`

\`extension:build\` refreshes \`extension/\` (UI bundle + WASM triad + manifest).
\`extension:package\` runs the build, then zips a clean folder for download.

## Load (Chrome / Brave / Edge)

### From the website zip

1. Download \`/downloads/warthog-browser-node-extension.zip\` from the deployed site.
2. Unzip — you get a folder named \`warthog-browser-node\`.
3. Open \`chrome://extensions\` (or \`brave://extensions\`).
4. Enable **Developer mode**.
5. **Load unpacked** → select the \`warthog-browser-node\` folder (contains \`manifest.json\`).
6. Pin the extension, click the toolbar icon → **side panel** opens on the right.
7. Confirm **Isolation OK** + **Shared memory OK**, then **Start node**.

### From a local build

1. Open \`chrome://extensions\` (or \`brave://extensions\`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this \`extension/\` folder (or **Reload** after rebuild).
4. Pin the extension, click the toolbar icon → **side panel** opens on the right.
5. Confirm **Isolation OK** + **Shared memory OK**, then **Start node**.

## Why an extension helps on Brave

Extension pages are not subject to site Shields the same way as normal websites.
COOP/COEP come from the manifest, so isolation is reliable without tweaking Shields
for a Netlify origin.

## Notes

- Chain DB lives in OPFS for \`chrome-extension://<id>\` (separate from the website origin).
- P2P uses \`wss://warthognode.duckdns.org/ws\` (Official1).
- HTTP/snapshot fetch injects \`Cross-Origin-Resource-Policy: cross-origin\` via declarativeNetRequest.
- Optional multi-GB snapshot import still works if Official1 serves the file; otherwise use **Choose file…**.

## Permissions

| Permission | Why |
|------------|-----|
| \`sidePanel\` | Dock UI in the browser side panel (stays open) |
| \`unlimitedStorage\` | Multi-GB chain in OPFS |
| \`host_permissions\` Official1 | WebSocket bridge + HTTP head/snapshot |
| \`declarativeNetRequestWithHostAccess\` | CORP headers under COEP |
`;

fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');

// Lease mode: do not bake share hex into the unpacked folder. The panel
// enrolls over HTTPS and keeps the share in RAM only.
const baked = path.join(outDir, 'signer-share.json');
if (fs.existsSync(baked)) fs.rmSync(baked, { force: true });
console.log('[extension] lease mode — no baked share (HTTPS enroll, RAM only)');

const wasmSize = fs.statSync(path.join(nodeOut, 'wart-node.wasm')).size;
console.log(`[extension] ready: ${outDir}`);
console.log(`[extension] wart-node.wasm ${(wasmSize / (1024 * 1024)).toFixed(1)} MiB`);
console.log('[extension] Load unpacked → select the extension/ folder in chrome://extensions');
