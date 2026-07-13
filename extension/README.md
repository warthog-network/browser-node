# Warthog Browser Node — Extension

Unpacked Chromium extension (Chrome, Brave, Edge). Same WASM full node as the website,
running on `chrome-extension://…` with COOP/COEP so SharedArrayBuffer / pthreads work.

## UI

| Entry | Behavior |
|-------|----------|
| **Toolbar icon** | Opens the **side panel** (like Brave Leo) — **stays open** while you browse |
| **Expand to tab** | Full dashboard (`node.html`) for a larger view |
| `popup.html` | Still built (optional); default action uses the side panel |

The side panel does **not** close when you click a web page. Closing the side panel
(or the full tab) **stops the node** — WASM lives in that document.

Do not Start the node in two surfaces at once (OPFS lock is exclusive per origin).

## Build

From the repo root:

```bash
npm run extension:build      # refresh extension/ for Load unpacked
npm run extension:package    # also write public/downloads/….zip for the website
```

`extension:build` refreshes `extension/` (UI bundle + WASM triad + manifest).
`extension:package` runs the build, then zips a clean folder for download.

## Load (Chrome / Brave / Edge)

### From the website zip

1. Download `/downloads/warthog-browser-node-extension.zip` from the deployed site.
2. Unzip — you get a folder named `warthog-browser-node`.
3. Open `chrome://extensions` (or `brave://extensions`).
4. Enable **Developer mode**.
5. **Load unpacked** → select the `warthog-browser-node` folder (contains `manifest.json`).
6. Pin the extension, click the toolbar icon → **side panel** opens on the right.
7. Confirm **Isolation OK** + **Shared memory OK**, then **Start node**.

### From a local build

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this `extension/` folder (or **Reload** after rebuild).
4. Pin the extension, click the toolbar icon → **side panel** opens on the right.
5. Confirm **Isolation OK** + **Shared memory OK**, then **Start node**.

## Why an extension helps on Brave

Extension pages are not subject to site Shields the same way as normal websites.
COOP/COEP come from the manifest, so isolation is reliable without tweaking Shields
for a Netlify origin.

## Notes

- Chain DB lives in OPFS for `chrome-extension://<id>` (separate from the website origin).
- P2P uses `wss://warthognode.duckdns.org/ws` (Official1).
- HTTP/snapshot fetch injects `Cross-Origin-Resource-Policy: cross-origin` via declarativeNetRequest.
- Optional multi-GB snapshot import still works if Official1 serves the file; otherwise use **Choose file…**.

## Permissions

| Permission | Why |
|------------|-----|
| `sidePanel` | Dock UI in the browser side panel (stays open) |
| `unlimitedStorage` | Multi-GB chain in OPFS |
| `host_permissions` Official1 | WebSocket bridge + HTTP head/snapshot |
| `declarativeNetRequestWithHostAccess` | CORP headers under COEP |
