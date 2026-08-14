/**
 * Browser / extension pool signer for 3P core + orbit.
 *
 * Enroll: unique signerId joins the orbit (n-of-n among live heartbeats).
 * Vacant d1/d2 seats are leased in RAM. Idle > lease → seat refresh (old hex dies).
 * Full d is never on this device.
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
  const signerId = String(j.signerId || '').trim();
  const scheme = String(j.scheme || '');
  if (j.waitlist || Number(j.role) === 0) {
    return {
      scheme: scheme || 'wart-3p-ecdsa-lindell-v1',
      role: 0,
      waitlist: true,
      signerId,
      poolAddress: j.poolAddress || null,
      message: j.message || '3P roster full',
      source: j.source || 'enrolled',
    };
  }
  if (scheme.includes('3p-ecdsa') || Number(j.role) === 1 || Number(j.role) === 2) {
    const shareHex = String(j.userShareHex || j.shareHex || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const role = Number(j.role || j.shareIndex || 0);
    if (!/^[0-9a-f]{64}$/.test(shareHex) || (role !== 1 && role !== 2) || !signerId) {
      return null;
    }
    return {
      scheme: scheme || 'wart-3p-ecdsa-lindell-v1',
      role,
      shareIndex: role,
      shareHex,
      userShareHex: shareHex,
      signerId,
      poolAddress: j.poolAddress || null,
      publicKey: j.publicKey || null,
      paillierLambda: j.paillierLambda || null,
      paillierMu: j.paillierMu || null,
      paillierN: j.paillierN || null,
      paillierG: j.paillierG || null,
      source: j.source || 'enrolled',
      waitlist: false,
      message: j.message || null,
      seatEpoch: j.seatEpoch == null ? null : Number(j.seatEpoch),
      leaseMs: Number(j.leaseMs || 120000),
      orbit: j.orbit || null,
      seal: j.seal || null,
    };
  }
  const shareHex = String(j.shareHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const shareIndex = Number(j.shareIndex);
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

export async function fetchPool3pStatus(api = DEFAULT_POOL_API) {
  return withRetry(() =>
    poolPost(api, { action: 'pool3p_status' }),
  );
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
  if (!share.waitlist && r.seal && (share.role === 1 || share.role === 2)) {
    const { verifyShareSeal } = await import('./pool3pClient.js');
    verifyShareSeal({
      shareHex: share.userShareHex || share.shareHex,
      role: share.role,
      seal: r.seal,
    });
    share.seal = r.seal;
    share.sealOk = true;
  }
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

async function applyIncomingShare(raw, prev) {
  if (!raw || raw.waitlist || (Number(raw.role) !== 1 && Number(raw.role) !== 2)) {
    return null;
  }
  const share = normalizeShare({ ...raw, source: raw.source || 'heartbeat' });
  if (!share || share.waitlist) return null;
  if (raw.seal && (share.role === 1 || share.role === 2)) {
    try {
      const { verifyShareSeal } = await import('./pool3pClient.js');
      verifyShareSeal({
        shareHex: share.userShareHex || share.shareHex,
        role: share.role,
        seal: raw.seal,
      });
      share.seal = raw.seal;
      share.sealOk = true;
    } catch {
      share.seal = raw.seal;
      share.sealOk = false;
    }
  }
  // Squash previous hex in RAM — do not keep old d1/d2 after an epoch.
  liveShare = share;
  if (prev?.signerId) await storageSet(ID_KEY, prev.signerId);
  return share;
}

export async function heartbeat(share, api = DEFAULT_POOL_API) {
  if (share?.scheme?.includes('3p-ecdsa') || share?.waitlist) {
    const r = await withRetry(() =>
      poolPost(api, {
        action: 'pool3p_heartbeat',
        signerId: share.signerId,
        seatEpoch: share.seatEpoch,
      }),
    );
    let next = share;
    if (r.share) {
      const applied = await applyIncomingShare(r.share, share);
      if (applied) next = applied;
    } else if ((share.role === 1 || share.role === 2) && Number(r.role || 0) === 0) {
      next = {
        scheme: share.scheme || 'wart-3p-ecdsa-lindell-v1',
        role: 0,
        waitlist: true,
        signerId: share.signerId,
        poolAddress: share.poolAddress || null,
        message: 'Seat released — orbit voter until a seat is free',
        source: 'demoted',
      };
      liveShare = next;
    }
    return { ...r, share: next };
  }
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

const k1ByTicket = new Map();

async function sign3pAsRole1(share, req, api) {
  const { clientSignRound1, clientSignFinish } = await import('./pool3pClient.js');
  let k1 = k1ByTicket.get(req.ticketId);
  if (!k1) {
    const prep = await poolPost(api, {
      action: 'pool3p_prepare',
      ticketId: req.ticketId,
      toAddress: req.toAddress,
      amountE8: req.amountE8,
    });
    const rnd = clientSignRound1();
    k1 = { ...rnd, hashHex: prep.hashHex };
    k1ByTicket.set(req.ticketId, k1);
    await poolPost(api, {
      action: 'pool3p_r1',
      ticketId: req.ticketId,
      signerId: share.signerId,
      R1Hex: rnd.R1Hex,
      hashHex: prep.hashHex,
      amountE8: req.amountE8,
      toAddress: req.toAddress,
    });
  }
  const st = await poolPost(api, { action: 'pool3p_ticket', ticketId: req.ticketId });
  if (!st.hasPartial) {
    return { ok: true, waiting: true, status: st.status, ticketId: req.ticketId };
  }
  const fin = clientSignFinish({
    k1Hex: k1.k1Hex,
    rHex: st.rHex,
    ciphertext: st.ciphertext,
    hashHex: k1.hashHex,
    clientSecret: share,
  });
  const paid = await poolPost(api, {
    action: 'pool3p_submit',
    ticketId: req.ticketId,
    signature65: fin.signature65,
    hashHex: k1.hashHex,
  });
  k1ByTicket.delete(req.ticketId);
  return paid;
}

export async function contributeOpen(share, api = DEFAULT_POOL_API) {
  const st = await fetchThresholdStatus(api);
  const p3 = await fetchPool3pStatus(api).catch(() => null);
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
      pool3p: p3,
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
        poolAddress: share.poolAddress || p3?.address || st.signers?.poolAddress,
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
      let r;
      if (share.scheme?.includes('3p-ecdsa') || share.waitlist) {
        await poolPost(api, {
          action: 'pool3p_orbit_attest',
          signerId: share.signerId,
          ticketId: req.ticketId,
        }).catch(() => null);
      }
      const role = Number(share.role || 0);
      if (share.waitlist || role === 0) {
        r = { ok: true, orbitOnly: true, ticketId: req.ticketId };
      } else if (share.scheme?.includes('3p-ecdsa') && role === 2) {
        const d2 = await poolPost(api, {
          action: 'pool3p_d2',
          ticketId: req.ticketId,
          signerId: share.signerId,
          d2Hex: share.userShareHex || share.shareHex,
        });
        r = d2.skipped
          ? { ok: true, orbitOnly: true, ticketId: req.ticketId, note: d2.error }
          : d2;
      } else if (share.scheme?.includes('3p-ecdsa') && role === 1) {
        r = await sign3pAsRole1(share, req, api);
      } else {
        r = await withRetry(() =>
          poolPost(api, {
            action: 'threshold_contribute',
            ticketId: req.ticketId,
            shareIndex: share.shareIndex,
            shareHex: share.shareHex,
            signerId: share.signerId,
            verification: verify.attestation,
          }),
        );
      }
      results.push({ ticketId: req.ticketId, ...r, verify });
    } catch (e) {
      const msg = e?.message || String(e);
      if (/must come from the current d[12] holder|no d[12] holder/i.test(msg)) {
        results.push({
          ticketId: req.ticketId,
          ok: true,
          orbitOnly: true,
          error: msg,
        });
        continue;
      }
      if (isEpochDead(e) || e?.code === 'SEAT_ROTATED') {
        liveShare = null;
      }
      throw e;
    }
  }
  return { status: st, pool3p: p3, results, openCount: actionable.length, lastVerify };
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
