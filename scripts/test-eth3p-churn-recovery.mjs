/**
 * ETH 3P seat survives node churn.
 *
 * The scenario that cost this project seat e1: a seat is born, the tab that
 * birthed it goes away, and a fresh tab picks up the lease. `needBirth` is
 * false forever, so the new tab can never mint the secret, and before packs
 * existed there was no way back that did not move Q — the pool key was simply
 * gone.
 *
 * Here the seat was packed while it was healthy. The new tab holds no share at
 * all, asks the orbit, two holders reseal their pieces to it, and it rebuilds
 * the record and signs. The coordinator relays every byte of that and can open
 * none of it.
 *
 * Run: npm run test:eth3p:churn
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { generateRandomKeys } from 'paillier-bigint';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const pointOf = (h) =>
  hex(secp256k1.ProjectivePoint.BASE.multiply(BigInt('0x' + h)).toRawBytes(true));

const D2 = hex(secp256k1.utils.randomPrivateKey());
const P2 = pointOf(D2);
const NEW_TAB = 'eth-node-fresh-tab';

const { publicKey, privateKey } = await generateRandomKeys(512);

// --- storage for the new tab (empty: it never held this seat) -------------
const store = new Map();
globalThis.localStorage = new Proxy(
  {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  {
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  },
);

const idm = await import('../src/lib/nodeIdentity.js');
const { buildPack, resealPiece, packAad } = await import('../src/lib/sealedPreshare.js');

/** Two orbit members that hold pieces, each with its own key. */
function member(id) {
  const priv = hex(secp256k1.utils.randomPrivateKey());
  return { id, privHex: priv, pubHex: hex(secp256k1.getPublicKey(idm.fromHex(priv), true)) };
}
const holders = [member('eth-node-holder-a'), member('eth-node-holder-b')];

const seal = {
  P1: pointOf(hex(secp256k1.utils.randomPrivateKey())),
  P2,
  Pdapp: pointOf(hex(secp256k1.utils.randomPrivateKey())),
  publicKey: pointOf(hex(secp256k1.utils.randomPrivateKey())),
  seatEpoch: 0,
  address: '0x00000000000000000000000000000000000000e2',
};
const AAD = packAad({ pool: 'eth', role: 2, P: P2 });

// The seat packed itself while healthy, before the tab went away.
const PACK = await buildPack({
  record: {
    userShareHex: D2,
    role: 2,
    paillierN: publicKey.n.toString(),
    paillierG: publicKey.g.toString(),
    paillierLambda: privateKey.lambda.toString(),
    paillierMu: privateKey.mu.toString(),
    seal,
  },
  targets: holders.map(({ id, pubHex }) => ({ id, pubHex })),
  t: 2,
  aad: AAD,
});

// --- coordinator ----------------------------------------------------------
// Stores the pack, relays reseal traffic, and — importantly — never holds a key
// that can open any of it.
let pendingRequest = null;
const resealedForRequester = [];
const posted = [];

const heartbeatBody = () => ({
  ok: true,
  role: 2,
  seatEpoch: 0,
  needBirth: false,
  clientBorn: true,
  address: seal.address,
  Pdapp: seal.Pdapp,
  seal,
  share: { role: 2, signerId: NEW_TAB, needBirth: false },
  holder1: 'eth-node-other-seat',
  orbit: { live: [NEW_TAB, ...holders.map((h) => h.id)] },
  orbitKeys: Object.fromEntries(holders.map((h) => [h.id, h.pubHex])),
  resealRequests: [],
  open: [
    {
      ok: true,
      ticketId: 'eth-redeem-CHURN',
      status: 'wait_d2',
      haveR1: true,
      haveD2: false,
      paillierN: publicKey.n.toString(),
      paillierG: publicKey.g.toString(),
      P2Hex: P2,
      publicKey: seal.publicKey,
      hashHex: 'ab'.repeat(32),
    },
  ],
});

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  posted.push(body);
  const reply = (v) => ({ ok: true, json: async () => v });

  switch (body.action) {
    case 'eth3p_heartbeat':
      return reply(heartbeatBody());

    case 'eth3p_preshare_reseal_request': {
      // A holder would answer this on its own next beat. Do it inline.
      pendingRequest = body;
      resealedForRequester.length = 0;
      for (const h of holders) {
        const piece = PACK.pieces.find((p) => p.id === h.id);
        resealedForRequester.push(
          await resealPiece({
            piece,
            toPubHex: body.pubHex,
            aad: body.aad,
            privHex: h.privHex,
          }),
        );
      }
      return reply({ ok: true });
    }

    case 'eth3p_preshare_collect':
      return reply(
        pendingRequest
          ? { ok: true, pack: PACK, resealed: resealedForRequester }
          : { ok: true, pack: null, resealed: [] },
      );

    default:
      return reply({ ok: true });
  }
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

// --- the fresh tab takes the seat ----------------------------------------
store.set('eth.poolSigner.signerId', NEW_TAB);
const mod = await import('../src/lib/ethPoolSigner.js');

await mod.heartbeatEth({ signerId: NEW_TAB, role: 2, seatEpoch: 0 });
await mod.heartbeatEth({ signerId: NEW_TAB, role: 2, seatEpoch: 0 });

const d2Posts = posted.filter((p) => p.action === 'eth3p_d2').length;
const faults = posted
  .filter((p) => p.action === 'eth3p_heartbeat')
  .map((p) => p.seatFault?.reason)
  .filter(Boolean);

check(
  'a tab that never held the seat recovers it from the orbit',
  d2Posts > 0,
  `eth3p_d2 posted: ${d2Posts} (want >0)`,
);

check(
  'the recovered record signs for the live seat',
  !!store.get(`eth.poolSigner.born.${NEW_TAB}.2`),
  'the rebuilt share is cached under this tab',
);

check(
  'it published its public key so others can seal to it',
  posted.some((p) => p.action === 'eth3p_heartbeat' && /^0[23][0-9a-f]{64}$/.test(p.nodePubHex || '')),
);

check(
  'presence is attested, not merely asserted',
  posted.some(
    (p) => p.action === 'eth3p_heartbeat' && p.attestation?.sigHex && p.attestation?.claim,
  ),
);

// The coordinator saw the whole exchange. It must still be locked out.
const relayed = JSON.stringify({ PACK, resealedForRequester });
check(
  'nothing the coordinator relayed contains the secret',
  !relayed.includes(D2) && !relayed.includes(privateKey.lambda.toString()),
  'pieces and record are ciphertext end to end',
);

check('a recovered seat reports no fault', faults.length === 0, faults[0] || 'none');

console.log(failures ? `\n${failures} failing case(s)` : '\nall cases passed');
process.exit(failures ? 1 : 0);
