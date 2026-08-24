/**
 * ETH 3P seat-share recovery + fault reporting.
 *
 * Regression cover for a live incident: seat e2 held its lease and heartbeated
 * for over an hour while being unable to sign, so a 50 ETH redeem parked at
 * `wait_d2` with no error anywhere. An ETH seat is born once — the point is
 * uploaded and `needBirth` goes false forever — but the secret lives only in the
 * tab. Once that tab's copy went stale, the contribute loop failed silently on
 * every beat: role 2 threw `ENC_DLOG: x·G ≠ Q` into the console, role 1 posted
 * an R1 it could never finish.
 *
 * Run: npm run test:eth3p
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { generateRandomKeys } from 'paillier-bigint';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const pointOf = (h) =>
  hex(secp256k1.ProjectivePoint.BASE.multiply(BigInt('0x' + h)).toRawBytes(true));

const D2 = hex(secp256k1.utils.randomPrivateKey()); // the real seat-2 secret
const P2 = pointOf(D2);
const STALE = hex(secp256k1.utils.randomPrivateKey()); // a secret for a dead Q
const SID = 'eth-node-test-e2';

// 512-bit keeps the test fast; only well-formedness matters here.
const { publicKey } = await generateRandomKeys(512);

// --- fake browser storage -------------------------------------------------
// Real `localStorage` exposes stored keys as own enumerable properties, which is
// what the recovery sweep relies on. Model that with a Proxy, and give the
// target no non-configurable own props or the ownKeys trap breaks an invariant.
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

// --- fake coordinator -----------------------------------------------------
const seal = {
  P1: pointOf(hex(secp256k1.utils.randomPrivateKey())),
  P2,
  Pdapp: pointOf(hex(secp256k1.utils.randomPrivateKey())),
  publicKey: pointOf(hex(secp256k1.utils.randomPrivateKey())),
  seatEpoch: 0,
  address: '0x00000000000000000000000000000000000000e2',
};
const heartbeatBody = {
  ok: true,
  role: 2,
  seatEpoch: 0,
  needBirth: false,
  clientBorn: true,
  address: seal.address,
  Pdapp: seal.Pdapp,
  seal,
  share: { role: 2, signerId: SID, needBirth: false },
  open: [
    {
      ok: true,
      ticketId: 'eth-redeem-TEST',
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
};

let posted = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  posted.push(body);
  return {
    ok: true,
    json: async () => (body.action === 'eth3p_heartbeat' ? heartbeatBody : { ok: true }),
  };
};

const row = (share) =>
  JSON.stringify({
    userShareHex: share,
    P: P2, // the label is always right; only the secret differs
    role: 2,
    signerId: SID,
    poolAddress: seal.address,
    seal,
  });

let failures = 0;
async function check(label, seed, expect) {
  store.clear();
  posted = [];
  seed();
  // Fresh module per case: liveShare / pendingSeatFault are module state.
  const mod = await import(`../src/lib/ethPoolSigner.js?case=${encodeURIComponent(label)}`);
  // Two beats: a fault raised while handling beat 1 ships on beat 2.
  await mod.heartbeatEth({ signerId: SID, role: 2, seatEpoch: 0 });
  await mod.heartbeatEth({ signerId: SID, role: 2, seatEpoch: 0 });

  const d2 = posted.filter((p) => p.action === 'eth3p_d2').length;
  const faults = posted
    .filter((p) => p.action === 'eth3p_heartbeat')
    .map((p) => p.seatFault?.reason)
    .filter(Boolean);
  const ok = (d2 > 0) === expect.signs && faults.length > 0 === expect.reportsFault;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n` +
      `        eth3p_d2 posted: ${d2} (want ${expect.signs ? '>0' : '0'})\n` +
      `        seat fault sent: ${faults.length ? JSON.stringify(faults[0]) : 'none'} ` +
      `(want ${expect.reportsFault ? 'a fault' : 'none'})`,
  );
}

await check(
  'healthy seat signs',
  () => store.set(`eth.poolSigner.born.${SID}.2`, row(D2)),
  { signs: true, reportsFault: false },
);

await check(
  'share stranded under a stale key is recovered and signs',
  () => {
    store.set(`eth.poolSigner.born.${SID}.2`, row(STALE)); // right label, dead secret
    store.set('eth.poolSigner.born.eth-node-OLD-ID.2', row(D2)); // real secret, orphan key
  },
  { signs: true, reportsFault: false },
);

await check(
  'unsignable seat stays quiet on the wire but reports the fault',
  () => store.set(`eth.poolSigner.born.${SID}.2`, row(STALE)),
  { signs: false, reportsFault: true },
);

console.log(failures ? `\n${failures} failing case(s)` : '\nall cases passed');
process.exit(failures ? 1 : 0);
