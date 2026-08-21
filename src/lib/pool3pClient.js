/**
 * Browser Lindell client for 3P pool signer role 1 (d1 + Paillier sk).
 * Full d never assembled here.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, PrivateKey } from 'paillier-bigint';
import { verifySignC } from './lindellZk.js';

const CURVE_N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;

function modN(a) {
  let x = a % CURVE_N;
  if (x < 0n) x += CURVE_N;
  return x;
}

function modPow(base, exp, mod) {
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function invScalar(a) {
  return modPow(modN(a), CURVE_N - 2n, CURVE_N);
}

function hexToScalar(hex) {
  const h = String(hex ?? '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) {
    throw new Error(`bad hex scalar (${String(hex).slice(0, 18) || 'empty'})`);
  }
  return modN(BigInt('0x' + h));
}

function scalarToHex(s) {
  return modN(s).toString(16).padStart(64, '0');
}

function randomScalar() {
  for (let i = 0; i < 32; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    let x = 0n;
    for (const b of bytes) x = (x << 8n) | BigInt(b);
    x = modN(x);
    if (x > 0n) return x;
  }
  throw new Error('scalar sample failed');
}

function pointToCompressedHex(P) {
  const bytes = P.toRawBytes(true);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sealBindHex(seal) {
  const msg = [
    'wart-3p-seal-v1',
    String(seal.address || ''),
    String(seal.publicKey || ''),
    String(seal.P1 || ''),
    String(seal.P2 || ''),
    String(seal.Pdapp || ''),
    String(Number(seal.seatEpoch || 0)),
  ].join('|');
  return bytesToHex(sha256(new TextEncoder().encode(msg)));
}

/** Refuse a lease whose scalar is not the published seat for this vault. */
export function verifyShareSeal({ shareHex, role, seal }) {
  if (!seal || seal.scheme !== 'wart-3p-seal-v1' || !seal.bind) {
    throw new Error('SEAL_MISSING: share has no 3P seal — refuse lease');
  }
  if (sealBindHex(seal) !== seal.bind) {
    throw new Error('SEAL_BROKEN: bind hash mismatch');
  }
  const P1 = secp256k1.ProjectivePoint.fromHex(String(seal.P1).replace(/^0x/i, ''));
  const P2 = secp256k1.ProjectivePoint.fromHex(String(seal.P2).replace(/^0x/i, ''));
  const Pd = secp256k1.ProjectivePoint.fromHex(String(seal.Pdapp).replace(/^0x/i, ''));
  const Q = secp256k1.ProjectivePoint.fromHex(String(seal.publicKey).replace(/^0x/i, ''));
  const sum = P1.add(P2).add(Pd);
  if (pointToCompressedHex(sum) !== pointToCompressedHex(Q)) {
    throw new Error('SEAL_BROKEN: P1+P2+Pdapp ≠ Q — dealer combined/swapped seats');
  }
  const d = hexToScalar(shareHex);
  const Pgot = pointToCompressedHex(G.multiply(d)).toLowerCase();
  const Pwant = String(Number(role) === 1 ? seal.P1 : seal.P2).toLowerCase();
  if (Pgot !== Pwant) {
    throw new Error(`SEAL_BROKEN: d${role}·G ≠ P${role} — share was opened or replaced`);
  }
  return {
    ok: true,
    address: seal.address,
    seatEpoch: seal.seatEpoch,
    dealerSawPlaintext: !!seal.dealerSawPlaintext,
  };
}

/** Birth a seat on the signer. VPS should store only the point (+ Enc for d1). */
export function makeClientSeat(role) {
  const d = randomScalar();
  return {
    role: Number(role),
    userShareHex: scalarToHex(d),
    P: pointToCompressedHex(G.multiply(d)),
  };
}

export const PAILLIER_BITS = 2048;

function schnorrChallenge(Phex, Rhex, context) {
  const msg = [
    'wart-3p-schnorr-v1',
    String(context || ''),
    String(Phex || '').replace(/^0x/i, '').toLowerCase(),
    String(Rhex || '').replace(/^0x/i, '').toLowerCase(),
  ].join('|');
  return hexToScalar(bytesToHex(sha256(new TextEncoder().encode(msg))));
}

export function seatPokContext(kind, role, Phex) {
  return [
    'wart-3p-seat',
    String(kind || ''),
    String(Number(role || 0)),
    String(Phex || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
  ].join('|');
}

/** Schnorr PoK of dlog(P). Does NOT prove Enc(d) encrypts that dlog. */
export function schnorrProveDlog(shareHex, context) {
  const d = hexToScalar(shareHex);
  const Phex = pointToCompressedHex(G.multiply(d));
  let k;
  let Rhex;
  let e;
  for (let i = 0; i < 8; i++) {
    k = randomScalar();
    Rhex = pointToCompressedHex(G.multiply(k));
    e = schnorrChallenge(Phex, Rhex, context);
    if (e !== 0n) break;
  }
  if (!e) throw new Error('schnorr challenge was 0');
  return {
    P: Phex,
    R: Rhex,
    s: scalarToHex(modN(k + e * d)),
    context: String(context || ''),
  };
}

export function clientSignRound1() {
  const k1 = randomScalar();
  return {
    k1Hex: scalarToHex(k1),
    R1Hex: pointToCompressedHex(G.multiply(k1)),
  };
}

function normPubHex(hex) {
  return String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function schnorrChallengeOnBase(statementHex, commitHex, baseHex, context) {
  const msg = [
    'wart-3p-schnorr-base-v1',
    String(context || ''),
    normPubHex(baseHex),
    normPubHex(statementHex),
    normPubHex(commitHex),
  ].join('|');
  return hexToScalar(bytesToHex(sha256(new TextEncoder().encode(msg))));
}

function lindellRPokContext({ R1Hex, RHex, rHex, hashHex, ciphertext }) {
  const cHash = bytesToHex(sha256(new TextEncoder().encode(String(ciphertext || ''))));
  return [
    'wart-3p-r-eq-k2r1-v1',
    normPubHex(R1Hex),
    normPubHex(RHex),
    String(rHex || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    String(hashHex || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    cHash,
  ].join('|');
}

function verifyLindellR({ pok, k1Hex, R1Hex, RHex, rHex, hashHex, ciphertext }) {
  if (!pok?.R || !pok?.s) {
    throw new Error('LINDELL_R_POK_MISSING: need Schnorr that R = k2·R1');
  }
  if (!RHex) throw new Error('LINDELL_R_POK_MISSING: need RHex');
  const k1 = hexToScalar(k1Hex);
  const R1got = pointToCompressedHex(G.multiply(k1));
  const R1n = normPubHex(R1Hex || R1got);
  if (normPubHex(R1got) !== R1n) {
    throw new Error('LINDELL_R_POK: R1 ≠ k1·G');
  }
  const R = secp256k1.ProjectivePoint.fromHex(normPubHex(RHex));
  if (modN(R.toAffine().x) !== hexToScalar(rHex)) {
    throw new Error('LINDELL_R_POK: r ≠ Rx(R) mod n');
  }
  const ctx = lindellRPokContext({
    R1Hex: R1n,
    RHex,
    rHex,
    hashHex,
    ciphertext,
  });
  const statementHex = normPubHex(RHex);
  const Base = secp256k1.ProjectivePoint.fromHex(R1n);
  const Statement = secp256k1.ProjectivePoint.fromHex(statementHex);
  const T = secp256k1.ProjectivePoint.fromHex(normPubHex(pok.R));
  const s = hexToScalar(pok.s);
  const e = schnorrChallengeOnBase(statementHex, normPubHex(pok.R), R1n, ctx);
  const left = pointToCompressedHex(Base.multiply(s));
  const right = pointToCompressedHex(T.add(Statement.multiply(e)));
  if (left !== right) {
    throw new Error('LINDELL_R_POK: s·R1 ≠ T + e·R — coordinator does not know k2');
  }
  return true;
}

export function clientSignFinish({
  k1Hex,
  rHex,
  ciphertext,
  hashHex,
  clientSecret,
  publicKey,
  RHex,
  R1Hex,
  pokR,
  pokC,
  R2Hex,
  Q2Hex,
  ckeyAdj,
  sid,
}) {
  if (!clientSecret?.paillierN || !clientSecret?.paillierLambda) {
    throw new Error('d1 seat missing Paillier key — re-enroll this tab as d1');
  }
  verifyLindellR({
    pok: pokR,
    k1Hex,
    R1Hex,
    RHex,
    rHex,
    hashHex,
    ciphertext,
  });
  if (!Q2Hex || !R2Hex || ckeyAdj == null) {
    throw new Error('LINDELL_C_ZK_MISSING: need Q2Hex, R2Hex, and ckeyAdj');
  }
  verifySignC({
    paillierN: clientSecret.paillierN,
    paillierG: clientSecret.paillierG,
    ckey: String(ckeyAdj),
    c: ciphertext,
    Q2Hex,
    R2Hex,
    m: hexToScalar(hashHex),
    r: hexToScalar(rHex),
    pokC,
    sid: sid || hashHex,
    aux: 0,
  });
  const k1 = hexToScalar(k1Hex);
  const r = hexToScalar(rHex);
  const pub = new PublicKey(BigInt(clientSecret.paillierN), BigInt(clientSecret.paillierG));
  const sk = new PrivateKey(
    BigInt(clientSecret.paillierLambda),
    BigInt(clientSecret.paillierMu),
    pub,
  );
  const pt = sk.decrypt(BigInt(String(ciphertext).replace(/^0x/i, '')));
  let s = modN(invScalar(k1) * modN(pt));
  if (s > CURVE_N / 2n) s = CURVE_N - s;

  const rPad = scalarToHex(r);
  const sPad = scalarToHex(s);
  const msgHex = String(hashHex || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(msgHex)) {
    throw new Error('d1 finish missing hashHex — wait for prepare');
  }
  const msg = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    msg[i] = parseInt(msgHex.slice(i * 2, i * 2 + 2), 16);
  }
  const expectPub = String(
    publicKey || clientSecret.publicKey || clientSecret.seal?.publicKey || '',
  )
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!expectPub) {
    throw new Error('d1 finish missing pool pubkey — cannot pick recovery id');
  }

  let recid = null;
  for (let rec = 0; rec < 4; rec++) {
    try {
      const sig = new secp256k1.Signature(r, s).addRecoveryBit(rec);
      const recPub = [...sig.recoverPublicKey(msg).toRawBytes(true)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      if (recPub === expectPub) {
        recid = rec;
        break;
      }
    } catch {
      /* */
    }
  }
  if (recid == null) {
    throw new Error(
      '3P recovery failed — signature does not match pool pubkey (do not submit v=0)',
    );
  }
  return {
    signature65: rPad + sPad + recid.toString(16).padStart(2, '0'),
  };
}
