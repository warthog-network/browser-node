/**
 * Open roster: each website tab-origin / extension instance gets a unique
 * signerId and auto-enrolls as the next unused Shamir slot.
 * Payout policy is n-of-n among signers seen in the last ~2 minutes.
 */
export const DEFAULT_POOL_API = 'https://cartesi-bridge.duckdns.org/api/pool';

const ENABLED_KEY = 'wart.poolSigner.enabled';
const STATS_KEY = 'wart.poolSigner.stats';
const ID_KEY = 'wart.poolSigner.signerId';
const SHARE_KEY = 'wart.poolSigner.enrolledShare';

export function defaultPoolApi() {
  return DEFAULT_POOL_API;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function normalizeShare(j) {
  if (!j || typeof j !== 'object') return null;
  const shareHex = String(j.shareHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const shareIndex = Number(j.shareIndex);
  const signerId = String(j.signerId || '').trim();
  if (!/^[0-9a-f]{64}$/.test(shareHex) || !Number.isFinite(shareIndex) || !signerId) {
    return null;
  }
  return {
    scheme: j.scheme || 'wart-pool-threshold-shamir-v0',
    poolAddress: j.poolAddress || null,
    threshold: Number(j.threshold || j.need || 3),
    n: Number(j.n || 8),
    shareIndex,
    shareHex,
    signerId,
    source: j.source || 'enrolled',
    shamirT: Number(j.shamirT || 3),
    enrolled: j.enrolled,
    active: j.active,
    need: j.need || j.threshold,
  };
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

export async function getOrCreateSignerId() {
  let id = await storageGet(ID_KEY);
  if (typeof id === 'string' && id.length >= 16) return id;
  id = `node-${uuid()}`;
  await storageSet(ID_KEY, id);
  return id;
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

export async function enrollSigner(signerId, api = DEFAULT_POOL_API) {
  const r = await withRetry(() =>
    poolPost(api, {
      action: 'threshold_enroll',
      signerId,
      role: typeof chrome !== 'undefined' && chrome.runtime?.id ? 'extension-node' : 'browser-node',
    }),
  );
  const share = normalizeShare({ ...r, source: 'enrolled' });
  if (!share) throw new Error('enroll returned no share');
  await storageSet(SHARE_KEY, share);
  await storageSet(ID_KEY, share.signerId);
  return share;
}

export async function loadActiveShare(api = DEFAULT_POOL_API) {
  const signerId = await getOrCreateSignerId();
  try {
    return await enrollSigner(signerId, api);
  } catch (e) {
    const cached = normalizeShare(await storageGet(SHARE_KEY));
    if (cached) return cached;
    throw e;
  }
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
