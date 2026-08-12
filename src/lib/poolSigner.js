/**
 * Path A3 — unique pool-threshold signer for the browser-node extension.
 *
 * Each device must hold a *different* issued share. Same JSON on phone +
 * desktop is still one signer. Import an override share for the second device.
 */
export const DEFAULT_POOL_API = 'https://cartesi-bridge.duckdns.org/api/pool';

const ENABLED_KEY = 'wart.poolSigner.enabled';
const LAST_KEY = 'wart.poolSigner.last';
const STATS_KEY = 'wart.poolSigner.stats';
const OVERRIDE_KEY = 'wart.poolSigner.overrideShare';

export function defaultPoolApi() {
  return DEFAULT_POOL_API;
}

function normalizeShare(j) {
  if (!j || typeof j !== 'object') return null;
  const shareHex = String(j.shareHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const shareIndex = Number(j.shareIndex);
  if (!/^[0-9a-f]{64}$/.test(shareHex) || !Number.isFinite(shareIndex)) {
    return null;
  }
  return {
    scheme: j.scheme || 'wart-pool-threshold-shamir-v0',
    poolAddress: j.poolAddress || null,
    threshold: Number(j.threshold || 3),
    n: Number(j.n || 8),
    shareIndex,
    shareHex,
    signerId: String(j.signerId || `home-browser-node`).trim(),
    source: j.source || 'unknown',
  };
}

export async function loadBakedShare() {
  const url =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('signer-share.json')
      : '/signer-share.json';
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return normalizeShare({ ...j, source: 'baked' });
  } catch {
    return null;
  }
}

async function storageGet(key) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const got = await chrome.storage.local.get(key);
      return got[key];
    }
  } catch {
    /* */
  }
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

async function storageSet(key, value) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
  } catch {
    /* */
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* */
  }
}

export async function loadOverrideShare() {
  const raw = await storageGet(OVERRIDE_KEY);
  if (!raw) return null;
  return normalizeShare({ ...raw, source: 'imported' });
}

export async function saveOverrideShare(obj) {
  const share = normalizeShare({ ...obj, source: 'imported' });
  if (!share) throw new Error('Not a valid signer-share JSON');
  await storageSet(OVERRIDE_KEY, share);
  return share;
}

export async function clearOverrideShare() {
  await storageSet(OVERRIDE_KEY, null);
}

export async function loadActiveShare() {
  const over = await loadOverrideShare();
  if (over) return over;
  return loadBakedShare();
}

async function poolGet(api, qs) {
  const url = `${api}${api.includes('?') ? '&' : '?'}${qs}`;
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `GET ${res.status}`);
  return body;
}

async function poolPost(api, body) {
  const res = await fetch(api, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `POST ${res.status}`);
  return j;
}

async function withRetry(fn, { tries = 3, delayMs = 400 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw last;
}

export async function fetchThresholdStatus(api = DEFAULT_POOL_API) {
  return withRetry(() => poolGet(api, 'threshold=1'));
}

export async function heartbeat(share, api = DEFAULT_POOL_API) {
  return withRetry(() =>
    poolPost(api, {
      action: 'threshold_heartbeat',
      signerId: share.signerId,
      shareIndex: share.shareIndex,
    }),
  );
}

export async function contributeOpen(share, api = DEFAULT_POOL_API) {
  const st = await fetchThresholdStatus(api);
  const open = (st.open || []).filter(
    (r) => r.status === 'open' || r.status === 'failed',
  );
  const results = [];
  for (const req of open) {
    const r = await withRetry(() =>
      poolPost(api, {
        action: 'threshold_contribute',
        ticketId: req.ticketId,
        shareIndex: share.shareIndex,
        shareHex: share.shareHex,
        signerId: share.signerId,
      }),
    );
    results.push({ ticketId: req.ticketId, ...r });
  }
  return { status: st, results, openCount: open.length };
}

export async function readEnabled() {
  const v = await storageGet(ENABLED_KEY);
  if (v === undefined || v === null) return true;
  return Boolean(v);
}

export async function writeEnabled(on) {
  await storageSet(ENABLED_KEY, Boolean(on));
}

export async function readStats() {
  const s = await storageGet(STATS_KEY);
  return {
    signedCount: Number(s?.signedCount || 0),
    lastTicket: s?.lastTicket || null,
    lastPaid: Boolean(s?.lastPaid),
    lastTx: s?.lastTx || null,
    lastAt: s?.lastAt || null,
    lastMsg: s?.lastMsg || null,
  };
}

export async function writeStats(partial) {
  const prev = await readStats();
  const next = { ...prev, ...partial };
  await storageSet(STATS_KEY, next);
  return next;
}

export async function writeLast(info) {
  await storageSet(LAST_KEY, info);
}
