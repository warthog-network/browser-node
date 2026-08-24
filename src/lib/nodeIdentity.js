/**
 * Per-node keypair: seals preshare pieces, and attests heartbeats.
 *
 * Two problems share one key here.
 *
 * Sealing. Preshare packs exist so a seat survives node churn: a seat is born
 * once, the secret lives only in the tab that birthed it, and without a pack a
 * closed tab strands the seat forever. But the pieces are posted to the
 * coordinator, and today they are posted in the clear — every piece of every
 * seat sits in one file on the VPS, at a threshold equal to the number of
 * pieces stored. That makes the coordinator able to reconstruct d1/d2 (or
 * e1/e2) by itself, which is precisely what splitting the key was meant to
 * prevent. Sealing each piece to its recipient turns the coordinator back into
 * a relay that carries ciphertext it cannot open.
 *
 * Attestation. Once a node has a long-lived keypair, it can sign what it sends.
 * A signed heartbeat is evidence that a named holder was actually present for a
 * round, so a pool signature produced without its seat holders is detectable
 * rather than silent. That does not make unilateral signing impossible — no
 * scheme does, if one operator controls enough parties — but it moves the
 * property from "trust the operator" to "the operator would have to lie in
 * public".
 *
 * secp256k1 for both roles: the curve is already a dependency, and reusing it
 * keeps one key per node rather than one for ECDH and another for signatures.
 * Sealing is ECIES — ephemeral ECDH, HKDF-SHA256, AES-256-GCM via WebCrypto,
 * which is present in browsers, extension pages, and Node 20+.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

const ID_KEY = 'node.identity.v1';
const SEAL_VERSION = 'seal-v1';

// --- storage (same two-tier shape the signers use) ------------------------

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

// --- hex helpers ----------------------------------------------------------

export const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(h) {
  const s = String(h || '').replace(/^0x/i, '');
  if (s.length % 2) throw new Error('odd-length hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const utf8 = (s) => new TextEncoder().encode(String(s));

// --- identity -------------------------------------------------------------

/**
 * The node's keypair, minted once and kept for the life of the profile.
 *
 * Deliberately not derived from signerId: signerId is a label the coordinator
 * hands out and can change, while this key is what other nodes seal to. If it
 * moved when signerId moved, every outstanding pack addressed to this node
 * would become undecryptable.
 */
export async function getNodeIdentity() {
  let rec = await storageGet(ID_KEY);
  if (typeof rec === 'string') {
    try {
      rec = JSON.parse(rec);
    } catch {
      rec = null;
    }
  }
  if (rec?.privHex && rec?.pubHex) return rec;

  const priv = secp256k1.utils.randomPrivateKey();
  const identity = {
    v: 1,
    privHex: toHex(priv),
    pubHex: toHex(secp256k1.getPublicKey(priv, true)),
    at: Date.now(),
  };
  await storageSet(ID_KEY, identity);
  return identity;
}

/** Public half only — safe to publish on enroll/heartbeat. */
export async function getNodePublicKey() {
  return (await getNodeIdentity()).pubHex;
}

// --- sealing (ECIES: ephemeral ECDH + HKDF + AES-GCM) ---------------------

async function deriveKey(sharedX, ephPubHex, recipientPubHex) {
  const base = await crypto.subtle.importKey('raw', sharedX, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: sha256(utf8(`${SEAL_VERSION}|${ephPubHex}|${recipientPubHex}`)),
      // Binding the transcript into `info` means a sealed piece cannot be
      // replayed under a different version or recipient.
      info: utf8(SEAL_VERSION),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Seal bytes to a recipient's public key.
 *
 * `aad` is authenticated but not encrypted — pass the context the ciphertext is
 * only valid in (pool, role, Q point). A piece resealed for a different seat or
 * a stale Q then fails to open instead of decrypting into a wrong-Q secret,
 * which is the failure mode that cost this project a stranded seat.
 */
export async function sealTo(recipientPubHex, plaintext, aad = '') {
  const bytes = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
  const eph = secp256k1.utils.randomPrivateKey();
  const ephPubHex = toHex(secp256k1.getPublicKey(eph, true));
  const shared = secp256k1.getSharedSecret(eph, fromHex(recipientPubHex), true);
  const key = await deriveKey(shared.slice(1), ephPubHex, String(recipientPubHex));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(aad) },
    key,
    bytes,
  );
  return {
    v: SEAL_VERSION,
    epk: ephPubHex,
    iv: toHex(iv),
    ct: toHex(new Uint8Array(ct)),
    aad: String(aad),
  };
}

/** Open a sealed blob with this node's private key. Throws if it is not ours. */
export async function unseal(sealed, privHex) {
  if (!sealed?.epk || !sealed?.iv || !sealed?.ct) throw new Error('malformed sealed blob');
  if (sealed.v && sealed.v !== SEAL_VERSION) throw new Error(`unknown seal version ${sealed.v}`);
  const priv = privHex || (await getNodeIdentity()).privHex;
  const pubHex = toHex(secp256k1.getPublicKey(fromHex(priv), true));
  const shared = secp256k1.getSharedSecret(fromHex(priv), fromHex(sealed.epk), true);
  const key = await deriveKey(shared.slice(1), sealed.epk, pubHex);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromHex(sealed.iv), additionalData: utf8(sealed.aad || '') },
    key,
    fromHex(sealed.ct),
  );
  return new Uint8Array(pt);
}

/** Convenience: seal/open a JSON value. */
export async function sealJson(recipientPubHex, value, aad = '') {
  return sealTo(recipientPubHex, utf8(JSON.stringify(value)), aad);
}

export async function unsealJson(sealed, privHex) {
  return JSON.parse(new TextDecoder().decode(await unseal(sealed, privHex)));
}

// --- attestation ----------------------------------------------------------

/**
 * Canonical bytes for a heartbeat attestation.
 *
 * Sorted keys so two nodes hashing the same facts agree, and the pool/role/
 * epoch are inside the hash so a signature from one seat cannot be replayed as
 * another's.
 */
export function attestationDigest(claim) {
  const ordered = Object.keys(claim || {})
    .sort()
    .map((k) => `${k}=${claim[k]}`)
    .join('&');
  return sha256(utf8(`wart-node-attest-v1|${ordered}`));
}

/** Sign a heartbeat claim. Returns the signature and the key that made it. */
export async function attest(claim) {
  const { privHex, pubHex } = await getNodeIdentity();
  const sig = secp256k1.sign(attestationDigest(claim), fromHex(privHex));
  return { pubHex, sigHex: toHex(sig.toCompactRawBytes()), claim };
}

/** Verify an attestation against a claimed public key. */
export function verifyAttestation({ pubHex, sigHex, claim } = {}) {
  if (!pubHex || !sigHex || !claim) return false;
  try {
    return secp256k1.verify(fromHex(sigHex), attestationDigest(claim), fromHex(pubHex));
  } catch {
    return false;
  }
}
