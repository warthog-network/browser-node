/**
 * Sealed preshare packs — shared by the WART and ETH pools.
 *
 * Why this exists
 * ---------------
 * A seat is born once. The point goes to the coordinator, `needBirth` goes
 * false forever, and the secret lives only in the tab that birthed it. Lose
 * that tab and the seat is stranded: it cannot be re-birthed without moving Q.
 * Preshare packs are the answer — split the secret across other orbit members
 * so a new tab can reconstruct it.
 *
 * The existing WART implementation posts those pieces to the coordinator in the
 * clear, at a threshold equal to the number of pieces stored, for both seats.
 * That hands the coordinator the ability to reconstruct d1 and d2 by itself,
 * which is exactly what splitting the key was meant to prevent. Here each piece
 * is sealed to its recipient, so the coordinator relays ciphertext it cannot
 * open, and reconstruction needs `t` members to actively cooperate.
 *
 * The Paillier problem
 * --------------------
 * A WART seat is one 256-bit scalar, which Shamir handles directly. An ETH seat
 * is not: role 2 also needs its Paillier private key to build Enc(d2), and
 * nobody can finish a `partial` ticket without it. Those are ~1024-bit values,
 * far too large for the secp256k1 scalar field.
 *
 * So we split a *pack key*, not the secret. A random 256-bit key is shared out
 * t-of-n, and the seat record — scalar, Paillier private material, whatever the
 * pool needs — is encrypted under it as one blob. `t` cooperating members
 * recover the pack key and decrypt the record. Both pools then use the same
 * shape, and an ETH pack is no larger to distribute than a WART one.
 *
 * Cooperative recovery
 * --------------------
 * Sealing means the recovering node cannot read the stored pieces: they are
 * addressed to other members. Recovery is therefore a request — the requester
 * publishes its public key, each holder opens its own piece and reseals it to
 * the requester, and the requester combines. This trades a liveness assumption
 * (`t` holders must be online) for the coordinator losing custody. Choose
 * n > t so ordinary churn does not strand a seat all over again.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { sealJson, unsealJson, toHex, fromHex } from './nodeIdentity.js';

const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const PACK_VERSION = 'preshare-sealed-v1';

const utf8 = (s) => new TextEncoder().encode(String(s));
const modN = (x) => ((x % N) + N) % N;

/**
 * Piece x-coordinate for a member.
 *
 * Same derivation the plaintext WART packs use — sha256(signerId) mod n — so a
 * pack written by either implementation combines the same way. Do not change it
 * without a migration: outstanding packs would stop reconstructing.
 */
export function xOf(id) {
  const x = modN(BigInt('0x' + toHex(sha256(utf8(String(id))))));
  return x === 0n ? 1n : x;
}

function invN(a) {
  let [old_r, r] = [modN(a), N];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return modN(old_s);
}

export function shamirSplit(secretHex, ids, t) {
  const coeffs = [BigInt('0x' + String(secretHex).replace(/^0x/i, ''))];
  for (let i = 1; i < t; i++) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    coeffs.push(modN(BigInt('0x' + toHex(b))));
  }
  return ids.map((id) => {
    const x = xOf(id);
    let y = 0n;
    let p = 1n;
    for (const a of coeffs) {
      y = modN(y + a * p);
      p = modN(p * x);
    }
    return { id, x: x.toString(), y: y.toString(16).padStart(64, '0') };
  });
}

export function shamirCombine(shares) {
  const pts = (shares || [])
    .filter((s) => s?.x && s?.y)
    .map((s) => ({ x: modN(BigInt(s.x)), y: modN(BigInt('0x' + s.y)) }));
  if (pts.length < 2) return null;
  let acc = 0n;
  for (let i = 0; i < pts.length; i++) {
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      num = modN(num * modN(-pts[j].x));
      den = modN(den * modN(pts[i].x - pts[j].x));
    }
    acc = modN(acc + pts[i].y * num * invN(den));
  }
  return acc.toString(16).padStart(64, '0');
}

// --- record encryption under the pack key --------------------------------

async function packKeyCipher(packKeyHex, aad) {
  const base = await crypto.subtle.importKey('raw', fromHex(packKeyHex), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: sha256(utf8(`${PACK_VERSION}|${aad}`)), info: utf8(PACK_VERSION) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Build a pack: pieces sealed to each target, record encrypted under the key
 * those pieces reconstruct.
 *
 * `targets` are `{ id, pubHex }`. A target without a published key cannot be
 * sealed to and is skipped — callers should treat too few usable targets as a
 * reason not to claim the seat is protected.
 */
export async function buildPack({ record, targets, t = 2, aad = '' }) {
  const usable = (targets || []).filter((x) => x?.id && x?.pubHex);
  if (usable.length < t) {
    throw new Error(`need ${t} sealable targets, have ${usable.length}`);
  }
  const packKey = new Uint8Array(32);
  crypto.getRandomValues(packKey);
  const packKeyHex = modN(BigInt('0x' + toHex(packKey))).toString(16).padStart(64, '0');

  const pieces = shamirSplit(packKeyHex, usable.map((x) => x.id), t);
  const sealed = [];
  for (const piece of pieces) {
    const to = usable.find((x) => x.id === piece.id);
    sealed.push({
      id: piece.id,
      x: piece.x,
      toPub: to.pubHex,
      sealed: await sealJson(to.pubHex, { x: piece.x, y: piece.y }, aad),
    });
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await packKeyCipher(packKeyHex, aad);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(aad) },
    key,
    utf8(JSON.stringify(record)),
  );

  return {
    v: PACK_VERSION,
    t,
    n: sealed.length,
    aad,
    pieces: sealed,
    encRecord: { iv: toHex(iv), ct: toHex(new Uint8Array(ct)) },
  };
}

/** Open a piece addressed to this node and reseal it to a requester. */
export async function resealPiece({ piece, toPubHex, aad, privHex }) {
  const opened = await unsealJson(piece.sealed, privHex);
  return {
    id: piece.id,
    x: opened.x,
    toPub: toPubHex,
    sealed: await sealJson(toPubHex, opened, aad),
  };
}

/**
 * Combine `t` pieces resealed to us and decrypt the record.
 *
 * Returns null rather than throwing when the pieces do not reconstruct a usable
 * key: a caller that cannot recover must fall through to reporting a seat
 * fault, not carry a half-recovered secret into a signing round.
 */
export async function openPack({ pack, resealed, privHex }) {
  const shares = [];
  const seenX = new Set();
  const take = async (sealed) => {
    try {
      const piece = await unsealJson(sealed, privHex);
      const x = String(piece?.x || '');
      if (!x || seenX.has(x)) return;
      seenX.add(x);
      shares.push(piece);
    } catch {
      /* not addressed to us, or tampered — ignore this piece */
    }
  };

  /**
   * A piece already addressed to us counts.
   *
   * Reading only `resealed` throws away the recoverer's own piece, because a
   * node skips its own request when it serves reseals — it never mails itself
   * anything. That is one piece short for no reason, and it decides real cases:
   * a t=2 pack held by exactly two nodes becomes recoverable only by some third
   * node, and if the orbit is down to those two the seat is lost while both
   * halves of it are sitting online. Unsealing is authenticated, so a piece not
   * addressed to us simply fails and is skipped.
   */
  for (const p of pack?.pieces || []) {
    if (p?.sealed) await take(p.sealed);
  }
  for (const p of resealed || []) {
    if (p?.sealed) await take(p.sealed);
  }
  if (shares.length < Number(pack?.t || 2)) return null;

  const packKeyHex = shamirCombine(shares);
  if (!packKeyHex) return null;
  try {
    const key = await packKeyCipher(packKeyHex, pack.aad || '');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(pack.encRecord.iv), additionalData: utf8(pack.aad || '') },
      key,
      fromHex(pack.encRecord.ct),
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

/**
 * Choose who holds pieces.
 *
 * Excludes self, the other seat's holder, and any member whose id marks it as
 * running on the coordinator: a piece stored on the same host as the pack store
 * gives back exactly the custody this design removes. Callers pass `exclude`
 * for pool-specific ids.
 */
export function chooseTargets({ orbit, selfId, otherHolderId, pubKeys = {}, exclude = [], max = 4 }) {
  const banned = new Set([selfId, otherHolderId, ...exclude].filter(Boolean));
  return (orbit || [])
    .filter((id) => id && !banned.has(id) && !/(^|-)(vps|coordinator)(-|$)/i.test(id))
    .map((id) => ({ id, pubHex: pubKeys[id] || null }))
    .filter((x) => x.pubHex)
    .slice(0, max);
}

/** Context string binding a pack to one pool, seat, and Q. */
export function packAad({ pool, role, P }) {
  return `${pool}|role=${Number(role)}|P=${String(P || '').toLowerCase()}`;
}
