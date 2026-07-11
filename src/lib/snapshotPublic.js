/**
 * Public / community chain.db3 snapshot for one-click OPFS import.
 *
 * Default is same-origin `/snapshot/chain.db3` (served from public/snapshot/).
 * That avoids COEP CORP issues. Override with:
 *   - ?snapshot=https://…/chain.db3
 *   - import.meta.env.PUBLIC_SNAPSHOT_URL
 *
 * Multi‑GB files must NOT go through /api/proxy.
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
  try {
    const envUrl = import.meta.env?.PUBLIC_SNAPSHOT_URL;
    if (envUrl && String(envUrl).trim()) return String(envUrl).trim();
  } catch {
    // ignore
  }
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

/** Human label for buttons / logs. */
export function publicSnapshotLabel(manifest) {
  const parts = ['public snapshot'];
  if (manifest?.height != null) parts.push(`height ${Number(manifest.height).toLocaleString()}`);
  if (manifest?.bytes != null) parts.push(formatBytes(manifest.bytes));
  return parts.join(' · ');
}
