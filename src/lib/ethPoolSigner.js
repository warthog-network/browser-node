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

/**
 * Sealed-preshare helpers, loaded on demand like the other crypto in this file.
 * Keeps ECIES + Shamir out of the bundle for nodes that never hold a seat.
 */
async function preshare() {
  return import('./preshareClient.js');
}

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

async function storageKeys() {
  try {
    if (globalThis.chrome?.storage?.local) {
      return Object.keys((await chrome.storage.local.get(null)) || {});
    }
  } catch {
    /* */
  }
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
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

async function readNextBornCache(signerId, role) {
  const raw = await storageGet(nextBornKey(signerId, role));
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

function compactPt(p) {
  return String(p || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

async function loadHexForLiveSeat(signerId, role, st, api) {
  const live = await readBornCache(signerId, role);
  if (await shareSignsLiveSeat(live, st, role)) return live;

  const nxt = await readNextBornCache(signerId, role);
  if (await shareSignsLiveSeat(nxt, st, role)) {
    const promoted = {
      ...nxt,
      nextQ: false,
      role,
      poolAddress: st?.address || nxt.poolAddress,
      seal: st?.seal || nxt.seal,
    };
    await writeBornCache(promoted);
    return promoted;
  }

  // Neither of this signer's two keys holds a usable secret. Sweep every born
  // record in the profile before giving up: a rotate that cut over while the tab
  // was closed, or a regenerated signerId, leaves the real share filed under a
  // key nothing reads again. The seat is already born, so needBirth stays false
  // and no re-birth can refill it — this sweep is the only way back that does
  // not move Q.
  const mine = new Set([bornKey(signerId, role), nextBornKey(signerId, role)]);
  for (const key of await storageKeys()) {
    if (!key.startsWith('eth.poolSigner.born') || mine.has(key)) continue;
    let row = await storageGet(key);
    if (typeof row === 'string') {
      try {
        row = JSON.parse(row);
      } catch {
        continue;
      }
    }
    if (!row || typeof row !== 'object') continue;
    if (!(await shareSignsLiveSeat(row, st, role))) continue;
    const recovered = {
      ...row,
      nextQ: false,
      role,
      signerId,
      P: compactPt(role === 1 ? st?.seal?.P1 : st?.seal?.P2),
      poolAddress: st?.address || row.poolAddress,
      publicKey: st?.seal?.publicKey || st?.publicKey || row.publicKey,
      Pdapp: st?.Pdapp || st?.seal?.Pdapp || row.Pdapp,
      seal: st?.seal || row.seal,
    };
    await writeBornCache(recovered);
    console.warn(`[eth3p] recovered seat e${role} share from ${key}`);
    return recovered;
  }

  // Nothing in this profile signs for the live seat. Before giving up, ask the
  // orbit: if this seat was packed, `t` holders can reseal their pieces to us
  // and we can rebuild the record. This is the path that would have saved e1 —
  // a seat whose only copy left with a closed tab.
  if (api) {
    try {
      const liveP = compactPt(role === 1 ? st?.seal?.P1 : st?.seal?.P2);
      const rec = await (await preshare()).recoverSeat({
        post: (action, body) => poolPost(api, { action, ...body }),
        prefix: 'eth3p',
        pool: 'eth',
        signerId,
        role,
        P: liveP,
      });
      // Trust the pack no further than the curve does: a record only counts if
      // its secret actually derives to the live point.
      if (rec?.userShareHex && (await pointOfShare(rec.userShareHex)) === liveP) {
        const recovered = {
          ...rec,
          nextQ: false,
          role,
          signerId,
          P: liveP,
          poolAddress: st?.address || rec.poolAddress,
          seal: st?.seal || rec.seal,
        };
        await writeBornCache(recovered);
        /**
         * Tell the coordinator who holds this seat now.
         *
         * `seats[r].signerId` still names the tab that birthed it, and that name
         * is what gates the lease — so without this the seat has to be adopted
         * again, and recovered again, every time the lease lapses. A Schnorr
         * proof of dlog(P) is the honest basis for rewriting it: this tab can
         * demonstrate what the birth record only asserts. Best-effort, because
         * an older coordinator has no such endpoint and the seat signs either
         * way once the secret is back.
         */
        try {
          const { schnorrProveDlog, seatPokContext } = await import('./pool3pClient.js');
          await poolPost(api, {
            action: 'eth3p_claim_born',
            signerId,
            role,
            pok: schnorrProveDlog(rec.userShareHex, seatPokContext('claim', role, liveP)),
          });
        } catch {
          /* old coordinator, or someone live still holds the lease */
        }
        console.warn(`[eth3p] recovered seat e${role} from orbit preshare pack`);
        return recovered;
      }
    } catch {
      // No pack, too few holders online yet, or an old coordinator. Fall
      // through and report the fault; the next beat can try again.
    }
  }

  // Deliberately not `live`. Handing a stale-Q secret to the contribute loop is
  // what produced the silent hang: role 2 throws ENC_DLOG: x·G ≠ Q into the
  // console on every heartbeat, and role 1 posts an R1 it can never finish, so
  // the ticket parks at wait_d2 looking half-done.
  return null;
}

async function pointOfShare(hex) {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const h = String(hex).replace(/^0x/i, '');
  const d = BigInt('0x' + h);
  const bytes = secp256k1.ProjectivePoint.BASE.multiply(d).toRawBytes(true);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Why the coordinator has to be told about this.
 *
 * A seat is born on the VPS but the secret lives only in the tab that birthed
 * it, so `needBirth` goes false forever the moment the point is uploaded. If the
 * tab later loses (or outdates) that secret it keeps the lease and keeps
 * heartbeating, and every failure below is a console.warn nobody reads. The seat
 * then reads as healthy — holder set, orbit live, not stranded — while it can
 * never post R1 or Enc(d2). Surfacing the fault in the heartbeat is the only way
 * the coordinator can distinguish "waiting" from "cannot sign".
 */
let pendingSeatFault = null;

/**
 * Last seat claim this tab got the coordinator to accept, as role:P:signerId.
 *
 * claimBornEthSeat is what sets claimedBorn, and claimedBorn is the only thing
 * that clears `recovering` on the lease. Claiming used to happen in exactly one
 * place — the orbit-pack recovery branch — which a tab only enters when it has
 * no usable share. So the first recovery claimed the seat, and every later
 * re-acquisition took the cached-share path, never claimed, and left the lease
 * sitting at recovering:true until releaseStaleRecovering handed it to the next
 * candidate. Seat 2 churned between three tabs on a ~30s cycle that way, none
 * of them ever becoming proven.
 *
 * Re-claiming is idempotent, so the rule is simply: whenever we hold a seat we
 * can sign for, make sure the coordinator has heard it from us.
 */
let lastSeatClaim = { key: '', at: 0 };
const SEAT_CLAIM_REFRESH_MS = 60000;

/**
 * Tell the coordinator this tab holds the seat, if it has not heard so lately.
 *
 * Best-effort in the same sense as the recovery-path claim: an older
 * coordinator has no such endpoint, and a claim can be legitimately denied
 * while a proven holder is live. Either way the seat still signs — this only
 * decides whether the lease reads as recovering or proven.
 */
async function ensureSeatClaimed({ role, signerId, share, status, api }) {
  const r = Number(role);
  if (r !== 1 && r !== 2) return;
  const holder = r === 1 ? status?.holder1 : status?.holder2;
  const liveP = compactPt(r === 1 ? status?.seal?.P1 : status?.seal?.P2);
  if (!liveP || !share?.userShareHex) return;
  if (holder && holder !== signerId) {
    // Someone else has it. Forget our claim so re-acquiring re-claims rather
    // than trusting a receipt from a tenure that has already ended.
    lastSeatClaim = { key: '', at: 0 };
    return;
  }
  // Throttle before deriving the point: shareSignsLiveSeat costs a scalar
  // multiply, and on a settled seat this runs on every beat to do nothing.
  const key = `${r}:${liveP}:${signerId}`;
  if (lastSeatClaim.key === key && Date.now() - lastSeatClaim.at < SEAT_CLAIM_REFRESH_MS) return;
  if (!(await shareSignsLiveSeat(share, status, r))) return;
  try {
    const { schnorrProveDlog, seatPokContext } = await import('./pool3pClient.js');
    await poolPost(api, {
      action: 'eth3p_claim_born',
      signerId,
      role: r,
      pok: schnorrProveDlog(share.userShareHex, seatPokContext('claim', r, liveP)),
    });
    lastSeatClaim = { key, at: Date.now() };
  } catch (e) {
    // Denied while a proven holder is live, or an old coordinator. Leave the
    // receipt cleared so the next beat tries again.
    lastSeatClaim = { key: '', at: 0 };
    console.warn('[eth3p claim_born]', e?.message || String(e));
  }
}

function reportSeatFault(role, reason) {
  pendingSeatFault = {
    role: Number(role) || 0,
    reason: String(reason || 'unknown').slice(0, 300),
    at: Date.now(),
  };
}

function clearSeatFault() {
  pendingSeatFault = null;
}

/**
 * This replaces a check that compared the P *recorded alongside* a cached share
 * and fell back to matching the pool address. Both are labels the record carries
 * about itself, not evidence about the secret: a row can name the right P and
 * hold the wrong hex, and the address fallback matches every row minted for this
 * Q. Deriving the point from the secret is the only check that answers "can this
 * tab actually sign for the live seat".
 */
async function shareSignsLiveSeat(row, st, role) {
  if (!row?.userShareHex) return false;
  const liveP = compactPt(role === 1 ? st?.seal?.P1 : st?.seal?.P2);
  if (!liveP) return false;
  try {
    return (await pointOfShare(row.userShareHex)) === liveP;
  } catch {
    return false;
  }
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
  if (!Array.isArray(open) || !open.length) return;
  const role = Number(share?.role || 0);
  if (!share?.userShareHex) {
    // Returning quietly here is what let a seat hold its lease while being
    // unable to sign. Say so, so the coordinator can mark the seat.
    if (role === 1 || role === 2) {
      reportSeatFault(role, 'seat holder has no share that signs for the live Q');
    }
    return;
  }
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
        /**
         * The round on the coordinator may not be the round we started.
         *
         * The seat-1 lease can move between beats, and eth3pOfferR1 stamps
         * whichever holder posts into t.R1Hex. A tab that cached k1 before the
         * handover then verifies a pokR proving R = k2·R1 for *someone else's*
         * R1 and throws LINDELL_R_POK on every beat forever: the hash check
         * above cannot see it, because a sweep's hashHex never changes, and
         * `t.haveR1` stays true so the re-post branch below is skipped.
         *
         * Matching on R1 is what actually answers "is this my round". Dropping
         * the nonce costs one beat — the next pass posts a fresh R1 and the
         * coordinator re-runs Lindell off the d2 it already has.
         */
        const ticketR1 = String(t.R1Hex || '').replace(/^0x/i, '').toLowerCase();
        const myR1 = String(k1?.R1Hex || '').replace(/^0x/i, '').toLowerCase();
        if (k1 && ticketR1 && myR1 && myR1 !== ticketR1) {
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
          // `st` is only fetched when a ticket is missing its Paillier params,
          // so for a normal ticket it is null and this was undefined. Without a
          // pool pubkey clientSignFinish cannot pick the recovery id and throws.
          publicKey:
            st?.seal?.publicKey ||
            st?.publicKey ||
            req.publicKey ||
            share.publicKey ||
            share.seal?.publicKey,
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
      clearSeatFault();
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn('[eth3p contribute]', id, msg);
      // ENC_DLOG / range / finish failures all mean this tab cannot complete the
      // round. The coordinator sees only the absence of a message, so report it.
      if (role === 1 || role === 2) reportSeatFault(role, `${id}: ${msg}`);
    }
  }
}

async function maybeBirthEthNext(share, api) {
  const st = await fetchEth3pStatus(api).catch(() => null);
  const need = st?.rotation?.next?.needBirth;
  const bornBy = st?.rotation?.next?.bornBy || {};
  if (!need) return null;
  const sid = share?.signerId;
  const liveRole = Number(share.role || 0);
  // A tab that already birthed next e2 must still be allowed to fill vacant next e1
  // (and vice versa). Skipping the whole function deadlocks rotate when the other
  // live holder is the only remaining signer.
  const need1 = !!(need[1] || need['1']) && bornBy[1] !== sid;
  const need2 = !!(need[2] || need['2']) && bornBy[2] !== sid;
  if (!need1 && !need2) return null;
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
    // Publishes this node's public key (so others can seal pieces to it) and a
    // signed presence claim. Best-effort: an old coordinator ignores both.
    ...(await (await preshare()).identityFields({
      pool: 'eth',
      role: share?.role ?? 0,
      seatEpoch: share?.seatEpoch ?? 0,
      signerId,
    }).catch(() => ({}))),
    // Reported one beat late by construction: the fault is raised while handling
    // the previous response. That is soon enough — a stuck seat stays stuck.
    ...(pendingSeatFault ? { seatFault: pendingSeatFault } : {}),
  });
  const role = Number(r.role || r.share?.role || share?.role || 0);

  // Answer reseal requests before anything else. This node may hold a piece for
  // a seat it does not occupy, and a tab trying to recover is blocked until
  // enough holders answer.
  await (await preshare()).serveResealRequests({
    post: (action, body) => poolPost(api, { action, ...body }),
    prefix: 'eth3p',
    signerId,
    requests: r.resealRequests,
  }).catch(() => 0);
  let hexShare = share?.userShareHex ? share : liveShare;
  if (role === 1 || role === 2) {
    if (!(await shareSignsLiveSeat(hexShare, r, role))) {
      const cached = await loadHexForLiveSeat(signerId, role, r, api);
      // No usable secret anywhere: drop the in-memory one instead of carrying it
      // into contributeEthOpen, where it can only fail silently.
      hexShare = cached?.userShareHex ? { ...r.share, ...cached, role } : null;
    }
    if (hexShare?.userShareHex) clearSeatFault();
  }
  if (r.needBirth && (role === 1 || role === 2) && !hexShare?.userShareHex) {
    hexShare = await enrollEthSigner(api);
  }
  const live = hexShare?.userShareHex ? hexShare : share;

  // Keep the pack current while we can still sign. Packing is what makes this
  // seat survivable if this tab goes away; doing it here means a seat is only
  // ever unprotected for as long as it takes to birth and beat once.
  if (live?.userShareHex && (role === 1 || role === 2)) {
    await (await preshare()).packSeat({
      post: (action, body) => poolPost(api, { action, ...body }),
      prefix: 'eth3p',
      pool: 'eth',
      signerId,
      role,
      P: compactPt(role === 1 ? r?.seal?.P1 : r?.seal?.P2),
      // Role 2 cannot rebuild Enc(d2) from the scalar alone, and nobody can
      // finish a partial ticket without these, so the Paillier private key
      // travels with the share.
      record: {
        userShareHex: live.userShareHex,
        role,
        scheme: live.scheme || 'eth-3p-ecdsa-lindell-v1',
        paillierN: live.paillierN,
        paillierG: live.paillierG,
        paillierLambda: live.paillierLambda,
        paillierMu: live.paillierMu,
        P: live.P,
        publicKey: live.publicKey || r?.seal?.publicKey,
        Pdapp: live.Pdapp || r?.Pdapp,
        seal: live.seal || r?.seal,
      },
      orbit: r?.orbit?.live || [],
      orbitKeys: r?.orbitKeys || {},
      otherHolderId: role === 1 ? r?.holder2 : r?.holder1,
    }).catch(() => null);
  }

  // Before contributing: a seat whose lease still reads as recovering gets
  // recycled out from under us mid-round, which is how a ticket ends up with an
  // R1 from one tab and no way for the next one to finish it.
  if (role === 1 || role === 2) {
    await ensureSeatClaimed({ role, signerId, share: live, status: r, api });
  }

  if ((r.open || []).length && (role === 1 || role === 2)) {
    await contributeEthOpen({ ...(live || {}), role, signerId }, r.open, api);
  }
  try {
    await maybeBirthEthNext({ ...(live || {}), role, signerId }, api);
  } catch (e) {
    const msg = e?.message || String(e);
    if (!/already born/i.test(msg)) {
      console.warn('[eth3p birth_next]', msg);
      r.birthNextError = msg;
    }
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
