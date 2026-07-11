/**
 * Public / community chain.db3 snapshot for one-click OPFS import.
 *
 * Default is same-origin `/snapshot/chain.db3` (served from public/snapshot/).
 * That avoids COEP CORP issues. Override with:
 *   - ?snapshot=https://…/chain.db3
 *   - import.meta.env.PUBLIC_SNAPSHOT_URL
 *   - manifest.json `url` (absolute CDN/VPS later)
 *
 * Multi‑GB files must NOT go through /api/proxy.
 * Netlify deploys only `manifest.json` — `chain.db3` is gitignored. Production
 * one-click import needs an external host (or local `npm run snapshot:link`).
 */

import { formatBytes } from './opfsSnapshot.js';

/** Same-origin path when the file is present under public/snapshot/. */
export const DEFAULT_PUBLIC_SNAPSHOT_URL = '/snapshot/chain.db3';

/** Small JSON next to the DB (always ship this; the .db3 may be gitignored). */
export const PUBLIC_SNAPSHOT_MANIFEST_URL = '/snapshot/manifest.json';

/**
 * Resolve the URL used for one-click public import.
 * Query `?snapshot=` wins, then env, then default same-origin path.
 */
export function resolvePublicSnapshotUrl(
  loc = typeof window !== 'undefined' ? window.location : null,
) {
  try {
    if (loc?.search) {
      const q = new URLSearchParams(loc.search).get('snapshot')?.trim();
      if (q && (/^https?:\/\//i.test(q) || q.startsWith('/'))) {
        return q;
      }
    }
  } catch {
    // ignore
  }
  // Vite/Astro static-replace import.meta.env.PUBLIC_* (no optional chaining).
  const envUrl = import.meta.env.PUBLIC_SNAPSHOT_URL;
  if (envUrl && String(envUrl).trim()) return String(envUrl).trim();
  return DEFAULT_PUBLIC_SNAPSHOT_URL;
}

/**
 * Fetch manifest (best-effort). Returns null if missing/unreachable.
 * @returns {Promise<null | {
 *   name?: string,
 *   url?: string,
 *   bytes?: number,
 *   height?: number,
 *   journalMode?: string,
 *   network?: string,
 *   preparedAt?: string,
 *   publishedAt?: string,
 *   note?: string,
 * }>}
 */
export async function fetchPublicSnapshotManifest(url = PUBLIC_SNAPSHOT_MANIFEST_URL) {
  try {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Probe whether a snapshot URL is actually downloadable (production often
 * ships manifest.json without the multi‑GB chain.db3).
 *
 * Uses HEAD first; falls back to a 1-byte Range GET when HEAD is blocked.
 * Under COEP, cross-origin hosts need Cross-Origin-Resource-Policy.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status?: number, bytes?: number|null, error?: string }>}
 */
export async function probePublicSnapshotUrl(url) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, error: 'Empty snapshot URL' };

  const opts = { method: 'HEAD', credentials: 'omit', mode: 'cors', cache: 'no-cache' };
  try {
    let res = await fetch(u, opts);
    // Some static hosts reject HEAD (405/501) on large files.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(u, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-cache',
      });
    }
    if (!res.ok && res.status !== 206) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const len = res.headers.get('content-length') || res.headers.get('content-range')?.split('/')?.[1];
    const bytes = len != null && len !== '' && !Number.isNaN(Number(len)) ? Number(len) : null;
    // Drain/cancel body if we used GET (Range may still stream a tiny body).
    try {
      await res.body?.cancel?.();
    } catch {
      // ignore
    }
    return { ok: true, status: res.status, bytes };
  } catch (e) {
    return {
      ok: false,
      error:
        e?.message
        || String(e)
        || 'Fetch failed (COEP/CORP or network). Cross-origin hosts need CORP.',
    };
  }
}

/**
 * Load catalog + confirm the .db3 is reachable. Null if unavailable
 * (typical Netlify: manifest present, multi‑GB file not deployed).
 *
 * @returns {Promise<null | object>}
 */
export async function loadAvailablePublicSnapshot() {
  const man = await fetchPublicSnapshotManifest();
  const url = String(
    man?.url
    || resolvePublicSnapshotUrl()
    || DEFAULT_PUBLIC_SNAPSHOT_URL,
  ).trim();
  if (!url) return null;

  const probe = await probePublicSnapshotUrl(url);
  if (!probe.ok) return null;

  return {
    ...(man && typeof man === 'object' ? man : {}),
    url,
    bytes: probe.bytes ?? man?.bytes ?? undefined,
    available: true,
  };
}

/** Human label for buttons / logs. */
export function publicSnapshotLabel(manifest) {
  const parts = ['public snapshot'];
  if (manifest?.height != null) parts.push(`height ${Number(manifest.height).toLocaleString()}`);
  if (manifest?.bytes != null) parts.push(formatBytes(manifest.bytes));
  return parts.join(' · ');
}

/**
 * Log tip when same-origin /snapshot/chain.db3 404s.
 * Dev: link local file. Production: host externally + PUBLIC_SNAPSHOT_URL.
 */
export function snapshotMissingTip(url) {
  const u = String(url || '');
  const isSameOriginPath = u.startsWith('/snapshot/');
  if (!isSameOriginPath) {
    return (
      '[snapshot] tip: host unreachable or blocked by COEP. '
      + 'Serve with Cross-Origin-Resource-Policy: cross-origin (or same-origin), '
      + 'or use Choose file… for a local chain.db3.'
    );
  }
  try {
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (isLocal) {
      return (
        '[snapshot] tip: same-origin file missing? Run `npm run snapshot:link` '
        + '(links ~/Downloads/chain.db3 into public/snapshot/) and restart dev.'
      );
    }
  } catch {
    // fall through
  }
  return (
    '[snapshot] tip: production does not ship multi‑GB chain.db3 (gitignored). '
    + 'Host it on a CDN/VPS with CORP, set PUBLIC_SNAPSHOT_URL or manifest.url, '
    + 'or use Choose file… with a local checkpointed chain.db3.'
  );
}
