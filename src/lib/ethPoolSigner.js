/**
 * ETH 3P signer (e1/e2). Separate storage from WART d1/d2 (wart.poolSigner.*).
 * Birth + heartbeat only here; ETH Lindell pay lands after wrap/unwrap tickets.
 */
export const DEFAULT_POOL_API = 'https://cartesi-bridge.duckdns.org/api/pool';

const ENABLED_KEY = 'eth.poolSigner.enabled';
const PANEL_KEY = 'eth.poolSigner.panelOpen';
const ID_KEY = 'eth.poolSigner.signerId';
const SHARE_KEY = 'eth.poolSigner.enrolledShare';

let liveShare = null;

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function storageGet(k) {
  try {
    if (globalThis.chrome?.storage?.local) {
      const o = await chrome.storage.local.get(k);
      return o?.[k];
    }
  } catch {
    /* */
  }
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

async function storageSet(k, v) {
  try {
    if (globalThis.chrome?.storage?.local) {
      await chrome.storage.local.set({ [k]: v });
      return;
    }
  } catch {
    /* */
  }
  try {
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  } catch {
    /* */
  }
}

async function storageRemove(k) {
  try {
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.remove(k);
  } catch {
    /* */
  }
  try {
    localStorage.removeItem(k);
  } catch {
    /* */
  }
}

async function poolPost(api, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(api || DEFAULT_POOL_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || j.message || `eth3p ${res.status}`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

export async function readEnabled() {
  const v = await storageGet(ENABLED_KEY);
  return v === true || v === '1' || v === 'true';
}

export async function writeEnabled(on) {
  await storageSet(ENABLED_KEY, on ? '1' : '0');
}

export async function readPanelOpen() {
  const v = await storageGet(PANEL_KEY);
  return v !== '0' && v !== false;
}

export async function writePanelOpen(open) {
  await storageSet(PANEL_KEY, open ? '1' : '0');
}

async function getOrCreateSignerId() {
  let id = await storageGet(ID_KEY);
  if (id && String(id).startsWith('eth-node-')) return String(id);
  id = `eth-node-${uuid()}`;
  await storageSet(ID_KEY, id);
  return id;
}

function bornKey(signerId, role) {
  return `eth.poolSigner.born.${signerId}.${role}`;
}

function nextBornKey(signerId, role) {
  return `eth.poolSigner.born.next.${signerId}.${role}`;
}

async function writeBornCache(share) {
  if (!share?.userShareHex || !(share.role === 1 || share.role === 2)) return;
  await storageSet(bornKey(share.signerId, share.role), share);
}

async function readBornCache(signerId, role) {
  const raw = await storageGet(bornKey(signerId, role));
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

async function pointOfShare(hex) {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const h = String(hex).replace(/^0x/i, '');
  const d = BigInt('0x' + h);
  const bytes = secp256k1.ProjectivePoint.BASE.multiply(d).toRawBytes(true);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function birthAndUploadSeat(signerId, role, api, hint) {
  const { makeClientSeat, schnorrProveDlog, seatPokContext, PAILLIER_BITS } =
    await import('./pool3pClient.js');
  const seat = makeClientSeat(role);
  const body = {
    action: 'eth3p_birth',
    signerId,
    role,
    P: seat.P,
  };
  if (Number(role) === 1) {
    const zk = await import('./lindellZk.js');
    const { generateRandomKeys } = await import('paillier-bigint');
    const d1 = zk.randomShareLindellRange();
    seat.userShareHex = zk.scalarToHex(d1);
    seat.P = await pointOfShare(seat.userShareHex);
    body.P = seat.P;
    const { publicKey: pk, privateKey: sk } = await generateRandomKeys(PAILLIER_BITS);
    const enc = zk.encryptWithR(pk, d1);
    body.encD1 = enc.c.toString();
    body.paillierN = pk.n.toString();
    body.paillierG = pk.g.toString();
    body.rangeProof = zk.proveRangeLindell({
      x: d1,
      rEnc: enc.r,
      c: enc.c,
      paillierN: pk.n.toString(),
      paillierG: pk.g.toString(),
      Q1: seat.P,
      context: seatPokContext('birth', 1, seat.P),
    });
    seat.paillierLambda = sk.lambda.toString();
    seat.paillierMu = sk.mu.toString();
    seat.paillierN = pk.n.toString();
    seat.paillierG = pk.g.toString();
  }
  body.pok = schnorrProveDlog(seat.userShareHex, seatPokContext('birth', role, seat.P));
  let ack = await poolPost(api, body);
  if (Number(role) === 1 && ack?.needPdl) {
    const zk = await import('./lindellZk.js');
    const pr = zk.pdlProverCommit({
      cPrime: ack.pdl.cPrime,
      paillierN: seat.paillierN,
      paillierG: seat.paillierG,
      paillierLambda: seat.paillierLambda,
      paillierMu: seat.paillierMu,
    });
    const opened = await poolPost(api, {
      action: 'eth3p_pdl_commit',
      signerId,
      comQ: pr.comQ,
    });
    zk.pdlProverFinish({
      alpha: pr.alpha,
      x1: BigInt('0x' + String(seat.userShareHex).replace(/^0x/i, '')),
      a: opened.a,
      b: opened.b,
      Qhat: pr.Qhat,
      comQ: pr.comQ,
      nonceQ: pr.nonceQ,
      comAB: opened.comAB,
      nonceAB: opened.nonceAB,
      Q1: seat.P,
    });
    ack = await poolPost(api, {
      action: 'eth3p_pdl_finish',
      signerId,
      Qhat: pr.Qhat,
      nonceQ: pr.nonceQ,
      comQ: pr.comQ,
    });
  }
  const share = {
    scheme: 'eth-3p-ecdsa-lindell-v1',
    role: Number(role),
    shareIndex: Number(role),
    shareHex: seat.userShareHex,
    userShareHex: seat.userShareHex,
    signerId,
    poolAddress: ack.address || hint.poolAddress || null,
    publicKey: ack.publicKey || hint.publicKey || null,
    Pdapp: ack.Pdapp || hint.Pdapp || null,
    P: seat.P,
    clientBorn: true,
    waitlist: false,
    seatEpoch: ack.seal?.seatEpoch ?? 0,
    seal: ack.seal || null,
    paillierLambda: seat.paillierLambda || null,
    paillierMu: seat.paillierMu || null,
    paillierN: seat.paillierN || null,
    paillierG: seat.paillierG || null,
    message: ack.ready ? `e${role} born — ETH pool address ready` : `e${role} born`,
  };
  writeBornCache(share);
  liveShare = share;
  return share;
}

export async function enrollEthSigner(api = DEFAULT_POOL_API) {
  const signerId = await getOrCreateSignerId();
  const r = await poolPost(api, { action: 'eth3p_enroll', signerId });
  if (r.needBirth && (r.role === 1 || r.role === 2)) {
    const cached = await readBornCache(signerId, r.role);
    const same =
      cached?.userShareHex &&
      r.Pdapp &&
      String(cached.Pdapp || cached.seal?.Pdapp || '').toLowerCase() ===
        String(r.Pdapp).toLowerCase();
    if (same) {
      liveShare = cached;
      return cached;
    }
    return birthAndUploadSeat(signerId, r.role, api, r);
  }
  if (r.clientBorn && (r.role === 1 || r.role === 2) && !r.needBirth) {
    const cached = await readBornCache(signerId, r.role);
    if (cached?.userShareHex) {
      liveShare = { ...r, ...cached, userShareHex: cached.userShareHex };
      return liveShare;
    }
  }
  liveShare = r;
  await storageSet(ID_KEY, signerId);
  await storageRemove(SHARE_KEY);
  return r;
}

const k1ByTicket = new Map();

async function contributeEthOpen(share, open, api) {
  if (!share?.userShareHex || !Array.isArray(open) || !open.length) return;
  const role = Number(share.role || 0);
  const needStatus = open.some((t) => !t.paillierN || !t.paillierG);
  const st = needStatus ? await fetchEth3pStatus(api).catch(() => null) : null;
  for (const req of open) {
    const id = String(req.ticketId || '');
    if (!id || req.status === 'paid') continue;
    try {
      if (role === 2) {
        const zk = await import('./lindellZk.js');
        const { PublicKey } = await import('paillier-bigint');
        const { seatPokContext } = await import('./pool3pClient.js');
        const n = st?.paillierN || req.paillierN;
        const g = st?.paillierG || req.paillierG;
        const P2 = String(st?.seal?.P2 || req.P2Hex || '')
          .replace(/^0x/i, '')
          .toLowerCase();
        if (!n || !g || !P2) continue;
        const x = BigInt('0x' + String(share.userShareHex).replace(/^0x/i, ''));
        const pub = new PublicKey(BigInt(n), BigInt(g));
        const enc = zk.encryptWithR(pub, x);
        const ctx = `${seatPokContext('offer-d2', 2, P2)}|${id}`;
        const body = {
          action: 'eth3p_d2',
          ticketId: id,
          signerId: share.signerId,
          encD2: enc.c.toString(),
          encDlogProof: zk.proveEncEqualsDlog({
            x,
            rEnc: enc.r,
            c: enc.c,
            paillierN: n,
            paillierG: g,
            Qhex: P2,
            context: ctx,
          }),
        };
        if (x >= zk.LINDELL_Q_THIRD && x <= 2n * zk.LINDELL_Q_THIRD) {
          body.rangeProof = zk.proveRangeLindell({
            x,
            rEnc: enc.r,
            c: enc.c,
            paillierN: n,
            paillierG: g,
            Q1: P2,
            context: ctx,
          });
        }
        await poolPost(api, body);
      } else if (role === 1) {
        const { clientSignRound1, clientSignFinish } = await import('./pool3pClient.js');
        let t = await poolPost(api, { action: 'eth3p_ticket', ticketId: id });
        let k1 = k1ByTicket.get(id);
        const ticketHash = String(t.hashHex || '').replace(/^0x/i, '').toLowerCase();
        const k1Hash = String(k1?.hashHex || '').replace(/^0x/i, '').toLowerCase();
        if (k1 && ticketHash && k1Hash && k1Hash !== ticketHash) {
          k1ByTicket.delete(id);
          k1 = null;
        }
        if (!k1 || !t.haveR1) {
          const rnd = clientSignRound1();
          k1 = { ...rnd, hashHex: t.hashHex };
          await poolPost(api, {
            action: 'eth3p_r1',
            ticketId: id,
            signerId: share.signerId,
            R1Hex: rnd.R1Hex,
            hashHex: t.hashHex,
          });
          k1ByTicket.set(id, k1);
          t = await poolPost(api, { action: 'eth3p_ticket', ticketId: id });
        }
        if (!t.hasPartial) continue;
        const fin = clientSignFinish({
          k1Hex: k1.k1Hex,
          rHex: t.rHex,
          ciphertext: t.ciphertext,
          hashHex: t.hashHex || k1.hashHex,
          clientSecret: share,
          publicKey: st?.seal?.publicKey || st?.publicKey,
          RHex: t.RHex,
          pokR: t.pokR,
          pokC: t.pokC,
          R2Hex: t.R2Hex,
          Q2Hex: t.Q2Hex,
          ckeyAdj: t.ckeyAdj,
          sid: id,
          paillierN: t.paillierN,
          paillierG: t.paillierG,
        });
        if (fin?.signature65) {
          await poolPost(api, {
            action: 'eth3p_submit',
            ticketId: id,
            signature65: fin.signature65,
          });
          k1ByTicket.delete(id);
        }
      }
    } catch (e) {
      console.warn('[eth3p contribute]', id, e?.message || e);
    }
  }
}

async function maybeBirthEthNext(share, api) {
  const st = await fetchEth3pStatus(api).catch(() => null);
  const need = st?.rotation?.next?.needBirth;
  const bornBy = st?.rotation?.next?.bornBy || {};
  if (!need || (!need[1] && !need['1'] && !need[2] && !need['2'])) return null;
  if (bornBy[1] === share.signerId || bornBy[2] === share.signerId) return null;
  const liveRole = Number(share.role || 0);
  const need1 = !!(need[1] || need['1']);
  const need2 = !!(need[2] || need['2']);
  const role =
    need1 && liveRole === 1 ? 1 : need2 && liveRole === 2 ? 2 : need1 ? 1 : need2 ? 2 : null;
  if (!role) return null;
  const { makeClientSeat, schnorrProveDlog, seatPokContext, PAILLIER_BITS } =
    await import('./pool3pClient.js');
  const seat = makeClientSeat(role);
  const body = {
    action: 'eth3p_birth_next',
    signerId: share.signerId,
    role,
    P: seat.P,
  };
  if (role === 1) {
    const zk = await import('./lindellZk.js');
    const { generateRandomKeys } = await import('paillier-bigint');
    const d1 = zk.randomShareLindellRange();
    seat.userShareHex = zk.scalarToHex(d1);
    seat.P = await pointOfShare(seat.userShareHex);
    body.P = seat.P;
    const { publicKey: pk, privateKey: sk } = await generateRandomKeys(PAILLIER_BITS);
    const enc = zk.encryptWithR(pk, d1);
    body.encD1 = enc.c.toString();
    body.paillierN = pk.n.toString();
    body.paillierG = pk.g.toString();
    body.rangeProof = zk.proveRangeLindell({
      x: d1,
      rEnc: enc.r,
      c: enc.c,
      paillierN: pk.n.toString(),
      paillierG: pk.g.toString(),
      Q1: seat.P,
      context: seatPokContext('birth-next', 1, seat.P),
    });
    seat.paillierLambda = sk.lambda.toString();
    seat.paillierMu = sk.mu.toString();
    seat.paillierN = pk.n.toString();
    seat.paillierG = pk.g.toString();
  }
  body.pok = schnorrProveDlog(seat.userShareHex, seatPokContext('birth-next', role, seat.P));
  let ack = await poolPost(api, body);
  if (role === 1 && ack?.needPdl) {
    const zk = await import('./lindellZk.js');
    const pr = zk.pdlProverCommit({
      cPrime: ack.pdl.cPrime,
      paillierN: seat.paillierN,
      paillierG: seat.paillierG,
      paillierLambda: seat.paillierLambda,
      paillierMu: seat.paillierMu,
    });
    const opened = await poolPost(api, {
      action: 'eth3p_pdl_commit_next',
      signerId: share.signerId,
      comQ: pr.comQ,
    });
    zk.pdlProverFinish({
      alpha: pr.alpha,
      x1: BigInt('0x' + String(seat.userShareHex).replace(/^0x/i, '')),
      a: opened.a,
      b: opened.b,
      Qhat: pr.Qhat,
      comQ: pr.comQ,
      nonceQ: pr.nonceQ,
      comAB: opened.comAB,
      nonceAB: opened.nonceAB,
      Q1: seat.P,
    });
    ack = await poolPost(api, {
      action: 'eth3p_pdl_finish_next',
      signerId: share.signerId,
      Qhat: pr.Qhat,
      nonceQ: pr.nonceQ,
      comQ: pr.comQ,
    });
  }
  const born = {
    scheme: 'eth-3p-ecdsa-lindell-v1',
    role,
    shareHex: seat.userShareHex,
    userShareHex: seat.userShareHex,
    signerId: share.signerId,
    poolAddress: ack.address || null,
    publicKey: ack.publicKey || null,
    Pdapp: ack.Pdapp || ack.seal?.Pdapp || null,
    P: seat.P,
    nextQ: true,
    clientBorn: true,
    seal: ack.seal || null,
    paillierLambda: seat.paillierLambda || null,
    paillierMu: seat.paillierMu || null,
    paillierN: seat.paillierN || null,
    paillierG: seat.paillierG || null,
  };
  await storageSet(nextBornKey(share.signerId, role), born);
  return born;
}

export async function heartbeatEth(share, api = DEFAULT_POOL_API) {
  const signerId = share?.signerId || (await getOrCreateSignerId());
  const r = await poolPost(api, {
    action: 'eth3p_heartbeat',
    signerId,
    seatEpoch: share?.seatEpoch ?? 0,
  });
  const role = Number(r.role || r.share?.role || share?.role || 0);
  let hexShare = share?.userShareHex ? share : liveShare;
  if (!hexShare?.userShareHex && (role === 1 || role === 2)) {
    const cached = await readBornCache(signerId, role);
    if (cached?.userShareHex) hexShare = { ...r.share, ...cached };
  }
  if (r.needBirth && (role === 1 || role === 2) && !hexShare?.userShareHex) {
    hexShare = await enrollEthSigner(api);
  }
  const live = hexShare?.userShareHex ? hexShare : share;
  if (live?.userShareHex && (r.open || []).length) {
    await contributeEthOpen({ ...live, role, signerId }, r.open, api);
  }
  if (live?.userShareHex) {
    await maybeBirthEthNext({ ...live, role, signerId }, api).catch((e) =>
      console.warn('[eth3p birth_next]', e?.message || e),
    );
  }
  const merged = live?.userShareHex
    ? { ...(r.share || {}), ...live, userShareHex: live.userShareHex, role }
    : r.share || share;
  liveShare = merged;
  return { ...r, share: merged };
}

export async function loadActiveEthShare() {
  if (liveShare) return liveShare;
  return enrollEthSigner();
}

export async function fetchEth3pStatus(api = DEFAULT_POOL_API) {
  return poolPost(api, { action: 'eth3p_status' });
}

export function stopEthSigningLocal() {
  liveShare = null;
}

export async function readEthStats() {
  return { signedCount: 0, history: [] };
}
