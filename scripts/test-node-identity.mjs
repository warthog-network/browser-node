/**
 * Node identity: sealing and heartbeat attestation.
 *
 * Covers the properties the preshare rework depends on:
 *  - a piece sealed to one node cannot be opened by another (this is the whole
 *    point — the coordinator relays pieces it must not be able to combine)
 *  - the identity survives a signerId change (packs addressed to this node stay
 *    openable when the coordinator relabels it)
 *  - AAD binds a piece to its seat and Q, so a stale-Q or wrong-role piece
 *    fails loudly instead of decrypting into a secret for a dead Q
 *  - attestations verify, and do not transfer between claims
 *
 * Run: npm run test:identity
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const mod = await import('../src/lib/nodeIdentity.js');
const {
  getNodeIdentity,
  sealJson,
  unsealJson,
  attest,
  verifyAttestation,
  toHex,
  fromHex,
} = mod;

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

async function throws(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

// --- identity is stable ---------------------------------------------------
const me = await getNodeIdentity();
const again = await getNodeIdentity();
check('identity is minted once and reused', me.pubHex === again.pubHex);

// A relabelled signerId must not disturb the key: packs are addressed to the
// public key, so rotating the label would otherwise orphan every piece.
store.set('poolSigner.signerId', 'node-relabelled');
const afterRelabel = await getNodeIdentity();
check('identity survives a signerId change', afterRelabel.pubHex === me.pubHex);

// --- a second node, to play recipient/attacker ----------------------------
const { secp256k1 } = await import('@noble/curves/secp256k1');
const otherPriv = toHex(secp256k1.utils.randomPrivateKey());
const otherPub = toHex(secp256k1.getPublicKey(fromHex(otherPriv), true));

// --- sealing --------------------------------------------------------------
const piece = { id: 'node-a3ab', x: '42', y: 'de'.repeat(32) };
const AAD = 'wart|role=1|P=02de4161cc34bace';

const sealed = await sealJson(otherPub, piece, AAD);
check('sealed blob carries no plaintext', !JSON.stringify(sealed).includes(piece.y));

const opened = await unsealJson(sealed, otherPriv);
check('recipient opens its own piece', JSON.stringify(opened) === JSON.stringify(piece));

check(
  'a different node cannot open it',
  await throws(() => unsealJson(sealed, me.privHex)),
  'this is the property that stops the coordinator combining pieces',
);

// AAD binding: same ciphertext, wrong context → must fail, not silently open.
const wrongCtx = { ...sealed, aad: 'wart|role=2|P=02de4161cc34bace' };
check(
  'wrong role/Q context is rejected',
  await throws(() => unsealJson(wrongCtx, otherPriv)),
);

// Tamper: flip a byte of ciphertext → GCM must reject.
const flipped = { ...sealed, ct: (sealed.ct[0] === 'a' ? 'b' : 'a') + sealed.ct.slice(1) };
check(
  'tampered ciphertext is rejected',
  await throws(() => unsealJson(flipped, otherPriv)),
);

// Distinct seals of the same piece must differ (fresh ephemeral key + iv).
const sealed2 = await sealJson(otherPub, piece, AAD);
check('each seal is fresh', sealed.epk !== sealed2.epk && sealed.ct !== sealed2.ct);

// --- attestation ----------------------------------------------------------
const claim = { pool: 'eth', role: 2, seatEpoch: 0, signerId: 'eth-node-79fc', at: 1787576761557 };
const att = await attest(claim);
check('own attestation verifies', verifyAttestation(att));

check(
  'attestation does not transfer to another claim',
  !verifyAttestation({ ...att, claim: { ...claim, role: 1 } }),
  'a seat-1 presence claim must not be forgeable from a seat-2 signature',
);

check(
  'attestation does not verify under another key',
  !verifyAttestation({ ...att, pubHex: otherPub }),
);

check('malformed attestation is rejected, not thrown', verifyAttestation({}) === false);

console.log(failures ? `\n${failures} failing case(s)` : '\nall cases passed');
process.exit(failures ? 1 : 0);
