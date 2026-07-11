# Official1 public chain snapshot

Production (Netlify) **cannot** ship multi‑GB `chain.db3`. Host a checkpointed
copy on the **Official1 bridge VPS** (`warthognode.duckdns.org`) and point the
browser app at it.

## Why the bridge VPS

| Option | Pros | Cons |
|--------|------|------|
| **Official1 VPS** | Already trusted; TLS + nginx; same ops as `/ws` | Bandwidth / disk; protect live node DB |
| Netlify | Same-origin | Soft limits; gitignore forbids multi‑GB deploy |
| Random CDN | Scalable | Extra CORP/CORS setup; another host to trust |

## Hard rules

1. **Never serve the live** `~/.warthog/chain.db3` while the node is running  
   (WAL / hot copy → SQLite disk I/O in the browser).
2. Publish a **stopped, checkpointed, DELETE-mode** copy only.
3. Under COEP (`require-corp`), responses need  
   `Cross-Origin-Resource-Policy: cross-origin` (see handoff nginx).
4. Do **not** route multi‑GB downloads through the browser site’s `/api/proxy`.

## Target URLs

| File | Public URL |
|------|------------|
| DB | `https://warthognode.duckdns.org/snapshot/chain.db3` |
| Manifest | `https://warthognode.duckdns.org/snapshot/manifest.json` (optional; app still ships its own) |

App wiring (this repo):

- `public/snapshot/manifest.json` → absolute `url` on Official1  
- or Netlify env `PUBLIC_SNAPSHOT_URL=https://warthognode.duckdns.org/snapshot/chain.db3`

## On the VPS (as root)

### 1. Directory

```bash
mkdir -p /var/www/warthog-snapshot
chown root:www-data /var/www/warthog-snapshot
chmod 755 /var/www/warthog-snapshot
```

### 2. Prepare a safe snapshot (on VPS or laptop)

**If publishing from the live Official1 data dir** (stops P2P briefly):

```bash
systemctl stop warthog-api.service
# wait until fully stopped
sqlite3 /home/warthog/.warthog/chain.db3 \
  "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;"
# confirm no sidecars
ls -la /home/warthog/.warthog/chain.db3*
# copy OUTSIDE the live dir, then start node again
cp -a /home/warthog/.warthog/chain.db3 /var/www/warthog-snapshot/chain.db3
chown root:www-data /var/www/warthog-snapshot/chain.db3
chmod 644 /var/www/warthog-snapshot/chain.db3
systemctl start warthog-api.service
```

**If uploading from your laptop** (already checkpointed `~/Downloads/chain.db3`):

```bash
# from laptop (~3.25 GiB — long upload)
rsync -avP --partial ~/Downloads/chain.db3 \
  root@warthognode.duckdns.org:/var/www/warthog-snapshot/chain.db3
```

Optional: also drop a small `manifest.json` next to it (height/bytes) for humans;
the Netlify site has its own catalog copy.

### 3. Nginx

Merge `location /snapshot/` from  
`browser-node-website/docs/vps-handoff/nginx-warthog-official1.conf`  
into `/etc/nginx/sites-available/warthog` **before** the catch-all `location /`
(so static files are not proxied to `:3000`).

```bash
nginx -t && systemctl reload nginx
```

### 4. Verify (from any machine)

```bash
# Must be 200 + CORP (not 502 from the RPC proxy)
curl -sI https://warthognode.duckdns.org/snapshot/chain.db3 | head -20

# Expect among headers:
#   HTTP/2 200
#   content-length: <~3e9>
#   cross-origin-resource-policy: cross-origin
#   access-control-allow-origin: *
#   accept-ranges: bytes
```

COEP smoke (browser console on the Netlify site):

```js
fetch('https://warthognode.duckdns.org/snapshot/chain.db3', {
  method: 'HEAD',
  mode: 'cors',
  credentials: 'omit',
}).then((r) => console.log(r.status, [...r.headers.entries()]))
```

## App / Netlify

After the VPS returns **200 + CORP**:

1. Commit `manifest.json` with absolute Official1 `url` (this repo does).
2. Redeploy Netlify (or set `PUBLIC_SNAPSHOT_URL` as belt-and-suspenders).
3. Hard-refresh production → **Import snapshot** should appear (probe passes).

## Ops notes

- **Disk:** ~3–4 GiB free under `/var/www` (plus room to grow as the chain grows).
- **Bandwidth:** each browser import pulls the full file once; consider rate limits
  later if the VPS pipe is small (`limit_rate` in nginx).
- **Refresh cadence:** re-publish after major tip growth (e.g. weekly) so catch-up stays short.
- **RPC 502:** if `/chain/head` is 502, the node/RPC is down — unrelated to static
  `/snapshot/` once the location is wired to `alias`, not `proxy_pass`.
