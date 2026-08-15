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

function compactPointHex(hex) {
  return String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Browser-safe: never use Node `Buffer` here (it is undefined in Chrome/Brave). */
async function pointOfShare(hex) {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const n = secp256k1.CURVE.n;
  const h = String(hex || '').replace(/^0x/i, '');
  const d = BigInt('0x' + h) % n;
  if (d <= 0n) return '';
  const pt = secp256k1.ProjectivePoint.BASE.multiply(d);
  if (typeof pt.toHex === 'function') return compactPointHex(pt.toHex(true));
  return bytesToHex(pt.toRawBytes(true));
}

async function findBornCacheForRole(role, expectedP) {
  const want = String(expectedP || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const match = async (c) => {
    if (!c?.userShareHex) return false;
    if (!want) return true;
    const p = await pointOfShare(c.userShareHex);
    return p.toLowerCase() === want;
  };
  const sid = await storageGet(ID_KEY);
  if (typeof sid === 'string') {
    const c = await readBornCache(sid, role);
    if (await match(c)) return c;
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('wart.poolSigner.born.') || !k.endsWith(`.${role}`)) continue;
      const c = JSON.parse(localStorage.getItem(k) || 'null');
      if (await match(c)) return c;
    }
  } catch {
    /* */
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const all = await chrome.storage.local.get(null);
      for (const [k, v] of Object.entries(all || {})) {
        if (!k.startsWith('wart.poolSigner.born.') || !v?.userShareHex) continue;
        if (Number(v.role) !== Number(role) && !k.endsWith(`.${role}`)) continue;
        if (await match(v)) return v;
      }
    }
  } catch {
    /* */
  }
  return null;
}

export async function enrollSigner(signerId, api = DEFAULT_POOL_API) {
  const r = await withRetry(() =>
    poolPost(api, {
      action: 'threshold_enroll',
      signerId,
      role: typeof chrome !== 'undefined' && chrome.runtime?.id ? 'extension-node' : 'browser-node',
    }),
  );
  let recoverErr = null;
  if (r.recoverVacant && (r.expectedP || r.vacantBorn)) {
    const role = Number(r.recoverVacant || 1);
    const P = r.expectedP || r.vacantBorn?.[String(role)]?.expectedP;
    const cached = await findBornCacheForRole(role, P);
    if (cached?.userShareHex) {
      if (cached.signerId && cached.signerId !== signerId) {
        await storageSet(ID_KEY, cached.signerId);
      }
      try {
        await poolPost(api, {
          action: 'pool3p_claim_born',
          signerId: cached.signerId || signerId,
          role,
          shareHex: cached.userShareHex,
        });
        liveShare = { ...cached, clientBorn: true, waitlist: false, role };
        return liveShare;
      } catch (e) {
        recoverErr = e;
      }
    }
    try {
      const recovered = await tryRecoverFromPack(signerId, role, api, {
        ...r,
        expectedP: P,
      });
      if (recovered?.userShareHex) {
        writeBornCache(recovered);
        liveShare = recovered;
        if (Number(role) === 1) {
          try {
            liveShare = await ensureD1Paillier(recovered, api);
          } catch {
            /* rekey on first sign */
          }
        }
        return liveShare;
      }
    } catch (e) {
      recoverErr = e;
    }
  }
  if (r.needBirth && (r.role === 1 || r.role === 2)) {
    const cached = await readBornCache(signerId, r.role);
    if (cached?.userShareHex) {
      liveShare = cached;
      return cached;
    }
    const born = await birthAndUploadSeat(signerId, r.role, api, r);
    writeBornCache(born);
    liveShare = born;
    await storageSet(ID_KEY, born.signerId);
    await storageRemove(SHARE_KEY);
    return born;
  }
  if (r.clientBorn && (r.role === 1 || r.role === 2) && !r.needBirth) {
    const cached = await readBornCache(signerId, r.role);
    if (cached?.userShareHex) {
      liveShare = {
        ...r,
        ...cached,
        userShareHex: cached.userShareHex,
        shareHex: cached.userShareHex,
        clientBorn: true,
        waitlist: false,
        role: Number(r.role),
      };
      attachPaillier(liveShare, cached);
      return liveShare;
    }
    try {
      const recovered = await tryRecoverFromPack(signerId, r.role, api, {
        ...r,
        expectedP: r.expectedP || r.seal?.[Number(r.role) === 1 ? 'P1' : 'P2'],
      });
      if (recovered?.userShareHex) {
        writeBornCache(recovered);
        liveShare = recovered;
        if (Number(r.role) === 1) {
          try {
            liveShare = await ensureD1Paillier(recovered, api);
          } catch {
            /* first sign rekeys */
          }
        }
        return liveShare;
      }
    } catch (e) {
      recoverErr = e;
    }
  }
  if (r.clientBorn && (r.role === 1 || r.role === 2) && liveShare?.role === r.role && liveShare.userShareHex) {
    liveShare = {
      ...liveShare,
      ...normalizeShare({
        ...r,
        userShareHex: liveShare.userShareHex,
        shareHex: liveShare.userShareHex,
        paillierLambda: liveShare.paillierLambda,
        paillierMu: liveShare.paillierMu,
        paillierN: liveShare.paillierN || r.paillierN,
        paillierG: liveShare.paillierG || r.paillierG,
        source: 'client-born',
      }),
      clientBorn: true,
    };
    return liveShare;
  }
  const share = normalizeShare({
    ...r,
    source: 'enrolled',
    message: recoverErr
      ? `rebuild failed: ${recoverErr.message || recoverErr}`
      : r.message,
  });
  if (!share) throw new Error('enroll returned no share');
  if (!share.waitlist && r.seal && (share.role === 1 || share.role === 2) && (share.userShareHex || share.shareHex)) {
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

async function birthAndUploadSeat(signerId, role, api, hint) {
  const { makeClientSeat } = await import('./pool3pClient.js');
  const seat = makeClientSeat(role);
  const body = {
    action: 'pool3p_birth',
    signerId,
    role,
    P: seat.P,
  };
  if (Number(role) === 1) {
    const { generateRandomKeys } = await import('paillier-bigint');
    const { publicKey: pk, privateKey: sk } = await generateRandomKeys(1024);
    const enc = pk.encrypt(
      BigInt('0x' + String(seat.userShareHex).replace(/^0x/i, '')),
    );
    body.encD1 = enc.toString();
    body.paillierN = pk.n.toString();
    body.paillierG = pk.g.toString();
    seat.paillierLambda = sk.lambda.toString();
    seat.paillierMu = sk.mu.toString();
    seat.paillierN = pk.n.toString();
    seat.paillierG = pk.g.toString();
  }
  const ack = await poolPost(api, body);
  const share = {
    scheme: 'wart-3p-ecdsa-lindell-v1',
    role: Number(role),
    shareIndex: Number(role),
    shareHex: seat.userShareHex,
    userShareHex: seat.userShareHex,
    signerId,
    poolAddress: ack.address || hint.poolAddress || null,
    publicKey: ack.publicKey || hint.publicKey || null,
    source: 'client-born',
    waitlist: false,
    clientBorn: true,
    seatEpoch: ack.seal?.seatEpoch ?? 0,
    seal: ack.seal || null,
    paillierLambda: seat.paillierLambda || null,
    paillierMu: seat.paillierMu || null,
    paillierN: seat.paillierN || null,
    paillierG: seat.paillierG || null,
    message: ack.ready
      ? `d${role} born — pool address ready`
      : `d${role} born — waiting for the other seat`,
  };
  try {
    await packNextSeat(share, api);
  } catch (e) {
    share.message = `${share.message} · pack later: ${e.message || e}`;
  }
  writeBornCache(share);
  return share;
}

function bornCacheKey(signerId, role) {
  return `wart.poolSigner.born.${signerId}.${role}`;
}

function readBornCacheSync(signerId, role) {
  try {
    const raw = sessionStorage.getItem(bornCacheKey(signerId, role));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function readBornCache(signerId, role) {
  const ss = readBornCacheSync(signerId, role);
  if (ss?.userShareHex) return ss;
  try {
    const stored = await storageGet(bornCacheKey(signerId, role));
    if (stored?.userShareHex) return stored;
  } catch {
    /* */
  }
  return ss;
}

function writeBornCache(share) {
  if (!share?.signerId || !share.userShareHex) return;
  const key = bornCacheKey(share.signerId, share.role);
  try {
    sessionStorage.setItem(key, JSON.stringify(share));
  } catch {
    /* */
  }
  void storageSet(key, share);
}

function attachPaillier(target, src) {
  if (!target || !src) return target;
  if (src.paillierLambda && !target.paillierLambda) {
    target.paillierLambda = src.paillierLambda;
    target.paillierMu = src.paillierMu;
    target.paillierN = src.paillierN || target.paillierN;
    target.paillierG = src.paillierG || target.paillierG;
  }
  return target;
}

async function tryRecoverFromPack(signerId, role, api, hint) {
  const pack = await poolPost(api, {
    action: 'pool3p_preshare_collect',
    signerId,
    role,
  });
  const need = Number(pack?.t || 2);
  if (!pack?.shares || pack.shares.length < need) {
    throw new Error(
      `orbit pack incomplete (have ${pack?.shares?.length || 0}, need ${need})`,
    );
  }
  const nextHex = shamirCombineLocal(pack.shares);
  if (!nextHex) throw new Error('orbit pack combine failed');
  const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const want = compactPointHex(hint?.expectedP || pack.P || '');
  const cands = [nextHex];
  if (pack.delta) {
    const dlt = BigInt('0x' + String(pack.delta).replace(/^0x/i, ''));
    let cur = (BigInt('0x' + nextHex) - dlt) % n;
    if (cur < 0n) cur += n;
    cands.unshift(cur.toString(16).padStart(64, '0'));
  }
  let hex = null;
  for (const c of cands) {
    if (!want) {
      hex = c;
      break;
    }
    const p = compactPointHex(await pointOfShare(c));
    if (p === want) {
      hex = c;
      break;
    }
  }
  if (!hex) {
    throw new Error(`orbit pack reconstructed but did not match live P${role}`);
  }
  const ack = await poolPost(api, {
    action: 'pool3p_claim_born',
    signerId,
    role,
    shareHex: hex,
  });
  return {
    scheme: 'wart-3p-ecdsa-lindell-v1',
    role: Number(ack?.role || role),
    shareIndex: Number(ack?.role || role),
    shareHex: hex,
    userShareHex: hex,
    signerId,
    clientBorn: true,
    source: 'orbit-reconstruct',
    waitlist: false,
    poolAddress: hint.poolAddress || ack?.poolAddress || pack.poolAddress || null,
    publicKey: hint.publicKey || ack?.publicKey || null,
    seatEpoch: ack?.seatEpoch ?? hint.seatEpoch ?? 0,
    seal: ack?.seal || hint.seal || null,
    message: `d${role} rebuilt from orbit pack (t=${pack.t || 2} + δ)`,
  };
}

function shamirCombineLocal(shares) {
  const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const pts = shares.map((s) => ({ x: BigInt(String(s.x)), y: BigInt('0x' + String(s.y).replace(/^0x/i, '')) }));
  const invN = (a) => {
    let b = ((a % n) + n) % n;
    let e = n - 2n;
    let r = 1n;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % n;
      b = (b * b) % n;
      e >>= 1n;
    }
    return r;
  };
  let acc = 0n;
  for (let i = 0; i < pts.length; i++) {
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      num = (num * ((n - (pts[j].x % n)) % n)) % n;
      den = (den * ((((pts[i].x - pts[j].x) % n) + n) % n)) % n;
    }
    acc = (acc + pts[i].y * num * invN(den)) % n;
  }
  return acc.toString(16).padStart(64, '0');
}

async function packNextSeat(share, api) {
  const st = await fetchPool3pStatus(api).catch(() => null);
  const live = st?.orbit?.live || [];
  const other = Number(share.role) === 1 ? st?.holder2 : st?.holder1;
  const targets = live.filter((id) => id && id !== share.signerId && id !== other);
  if (targets.length < 2) return null;
  const { makeClientSeat } = await import('./pool3pClient.js');
  const next = makeClientSeat(share.role);
  const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const secret = BigInt('0x' + share.userShareHex);
  const delta = (BigInt('0x' + next.userShareHex) - secret + n * 2n) % n;
  const t = 2;
  const shares = await shamirSplitLocal(next.userShareHex, targets, t);
  await poolPost(api, {
    action: 'pool3p_preshare_put',
    signerId: share.signerId,
    role: share.role,
    t,
    Pnext: next.P,
    delta: delta.toString(16).padStart(64, '0'),
    shares,
  });
  share.nextPacked = true;
  share.packTargets = targets;
  return targets;
}

async function shamirSplitLocal(secretHex, ids, t) {
  const { sha256 } = await import('@noble/hashes/sha256');
  const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const secret = BigInt('0x' + String(secretHex).replace(/^0x/i, ''));
  const coeffs = [secret];
  for (let i = 1; i < t; i++) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    let a = 0n;
    for (const x of b) a = (a << 8n) | BigInt(x);
    coeffs.push(a % n);
  }
  const xOf = (id) => {
    const h = sha256(new TextEncoder().encode(String(id)));
    const hex = [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
    let x = BigInt('0x' + hex) % n;
    if (x === 0n) x = 1n;
    return x;
  };
  return ids.map((id) => {
    const x = xOf(id);
    let y = 0n;
    let p = 1n;
    for (const a of coeffs) {
      y = (y + a * p) % n;
      p = (p * x) % n;
    }
    return { id, x: x.toString(), y: y.toString(16).padStart(64, '0') };
  });
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
  if (raw.clientBorn && !raw.userShareHex && !raw.shareHex && prev?.userShareHex) {
    raw = {
      ...raw,
      userShareHex: prev.userShareHex,
      shareHex: prev.userShareHex,
      paillierLambda: prev.paillierLambda,
      paillierMu: prev.paillierMu,
      paillierN: prev.paillierN,
      paillierG: prev.paillierG,
    };
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
    const assigned = Number(r.role || r.share?.role || 0);
    if (
      (assigned === 1 || assigned === 2) &&
      (!share.userShareHex || (assigned === 1 && !share.paillierLambda))
    ) {
      next = await enrollSigner(share.signerId, api);
      return { ...r, share: next };
    }
    const vacantSeat =
      !(r.holder1 || r.holders?.['1']?.signerId) ||
      !(r.holder2 || r.holders?.['2']?.signerId);
    if ((next.waitlist || Number(next.role) === 0) && vacantSeat) {
      try {
        const recovered = await enrollSigner(share.signerId, api);
        if (recovered && !recovered.waitlist && recovered.userShareHex) {
          next = recovered;
          return { ...r, share: next, shareUpdated: true };
        }
        if (recovered?.message) {
          next = { ...next, message: recovered.message };
        }
      } catch (e) {
        next = {
          ...next,
          message: `rebuild failed: ${e?.message || e}`,
        };
      }
    }
    if (r.share) {
      const applied = await applyIncomingShare(r.share, share);
      if (applied) next = applied;
    }
    const seal = r.seal || next.seal;
    if ((next.role === 1 || next.role === 2) && next.userShareHex && seal) {
      try {
        const { verifyShareSeal } = await import('./pool3pClient.js');
        verifyShareSeal({
          shareHex: next.userShareHex,
          role: next.role,
          seal,
        });
      } catch (e) {
        if (/d[12]·G ≠ P|share was opened or replaced/i.test(e?.message || '')) {
          const recovered = await tryRecoverFromPack(share.signerId, next.role, api, {
            expectedP: seal[next.role === 1 ? 'P1' : 'P2'],
            poolAddress: next.poolAddress,
            publicKey: seal.publicKey || next.publicKey,
            seal,
          });
          if (recovered?.userShareHex) {
            writeBornCache(recovered);
            next = recovered;
            liveShare = recovered;
            if (Number(next.role) === 1) {
              try {
                next = await ensureD1Paillier(recovered, api);
              } catch {
                /* */
              }
            }
          }
        }
      }
    }
    if ((next.role === 1 || next.role === 2) && Number(r.role || 0) === 0) {
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
const fatalTickets = new Map();

async function ensureD1Paillier(share, api) {
  if (share?.paillierN && share?.paillierLambda) return share;
  const cached = await readBornCache(share.signerId, 1);
  if (cached?.paillierLambda && cached.userShareHex === share.userShareHex) {
    attachPaillier(share, cached);
    if (share.paillierLambda) {
      writeBornCache(share);
      return share;
    }
  }
  if (!share?.userShareHex) {
    const err = new Error(
      'd1 hex missing in this tab — use the original Chrome/Brave tab that birthed d1',
    );
    err.code = 'D1_NO_HEX';
    throw err;
  }
  const { generateRandomKeys } = await import('paillier-bigint');
  const { publicKey: pk, privateKey: sk } = await generateRandomKeys(1024);
  const enc = pk.encrypt(BigInt('0x' + String(share.userShareHex).replace(/^0x/i, '')));
  const ack = await poolPost(api, {
    action: 'pool3p_rekey_d1',
    signerId: share.signerId,
    d1Hex: share.userShareHex,
    encD1: enc.toString(),
    paillierN: pk.n.toString(),
    paillierG: pk.g.toString(),
  });
  if (!ack?.ok) {
    const err = new Error(ack?.error || 'd1 Paillier rekey failed');
    err.code = 'D1_REKEY_FAILED';
    throw err;
  }
  share.paillierLambda = sk.lambda.toString();
  share.paillierMu = sk.mu.toString();
  share.paillierN = pk.n.toString();
  share.paillierG = pk.g.toString();
  writeBornCache(share);
  liveShare = share;
  return share;
}

async function sign3pAsRole1(share, req, api) {
  if (fatalTickets.has(req.ticketId)) {
    return { ok: false, fatal: true, ticketId: req.ticketId, error: fatalTickets.get(req.ticketId) };
  }
  const { clientSignRound1, clientSignFinish } = await import('./pool3pClient.js');
  let ready;
  try {
    ready = await ensureD1Paillier(share, api);
  } catch (e) {
    const msg = e?.message || String(e);
    fatalTickets.set(req.ticketId, msg);
    return { ok: false, fatal: true, ticketId: req.ticketId, error: msg };
  }
  const live = await fetchPool3pStatus(api).catch(() => null);
  const poolPub = live?.seal?.publicKey || live?.publicKey || ready.publicKey || ready.seal?.publicKey;
  if (poolPub) ready.publicKey = poolPub;

  let k1 = k1ByTicket.get(req.ticketId);
  let st = await poolPost(api, { action: 'pool3p_ticket', ticketId: req.ticketId });
  const staleRoom = !k1 && (st.haveR1 || st.hasPartial);
  if (staleRoom) {
    await poolPost(api, {
      action: 'pool3p_reset_r1',
      ticketId: req.ticketId,
      signerId: ready.signerId,
    }).catch(() => null);
    k1 = null;
    st = await poolPost(api, { action: 'pool3p_ticket', ticketId: req.ticketId });
  }
  if (!k1 || !st.haveR1) {
    const prep = await poolPost(api, {
      action: 'pool3p_prepare',
      ticketId: req.ticketId,
      toAddress: req.toAddress || st.toAddress,
      amountE8: req.amountE8 || st.amountE8,
    });
    const rnd = clientSignRound1();
    k1 = { ...rnd, hashHex: prep.hashHex };
    const r1 = await poolPost(api, {
      action: 'pool3p_r1',
      ticketId: req.ticketId,
      signerId: ready.signerId,
      R1Hex: rnd.R1Hex,
      hashHex: prep.hashHex,
      amountE8: req.amountE8 || st.amountE8,
      toAddress: req.toAddress || st.toAddress,
    });
    if (r1?.ok === false) {
      return { ok: false, ticketId: req.ticketId, error: r1.error || 'R1 rejected', waiting: true };
    }
    k1ByTicket.set(req.ticketId, k1);
    st = await poolPost(api, { action: 'pool3p_ticket', ticketId: req.ticketId });
  }
  if (!st.hasPartial) {
    return { ok: true, waiting: true, status: st.status, ticketId: req.ticketId };
  }
  let fin;
  try {
    fin = clientSignFinish({
      k1Hex: k1.k1Hex,
      rHex: st.rHex,
      ciphertext: st.ciphertext,
      hashHex: st.hashHex || k1.hashHex,
      clientSecret: ready,
      publicKey: poolPub,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    k1ByTicket.delete(req.ticketId);
    if (/recovery failed|does not match pool pubkey|missing pool pubkey/i.test(msg)) {
      await poolPost(api, {
        action: 'pool3p_reset_r1',
        ticketId: req.ticketId,
        signerId: ready.signerId,
      }).catch(() => null);
      return { ok: false, waiting: true, retry: true, ticketId: req.ticketId, error: msg };
    }
    throw e;
  }
  const paid = await poolPost(api, {
    action: 'pool3p_submit',
    ticketId: req.ticketId,
    signature65: fin.signature65,
    hashHex: st.hashHex || k1.hashHex,
  });
  k1ByTicket.delete(req.ticketId);
  fatalTickets.delete(req.ticketId);
  return paid;
}

export async function contributeOpen(share, api = DEFAULT_POOL_API) {
  const st = await fetchThresholdStatus(api);
  const p3 = await fetchPool3pStatus(api).catch(() => null);
  const seen = new Set();
  const open = [];
  for (const r of [...(p3?.open || []), ...(st.open || [])]) {
    const id = String(r?.ticketId || '');
    if (!id || seen.has(id)) continue;
    if (r.status !== 'open' && r.status !== 'failed' && r.status !== 'wait_r1' && r.status !== 'wait_d2' && r.status !== 'partial' && r.status !== 'ready') {
      continue;
    }
    seen.add(id);
    open.push({ ...r, status: 'open' });
  }
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
        let hex = share.userShareHex || share.shareHex;
        const d2 = await poolPost(api, {
          action: 'pool3p_d2',
          ticketId: req.ticketId,
          signerId: share.signerId,
          d2Hex: hex,
          amountE8: req.amountE8,
          toAddress: req.toAddress,
        });
        if (d2?.recover === 2 || /d2·G ≠ live P2/i.test(d2?.error || '')) {
          const recovered = await tryRecoverFromPack(share.signerId, 2, api, {
            expectedP: d2.expectedP || p3?.seal?.P2,
            poolAddress: share.poolAddress || p3?.address,
            publicKey: p3?.seal?.publicKey || p3?.publicKey,
            seal: p3?.seal,
          });
          if (recovered?.userShareHex) {
            writeBornCache(recovered);
            liveShare = recovered;
            hex = recovered.userShareHex;
            const retry = await poolPost(api, {
              action: 'pool3p_d2',
              ticketId: req.ticketId,
              signerId: share.signerId,
              d2Hex: hex,
              amountE8: req.amountE8,
              toAddress: req.toAddress,
            });
            r = retry;
          } else {
            r = { ok: false, ticketId: req.ticketId, error: d2.error };
          }
        } else {
          r = d2.skipped
            ? { ok: true, orbitOnly: true, ticketId: req.ticketId, note: d2.error }
            : d2;
        }
      } else if (share.scheme?.includes('3p-ecdsa') && role === 1) {
        r = await sign3pAsRole1(share, req, api);
        if (r?.fatal) {
          results.push({ ticketId: req.ticketId, ...r, verify });
          continue;
        }
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
      if (/missing prepare|hash mismatch|recovery failed|do not submit v=0|R1 rejected/i.test(msg)) {
        results.push({
          ticketId: req.ticketId,
          ok: false,
          waiting: true,
          error: msg,
        });
        continue;
      }
      if (/missing Paillier|d1 hex missing|rekey denied|D1_/.test(msg)) {
        fatalTickets.set(req.ticketId, msg);
        results.push({ ticketId: req.ticketId, ok: false, fatal: true, error: msg });
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
    history: Array.isArray(s?.history) ? s.history : [],
  };
}

export async function writeStats(partial) {
  const prev = await readStats();
  const history = Array.isArray(prev.history) ? prev.history.slice() : [];
  const add = partial.appendPaid;
  if (add?.txHash || add?.ticketId) {
    const tx = add.txHash ? String(add.txHash) : '';
    const dup = history.some(
      (h) => (tx && h.txHash === tx) || (!tx && h.ticketId === add.ticketId && h.at === add.at),
    );
    if (!dup) {
      history.unshift({
        ticketId: add.ticketId || null,
        txHash: tx || null,
        amountE8: add.amountE8 || null,
        at: add.at || Date.now(),
      });
    }
  }
  const next = { ...prev, ...partial, history: history.slice(0, 24) };
  delete next.appendPaid;
  await storageSet(STATS_KEY, next);
  return next;
}
