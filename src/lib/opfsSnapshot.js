/**
 * OPFS chain snapshot import for faster first sync.
 *
 * Browser node stores DBs at OPFS root as:
 *   chain.db3 · peers_v2.db3 · rxtx.db3
 * (Emscripten WASMFS mount point /opfs/)
 *
 * Importing a recent chain.db3 from a trusted native full node skips
 * most of genesis→tip IBD; the WASM node only catches up remaining blocks.
 *
 * ## Size / OPFS offsets (current public/node triad — emsdk 3.1.74)
 *
 * WasmFS OPFS read/write use **i64** file positions (`bigintToI53Checked`).
 * Multi‑GiB chain.db3 imports (e.g. 3.25 GiB tip) are supported. Older
 * emsdk 3.1.60 builds used i32 `pos` and failed past 2 GiB — see
 * `public/node/backup-v0.9.6-emsdk3160/`.
 *
 * Soft cap below is only a sanity guard (not a toolchain hard limit).
 *
 * ## Preparing a native snapshot
 *
 *   1. Stop wart-node completely.
 *   2. Checkpoint + single-file journal:
 *        sqlite3 ~/.warthog/chain.db3 \
 *          "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;"
 *   3. Confirm no leftover sidecars (only chain.db3 — not -wal / -shm).
 *   4. Import that single file via the UI file picker.
 */

import { hasOpfs, listOpfsEntries, terminateWasmWorkers } from './wasmNode.js';

export const CHAIN_DB_NAME = 'chain.db3';
export const PEERS_DB_NAME = 'peers_v2.db3';
export const RXTX_DB_NAME = 'rxtx.db3';

/**
 * Soft upper bound for snapshot import (sanity / browser quota).
 * Toolchain (emsdk 3.1.74) uses i64 OPFS offsets — not limited to 2 GiB.
 * JS Number stays exact for integers up to 2^53; this cap is well below that.
 */
export const OPFS_MAX_SAFE_DB_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB

/** Sidecars / junk that break OPFS SQLite if left behind. */
const CHAIN_SIDE_NAMES = [
  'chain.db3-wal',
  'chain.db3-shm',
  'chain.db3-journal',
];

/** Format bytes for logs / UI. */
export function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  if (x < 1024 * 1024 * 1024) return `${(x / (1024 * 1024)).toFixed(1)} MB`;
  return `${(x / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** True when native/WASM SQLite reports disk I/O / bad snapshot import. */
export function isSqliteDiskIoError(err) {
  const msg = String(err?.message || err || '');
  return /disk I\/O error|SQLITE_IOERR|database disk image is malformed|file is not a database|SQLITE_CORRUPT|not a database/i.test(msg);
}

/**
 * Inspect a SQLite database header (first ≥20 bytes).
 * Write/read format at offsets 18–19: 1 = legacy/DELETE journal, 2 = WAL.
 * Browser OPFS cannot use a lone WAL-mode main file without -wal/-shm, and
 * even a fully checkpointed WAL header still fails — need journal_mode=DELETE.
 *
 * @param {Blob|File|ArrayBuffer|Uint8Array} source
 * @returns {Promise<
 *   | { ok: true, walMode: boolean }
 *   | { ok: false, error: string }
 * >}
 */
export async function inspectSqliteHeader(source) {
  let head;
  try {
    if (source instanceof Uint8Array) {
      head = source.length >= 20 ? source.subarray(0, 20) : source;
    } else if (source instanceof ArrayBuffer) {
      head = new Uint8Array(source.byteLength >= 20 ? source.slice(0, 20) : source);
    } else if (source && typeof source.slice === 'function') {
      head = new Uint8Array(await source.slice(0, 20).arrayBuffer());
    } else {
      return { ok: false, error: 'Could not read SQLite header' };
    }
  } catch (e) {
    return { ok: false, error: `Could not read file header: ${e?.message || e}` };
  }

  if (head.length < 16) {
    return { ok: false, error: 'File too small for a SQLite header' };
  }

  const magic = 'SQLite format 3\0';
  for (let i = 0; i < 16; i++) {
    if (head[i] !== magic.charCodeAt(i)) {
      return {
        ok: false,
        error:
          'Selected file is not a SQLite database (missing “SQLite format 3” header). '
          + 'Pick the main chain.db3 only — not -wal/-shm, not a zip, not a partial copy.',
      };
    }
  }

  if (head.length < 20) {
    return { ok: true, walMode: false };
  }

  // SQLite file format: write version @18, read version @19 (1=legacy, 2=WAL)
  const writeVer = head[18];
  const readVer = head[19];
  const walMode = writeVer === 2 || readVer === 2;
  return { ok: true, walMode, writeVer, readVer };
}

/**
 * Read OPFS chain.db3 header + size; fail closed on WAL mode or bad magic.
 * @returns {{ ok: true, bytes: number } | { ok: false, error: string, bytes?: number }}
 */
async function opfsWorkDir(subdir) {
  const root = await navigator.storage.getDirectory();
  if (!subdir) return root;
  return root.getDirectoryHandle(subdir, { create: true });
}

export async function verifyOpfsChainDb({ subdir } = {}) {
  if (!hasOpfs()) {
    return { ok: false, error: 'OPFS not available' };
  }
  try {
    const root = await navigator.storage.getDirectory();
    const dir = subdir
      ? await root.getDirectoryHandle(subdir)
      : root;
    const handle = await dir.getFileHandle(CHAIN_DB_NAME);
    const file = await handle.getFile();
    if (file.size < 100) {
      return { ok: false, error: `chain.db3 too small (${formatBytes(file.size)})`, bytes: file.size };
    }
    const inspected = await inspectSqliteHeader(file);
    if (!inspected.ok) {
      return { ok: false, error: inspected.error, bytes: file.size };
    }
    if (inspected.walMode) {
      return {
        ok: false,
        error:
          `OPFS ${CHAIN_DB_NAME} is still in SQLite WAL mode (header write/read version 2). `
          + 'On the native host stop the node, then: '
          + 'sqlite3 chain.db3 "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" '
          + '— import only that single file (no -wal/-shm).',
        bytes: file.size,
      };
    }
    return { ok: true, bytes: file.size };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function removeOpfsNames(root, names, log) {
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
      log?.(`[snapshot] removed OPFS ${name}`);
    } catch {
      // missing is fine
    }
  }
}

/**
 * Write a Blob/File into OPFS as `chain.db3` (streaming with progress).
 * Terminates WASM workers first so exclusive handles release.
 */
export async function importChainDbBlob(blob, {
  log,
  onProgress,
  clearPeerDbs = true,
  subdir = null,
} = {}) {
  if (!hasOpfs()) {
    return { ok: false, error: 'OPFS not available (need Chromium + secure context)' };
  }
  if (!blob || typeof blob.size !== 'number') {
    return { ok: false, error: 'No snapshot file provided' };
  }
  if (blob.size < 1024) {
    return { ok: false, error: `File too small (${formatBytes(blob.size)}) — not a chain.db3` };
  }

  if (blob.size >= OPFS_MAX_SAFE_DB_BYTES) {
    return {
      ok: false,
      error:
        `Refusing import: ${formatBytes(blob.size)} exceeds the ${formatBytes(OPFS_MAX_SAFE_DB_BYTES)} `
        + 'soft cap (browser storage / practicality). Split or use a smaller snapshot.',
    };
  }

  // Header + WAL-mode check before burning multi‑GB write time.
  const inspected = await inspectSqliteHeader(blob);
  if (!inspected.ok) {
    return { ok: false, error: inspected.error };
  }
  if (inspected.walMode) {
    return {
      ok: false,
      error:
        'Refusing import: chain.db3 is still in SQLite WAL mode. '
        + 'Stop the native node completely, then run: '
        + 'sqlite3 chain.db3 "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" '
        + 'Confirm no chain.db3-wal / -shm remain, then re-import that single file.',
    };
  }

  if (blob.name && /(-wal|-shm|-journal)$/i.test(blob.name)) {
    return {
      ok: false,
      error:
        `Refusing ${blob.name}. Import only the main chain.db3 after WAL checkpoint `
        + '(see snapshot prep steps).',
    };
  }

  log?.(`[snapshot] terminating workers before OPFS write…`);
  terminateWasmWorkers(log);
  await new Promise((r) => setTimeout(r, 500));

  const root = await opfsWorkDir(subdir);
  const total = blob.size;
  log?.(`[snapshot] writing ${subdir ? `${subdir}/` : ''}${CHAIN_DB_NAME} (${formatBytes(total)})…`);
  log?.(
    '[snapshot] tip: native DB must be stopped + wal_checkpoint(TRUNCATE) + journal_mode=DELETE '
    + 'or SQLite will throw disk I/O error in the browser',
  );

  // Remove old chain + WAL sidecars so we don't mix journal modes
  await removeOpfsNames(root, [CHAIN_DB_NAME, ...CHAIN_SIDE_NAMES], log);
  if (clearPeerDbs) {
    await removeOpfsNames(
      root,
      [PEERS_DB_NAME, RXTX_DB_NAME, 'testnet3_chain.db3', 'testnet_peers.db3', 'testnet_rxtx.db3'],
      log,
    );
  }

  const handle = await root.getFileHandle(CHAIN_DB_NAME, { create: true });
  // keepExistingData:false truncates — required so a shorter re-import cannot leave a longer corrupt tail
  const writable = await handle.createWritable({ keepExistingData: false });

  let written = 0;
  try {
    if (typeof blob.stream === 'function' && typeof writable.write === 'function') {
      const reader = blob.stream().getReader();
      let lastPct = -1;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        written += value.byteLength || value.length || 0;
        const pct = total > 0 ? Math.floor((written / total) * 100) : 0;
        if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
          lastPct = pct;
          onProgress?.({ written, total, pct });
          log?.(`[snapshot] ${pct}% · ${formatBytes(written)} / ${formatBytes(total)}`);
        }
      }
    } else {
      await writable.write(blob);
      written = total;
      onProgress?.({ written: total, total, pct: 100 });
    }
    await writable.close();
  } catch (e) {
    try {
      await writable.abort?.();
    } catch {
      // ignore
    }
    return { ok: false, error: e?.message || String(e) };
  }

  if (written !== total) {
    return {
      ok: false,
      error:
        `Write size mismatch: wrote ${formatBytes(written)} of ${formatBytes(total)}. `
        + 'Delete local data and re-import.',
    };
  }

  const verify = await verifyOpfsChainDb({ subdir });
  if (!verify.ok) {
    return { ok: false, error: verify.error || 'Post-write verify failed' };
  }
  if (verify.bytes !== total) {
    return {
      ok: false,
      error:
        `OPFS size ${formatBytes(verify.bytes)} ≠ source ${formatBytes(total)}. `
        + 'Truncated write — free disk, clear site data, re-import.',
    };
  }

  const entries = await listOpfsEntries(subdir);
  log?.(
    `[snapshot] verified SQLite header · ${formatBytes(verify.bytes)}`
    + ` · journal header ${inspected.walMode ? 'WAL (bad for browser)' : 'DELETE (ok)'}`,
  );
  log?.(`[snapshot] done — OPFS: ${entries.join(', ') || '(empty?)'}`);
  log?.(
    '[snapshot] note: header/size check ≠ full WASM open. Close other tabs on this origin, then Start once.',
  );
  return { ok: true, bytes: total, entries, verified: true, walMode: inspected.walMode };
}

/**
 * Download a snapshot URL into OPFS as chain.db3.
 * URL must be fetchable under COEP (same-origin, or CORP/CORS headers).
 * Do NOT route multi‑GB files through Netlify /api/proxy.
 */
export async function importChainDbFromUrl(url, { log, onProgress, clearPeerDbs = true, subdir = null } = {}) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, error: 'Empty snapshot URL' };

  log?.(`[snapshot] fetching ${u}…`);
  let res;
  try {
    res = await fetch(u, { credentials: 'omit', mode: 'cors' });
  } catch (e) {
    return {
      ok: false,
      error:
        `Fetch failed: ${e?.message || e}. Under COEP, the host must send `
        + 'Cross-Origin-Resource-Policy (or host the file same-origin).',
    };
  }
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
  }

  const total = Number(res.headers.get('content-length')) || 0;
  if (total >= OPFS_MAX_SAFE_DB_BYTES) {
    return {
      ok: false,
      error:
        `Refusing URL import: Content-Length ${formatBytes(total)} exceeds the `
        + `${formatBytes(OPFS_MAX_SAFE_DB_BYTES)} soft cap.`,
    };
  }
  if (!res.body) {
    const blob = await res.blob();
    return importChainDbBlob(blob, { log, onProgress, clearPeerDbs, subdir });
  }

  // Stream response → Blob via chunks (createWritable needs a Blob or we pipe differently)
  // For progress, accumulate is bad for 1GB+; write directly to OPFS instead.
  log?.(`[snapshot] streaming into OPFS${total ? ` (${formatBytes(total)})` : ''}…`);
  terminateWasmWorkers(log);
  await new Promise((r) => setTimeout(r, 500));

  if (!hasOpfs()) {
    return { ok: false, error: 'OPFS not available' };
  }

  const root = await opfsWorkDir(subdir);
  try {
    await root.removeEntry(CHAIN_DB_NAME);
  } catch {
    // ignore
  }
  if (clearPeerDbs) {
    for (const name of [PEERS_DB_NAME, RXTX_DB_NAME]) {
      try {
        await root.removeEntry(name);
      } catch {
        // ignore
      }
    }
  }

  await removeOpfsNames(root, [CHAIN_DB_NAME, ...CHAIN_SIDE_NAMES], log);

  const handle = await root.getFileHandle(CHAIN_DB_NAME, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  const reader = res.body.getReader();
  let written = 0;
  let lastPct = -1;
  /** @type {Uint8Array|null} */
  let headerBuf = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Abort multi‑GB downloads as soon as WAL / non-SQLite is obvious.
      if (!headerBuf || headerBuf.length < 20) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (!headerBuf) {
          headerBuf = chunk.length >= 20 ? chunk.subarray(0, 20) : chunk.slice();
        } else {
          const need = 20 - headerBuf.length;
          const next = new Uint8Array(headerBuf.length + Math.min(need, chunk.length));
          next.set(headerBuf);
          next.set(chunk.subarray(0, Math.min(need, chunk.length)), headerBuf.length);
          headerBuf = next;
        }
        if (headerBuf.length >= 20) {
          const inspected = await inspectSqliteHeader(headerBuf);
          if (!inspected.ok || inspected.walMode) {
            try {
              await writable.abort?.();
            } catch {
              // ignore
            }
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            await removeOpfsNames(root, [CHAIN_DB_NAME, ...CHAIN_SIDE_NAMES], log);
            return {
              ok: false,
              error: inspected.ok
                ? 'Refusing import: remote chain.db3 is still in SQLite WAL mode. '
                  + 'Checkpoint + journal_mode=DELETE on the host before serving the file.'
                : inspected.error,
            };
          }
        }
      }

      await writable.write(value);
      written += value.byteLength;
      if (written >= OPFS_MAX_SAFE_DB_BYTES) {
        try {
          await writable.abort?.();
        } catch {
          // ignore
        }
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        await removeOpfsNames(root, [CHAIN_DB_NAME, ...CHAIN_SIDE_NAMES], log);
        return {
          ok: false,
          error:
            `Download reached ${formatBytes(written)} (over soft cap `
            + `${formatBytes(OPFS_MAX_SAFE_DB_BYTES)}). Aborted.`,
        };
      }
      if (total > 0) {
        const pct = Math.floor((written / total) * 100);
        if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
          lastPct = pct;
          onProgress?.({ written, total, pct });
          log?.(`[snapshot] ${pct}% · ${formatBytes(written)} / ${formatBytes(total)}`);
        }
      } else if (written % (32 * 1024 * 1024) < value.byteLength) {
        log?.(`[snapshot] ${formatBytes(written)} written…`);
        onProgress?.({ written, total: 0, pct: 0 });
      }
    }
    await writable.close();
  } catch (e) {
    try {
      await writable.abort?.();
    } catch {
      // ignore
    }
    return { ok: false, error: e?.message || String(e) };
  }

  if (total > 0 && written !== total) {
    return {
      ok: false,
      error: `Download size mismatch: got ${formatBytes(written)}, Content-Length ${formatBytes(total)}`,
    };
  }

  const verify = await verifyOpfsChainDb({ subdir });
  if (!verify.ok) {
    return { ok: false, error: verify.error || 'Post-write verify failed' };
  }

  const entries = await listOpfsEntries(subdir);
  log?.(`[snapshot] verified · ${formatBytes(written)}`);
  return { ok: true, bytes: written, entries, verified: true };
}

/** Best-effort size of chain.db3 already in OPFS (optional network subdir). */
export async function getLocalChainDbInfo({ subdir } = {}) {
  if (!hasOpfs()) return { present: false };
  try {
    const root = await navigator.storage.getDirectory();
    const dir = subdir
      ? await root.getDirectoryHandle(subdir)
      : root;
    const handle = await dir.getFileHandle(CHAIN_DB_NAME);
    const file = await handle.getFile();
    const name = subdir ? `${subdir}/${CHAIN_DB_NAME}` : CHAIN_DB_NAME;
    return { present: true, bytes: file.size, name };
  } catch {
    return { present: false };
  }
}
