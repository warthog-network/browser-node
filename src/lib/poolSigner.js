/**
 * Open roster: each website tab-origin / extension instance gets a unique
 * signerId and auto-enrolls as the next unused Shamir slot.
 * Payout policy is n-of-n among signers seen in the last ~2 minutes.
 *
 * Share material is a RAM lease only. Come online → HTTPS enroll.
 * Close the tab / miss heartbeats → coordinator reshares, old hex is dead.
 * signerId stays in storage so you get the same slot back; shareHex does not.
 */
export const DEFAULT_POOL_API = 'https://cartesi-bridge.duckdns.org/api/pool';

const ENABLED_KEY = 'wart.poolSigner.enabled';
const STATS_KEY = 'wart.poolSigner.stats';
const ID_KEY = 'wart.poolSigner.signerId';
const SHARE_KEY = 'wart.poolSigner.enrolledShare';

/** In-memory only. Never write shareHex back to storage. */
let liveShare = null;

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
    epoch: j.epoch == null ? null : Number(j.epoch),
    leaseMs: Number(j.leaseMs || 120000),
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

async function storageRemove(key) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove(key);
    }
  } catch {
    /* */
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* */
  }
}

function isEpochDead(err) {
  const msg = err?.message || String(err || '');
  return /EPOCH_ROTATED|share is dead|share material|does not match/i.test(msg);
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
  liveShare = share;
  await storageSet(ID_KEY, share.signerId);
  await storageRemove(SHARE_KEY);
  return share;
}

export async function loadActiveShare(api = DEFAULT_POOL_API) {
  await storageRemove(SHARE_KEY);
  const signerId = await getOrCreateSignerId();
  return enrollSigner(signerId, api);
}

export function peekLiveShare() {
  return liveShare;
}

export function dropLiveShare() {
  liveShare = null;
}

export async function heartbeat(share, api = DEFAULT_POOL_API) {
  const r = await withRetry(() =>
    poolPost(api, {
      action: 'threshold_heartbeat',
      signerId: share.signerId,
      shareIndex: share.shareIndex,
      epoch: share.epoch,
    }),
  );
  if (
    r.rotated ||
    (r.epoch != null && share.epoch != null && Number(r.epoch) !== Number(share.epoch))
  ) {
    liveShare = null;
    const err = new Error(
      'EPOCH_ROTATED: share is dead — re-enroll over HTTPS for a fresh lease',
    );
    err.code = 'EPOCH_ROTATED';
    throw err;
  }
  return r;
}

export async function contributeOpen(share, api = DEFAULT_POOL_API) {
  const st = await fetchThresholdStatus(api);
  const open = (st.open || []).filter(
    (r) => r.status === 'open' || r.status === 'failed',
  );
  // Lab-demo tickets have no burn notice — they are not redeem attempts.
  const actionable = open.filter(
    (r) => !r.labDemo && !/^lab-demo-/.test(String(r.ticketId || '')),
  );
  const results = [];
  let lastVerify = null;
  const { verifyOpenRequest, probeMachineHealth } = await import('./poolVerify.js');
  if (actionable.length === 0) {
    try {
      lastVerify = await probeMachineHealth();
    } catch (e) {
      lastVerify = { ok: false, checks: {}, reasons: [e?.message || String(e)] };
    }
    return {
      status: st,
      results,
      openCount: 0,
      ignoredOpen: open.length,
      lastVerify,
    };
  }
  for (const req of actionable) {
    let verify;
    try {
      verify = await verifyOpenRequest({
        ticketId: req.ticketId,
        toAddress: req.toAddress,
        amountE8: req.amountE8,
        poolAddress: st.signers?.poolAddress || share.poolAddress,
        labDemo: Boolean(req.labDemo),
      });
      lastVerify = verify;
    } catch (e) {
      results.push({
        ticketId: req.ticketId,
        skipped: true,
        error: e?.message || String(e),
      });
      lastVerify = { ok: false, checks: {}, reasons: [e?.message || String(e)] };
      continue;
    }
    if (!verify.ok) {
      results.push({
        ticketId: req.ticketId,
        skipped: true,
        error: (verify.reasons || []).join('; ') || 'verification failed',
        verify,
      });
      continue;
    }
    try {
      const r = await withRetry(() =>
        poolPost(api, {
          action: 'threshold_contribute',
          ticketId: req.ticketId,
          shareIndex: share.shareIndex,
          shareHex: share.shareHex,
          signerId: share.signerId,
          verification: verify.attestation,
        }),
      );
      results.push({ ticketId: req.ticketId, ...r, verify });
    } catch (e) {
      if (isEpochDead(e)) {
        liveShare = null;
      }
      throw e;
    }
  }
  return { status: st, results, openCount: actionable.length, lastVerify };
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
