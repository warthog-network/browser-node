/**
 * Sealed preshare packs: threshold, custody, and cooperative recovery.
 *
 * The properties under test are the ones this rework exists for:
 *  - the coordinator, holding the whole pack, cannot recover the record
 *  - t-1 cooperating members cannot either
 *  - t can, via reseal, and get the seat record back intact
 *  - an ETH-shaped record (Paillier private key included) survives the round
 *    trip, which plain Shamir over the scalar field could not carry
 *  - a pack for one seat/Q cannot be opened as another
 *  - target choice never puts a piece on the coordinator host
 *
 * Run: npm run test:preshare
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { secp256k1 } = await import('@noble/curves/secp256k1');
const idm = await import('../src/lib/nodeIdentity.js');
const {
  buildPack,
  openPack,
  resealPiece,
  chooseTargets,
  packAad,
  shamirSplit,
  shamirCombine,
} = await import('../src/lib/sealedPreshare.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

/** A fake orbit member with its own keypair. */
function member(id) {
  const priv = idm.toHex(secp256k1.utils.randomPrivateKey());
  return { id, privHex: priv, pubHex: idm.toHex(secp256k1.getPublicKey(idm.fromHex(priv), true)) };
}

const m = ['node-a', 'node-b', 'node-c', 'node-d'].map(member);
const requester = member('node-new-tab');
const pubKeys = Object.fromEntries(m.map((x) => [x.id, x.pubHex]));

// --- shamir agrees with the existing derivation ---------------------------
const secret = 'ab'.repeat(32);
check(
  'shamir round-trips at threshold',
  shamirCombine(shamirSplit(secret, ['node-a', 'node-b'], 2).slice(0, 2)) === secret,
);

// --- an ETH-shaped record (this is what plain shamir could not carry) -----
const record = {
  userShareHex: 'cd'.repeat(32),
  role: 2,
  paillierN: '9'.repeat(617),
  paillierLambda: '7'.repeat(600),
  paillierMu: '3'.repeat(600),
  seal: { P2: '03c3faff' },
};
const AAD = packAad({ pool: 'eth', role: 2, P: '03c3faff' });

const pack = await buildPack({ record, targets: m.map(({ id, pubHex }) => ({ id, pubHex })), t: 2, aad: AAD });
check('pack is n=4 t=2', pack.n === 4 && pack.t === 2);

const blob = JSON.stringify(pack);
check(
  'pack leaks no secret material',
  !blob.includes(record.userShareHex) && !blob.includes(record.paillierLambda),
  'the coordinator stores exactly this',
);

// --- the coordinator holds everything and still cannot open it -----------
const coordinator = member('pool-3p-orbit-vps');
check(
  'coordinator cannot open the pack',
  (await openPack({ pack, resealed: pack.pieces, privHex: coordinator.privHex })) === null,
  'holding every sealed piece is not enough without the recipients',
);

// --- t-1 members cannot ---------------------------------------------------
const oneReseal = [
  await resealPiece({
    piece: pack.pieces[0],
    toPubHex: requester.pubHex,
    aad: AAD,
    privHex: m[0].privHex,
  }),
];
check(
  't-1 cooperating members cannot open it',
  (await openPack({ pack, resealed: oneReseal, privHex: requester.privHex })) === null,
);

// --- t members can, and the record survives intact ------------------------
const twoReseal = [
  oneReseal[0],
  await resealPiece({
    piece: pack.pieces[1],
    toPubHex: requester.pubHex,
    aad: AAD,
    privHex: m[1].privHex,
  }),
];
const recovered = await openPack({ pack, resealed: twoReseal, privHex: requester.privHex });
check(
  't members recover the full record',
  JSON.stringify(recovered) === JSON.stringify(record),
  'includes the Paillier private key, which role 2 cannot sign without',
);

// Any t of the n must work, not just the first two.
const lateReseal = [
  await resealPiece({ piece: pack.pieces[2], toPubHex: requester.pubHex, aad: AAD, privHex: m[2].privHex }),
  await resealPiece({ piece: pack.pieces[3], toPubHex: requester.pubHex, aad: AAD, privHex: m[3].privHex }),
];
const recovered2 = await openPack({ pack, resealed: lateReseal, privHex: requester.privHex });
check('any t of n works (survives churn)', JSON.stringify(recovered2) === JSON.stringify(record));

// --- a recoverer that already holds a piece uses it ------------------------
// A node never answers its own reseal request, so its own piece never arrives
// in `resealed`. Reading only that list threw the piece away and left the node
// one short: with a t=2 pack held by exactly two members, neither of them could
// rebuild the seat and it took some third node to do it — which is how e1 came
// to be unrecoverable by two of the three browsers that were holding it.
const insider = m[0];
const toInsider = [
  await resealPiece({ piece: pack.pieces[1], toPubHex: insider.pubHex, aad: AAD, privHex: m[1].privHex }),
];
check(
  'a holder recovering the seat counts its own piece',
  JSON.stringify(await openPack({ pack, resealed: toInsider, privHex: insider.privHex })) ===
    JSON.stringify(record),
  'one reseal plus the piece already addressed to it reaches t=2',
);
check(
  'but its own piece alone is still not enough',
  (await openPack({ pack, resealed: [], privHex: insider.privHex })) === null,
);
check(
  'and an outsider still needs t reseals',
  (await openPack({ pack, resealed: [], privHex: requester.privHex })) === null,
);

// --- a pack is bound to its seat and Q ------------------------------------
const wrongSeat = { ...pack, aad: packAad({ pool: 'eth', role: 1, P: '03c3faff' }) };
check(
  'pack for one seat cannot open as another',
  (await openPack({ pack: wrongSeat, resealed: twoReseal, privHex: requester.privHex })) === null,
);

// --- target choice keeps pieces off the coordinator -----------------------
const targets = chooseTargets({
  orbit: ['node-a', 'node-b', 'node-c', 'node-d', 'pool-3p-orbit-vps', 'node-self', 'node-other'],
  selfId: 'node-self',
  otherHolderId: 'node-other',
  pubKeys: { ...pubKeys, 'pool-3p-orbit-vps': coordinator.pubHex },
});
const ids = targets.map((t) => t.id);
check('self and the other seat holder are excluded', !ids.includes('node-self') && !ids.includes('node-other'));
check(
  'the coordinator host is excluded',
  !ids.includes('pool-3p-orbit-vps'),
  'a piece there would restore the custody this design removes',
);
check('members without a published key are dropped', chooseTargets({ orbit: ['node-x'], pubKeys: {} }).length === 0);

// --- the "unchanged" memory must notice a new seat key --------------------
// 2026-09-13: after a Q rotation both holders kept their role and saw the same
// orbit, so packSeat's role+targets signature matched and neither re-packed.
// The coordinator had dropped the old packs at cutover; 341 WART sat sole-copy.
{
  const { packSeat, resetPackCache } = await import('../src/lib/preshareClient.js');
  resetPackCache();
  const posts = [];
  const post = async (action, body) => {
    posts.push({ action, body });
    return { ok: true };
  };
  const orbit = [...m.map((x) => x.id), 'node-self', 'node-other'];
  const base = {
    post,
    prefix: 'pool3p',
    pool: 'wart',
    signerId: 'node-self',
    role: 1,
    record: { userShareHex: 'ef'.repeat(32), role: 1, scheme: 'wart-3p-ecdsa-lindell-v1' },
    orbit,
    orbitKeys: pubKeys,
    otherHolderId: 'node-other',
  };
  const P_a = '02' + '11'.repeat(32);
  const P_b = '02' + '22'.repeat(32);

  const first = await packSeat({ ...base, P: P_a });
  check('first pack for a seat is posted', first.packed && !first.unchanged && posts.length === 1);
  const again = await packSeat({ ...base, P: P_a });
  check('same seat, same orbit: not re-posted', again.unchanged === true && posts.length === 1);
  const rotated = await packSeat({ ...base, P: P_b });
  check(
    'a new seat key re-packs even with the same orbit',
    rotated.packed && !rotated.unchanged && posts.length === 2,
    'this is the post-cutover case that used to be skipped',
  );
  const dropped = await packSeat({ ...base, P: P_b, coordinatorHasPack: false });
  check(
    'coordinator reporting no pack overrides the local memory',
    dropped.packed && !dropped.unchanged && posts.length === 3,
  );
  const held = await packSeat({ ...base, P: P_b, coordinatorHasPack: true });
  check('coordinator holding the pack keeps it unchanged', held.unchanged === true && posts.length === 3);
  check(
    'the pack AAD names the new seat key',
    String(posts[1].body.pack.aad || '').toLowerCase().includes(`p=${P_b}`),
  );
}

// --- live pack and incoming pack are different seats ---------------------
// Rotation waits until the next P is sealed. Remembering the live pack must
// not suppress that post, and a denylisted / wrong-network peer must not be
// a target: the sweep gate does not count them.
{
  const { packSeat, resetPackCache } = await import('../src/lib/preshareClient.js');
  const { nextPackPlan, excludeIdsForPack } = await import('../src/lib/nextPack.js');
  resetPackCache();
  const posts = [];
  const post = async () => {
    posts.push(1);
    return { ok: true };
  };
  const orbit = ['node-self', 'node-other', 'node-ok', 'node-official', 'node-8c92950a-dead'];
  const orbitKeys = {
    'node-ok': pubKeys['node-a'],
    'node-official': pubKeys['node-b'],
    'node-8c92950a-dead': pubKeys['node-c'],
    'node-spare': pubKeys['node-d'],
  };
  const base = {
    post,
    prefix: 'pool3p',
    pool: 'wart',
    signerId: 'node-self',
    role: 1,
    record: { userShareHex: 'ab'.repeat(32), role: 1 },
    orbit: [...orbit, 'node-spare'],
    orbitKeys,
    otherHolderId: 'node-other',
    exclude: ['node-official', 'node-8c92950a-dead'],
  };
  const liveP = '02' + '33'.repeat(32);
  const nextP = '02' + '44'.repeat(32);
  const live = await packSeat({ ...base, P: liveP, slot: 'live' });
  check('live pack posts once', live.packed && !live.unchanged && posts.length === 1);
  const again = await packSeat({ ...base, P: liveP, slot: 'live' });
  check('live pack is remembered on its own', again.unchanged === true && posts.length === 1);
  const incoming = await packSeat({ ...base, P: nextP, slot: 'next' });
  check(
    'incoming seat posts even when the live pack is unchanged',
    incoming.packed && !incoming.unchanged && incoming.slot === 'next' && posts.length === 2,
  );
  check(
    'excluded peers are not sealed to',
    !incoming.targets.includes('node-official') && !incoming.targets.includes('node-8c92950a-dead'),
  );
  check('an eligible spare is sealed to', incoming.targets.includes('node-ok') && incoming.targets.includes('node-spare'));

  const st = {
    rotation: {
      phase: 'next_ready',
      next: {
        address: 'aa'.repeat(24),
        bornBy: { 1: 'node-self', 2: 'node-other' },
      },
    },
    packs: { 1: { next: null } },
    seatDenylist: ['alabama-', 'node-8c92950a'],
    seatRequireNetwork: 'defi',
    orbit: {
      live: orbit,
      members: [
        { id: 'node-ok', network: 'defi' },
        { id: 'node-official', network: 'official1' },
        { id: 'node-8c92950a-dead', network: 'defi' },
        { id: 'node-quiet', network: null },
      ],
    },
  };
  const dropped = excludeIdsForPack(st);
  check('wrong network is excluded', dropped.includes('node-official'));
  check('denylist is excluded even on the right network', dropped.includes('node-8c92950a-dead'));
  check('unknown network stays eligible', !dropped.includes('node-quiet') && !dropped.includes('node-ok'));
  const plan = nextPackPlan(st, {
    signerId: 'node-self',
    role: 1,
    cached: { userShareHex: 'cd'.repeat(32), P: nextP, poolAddress: 'aa'.repeat(24), signerId: 'node-self' },
  });
  check('next_ready plans a pack for the dealer', plan && plan.P === nextP && plan.coordinatorHasPack === null);
  check('plan excludes the peers the gate ignores', plan.exclude.includes('node-official') && plan.exclude.includes('node-8c92950a-dead'));
  const idle = nextPackPlan({ ...st, rotation: { ...st.rotation, phase: 'idle' } }, {
    signerId: 'node-self',
    role: 1,
    cached: { userShareHex: 'cd'.repeat(32), P: nextP, signerId: 'node-self' },
  });
  check('idle rotation does not ask for a next pack', idle === null);
  const stranger = nextPackPlan(st, {
    signerId: 'node-ok',
    role: 1,
    cached: { userShareHex: 'cd'.repeat(32), P: nextP, poolAddress: 'aa'.repeat(24), signerId: 'node-ok' },
  });
  check('a tab that did not birth the seat does not pack it', stranger === null);
}

console.log(failures ? `\n${failures} failing case(s)` : '\nall cases passed');
process.exit(failures ? 1 : 0);
