/**
 * Parse `/account/:addr/wart_balance` the way HTTP and WASM virtual_get return it.
 *
 * The old reader looked at `data.balance.total` / `data.total` and treated the
 * live `{ wart: { total: { E8 } } }` shape as 0, so a synced DeFi tab refused
 * to offer d2 on a funded rotate sweep.
 *
 * Run: npm run test:balance
 */
const { parseWartBalanceE8, assertPoolPayoutCovered } = await import(
  '../src/lib/localWartChain.js'
);

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

const httpLive = {
  code: 0,
  data: {
    wart: {
      total: { str: '3.99999999', E8: 399999999 },
      locked: { str: '0', E8: 0 },
      mempool: { str: '0', E8: 0 },
    },
    account: {
      address: '03407e43ef967327769e33a05d524b7d523d004c21f6a2e0',
      accountId: 479,
    },
  },
};

const live = parseWartBalanceE8(httpLive);
check(
  'HTTP wart_balance: free is E8 not 0',
  live.free === 399999999n && live.total === 399999999n && live.locked === 0n,
  `got free=${live.free} total=${live.total}`,
);

const unwrapped = parseWartBalanceE8(httpLive.data);
check('already-unwrapped { wart } still works', unwrapped.free === 399999999n);

const emptyNext = parseWartBalanceE8({
  code: 0,
  data: {
    wart: {
      total: { str: '0', E8: 0 },
      locked: { str: '0', E8: 0 },
      mempool: { str: '0', E8: 0 },
    },
    account: null,
  },
});
check('empty next Q is actually 0', emptyNext.free === 0n);

const legacy = parseWartBalanceE8({
  code: 0,
  data: { total: { E8: 100 }, locked: { E8: 25 } },
});
check('legacy { total, locked } still works', legacy.free === 75n && legacy.total === 100n);

const nestedBalance = parseWartBalanceE8({
  balance: { total: { E8: 50 }, locked: { E8: 0 } },
});
check('legacy { balance: { total } } still works', nestedBalance.free === 50n);

const stringJson = parseWartBalanceE8(JSON.stringify(httpLive));
check('JSON string from virtual_get', stringJson.free === 399999999n);

try {
  assertPoolPayoutCovered(0n, 399989999, '03407e43ef967327769e33a05d524b7d523d004c21f6a2e0');
  check('underfunded throws', false);
} catch (e) {
  check(
    'underfunded names the Q prefix',
    /03407e43ef96/.test(e.message) && /399989999/.test(e.message),
    e.message,
  );
}

assertPoolPayoutCovered(399999999n, 399989999);
check('live Q covers rotate amount', true);

const { wasmSkipAllowsHttpCover } = await import('../src/lib/poolVerify.js');
check(
  'WASM-down + notice/inspect ok may use DeFi HTTP cover',
  wasmSkipAllowsHttpCover({ skipped: true }, true) === true,
);
check(
  'WASM-down without notice still fail-closed',
  wasmSkipAllowsHttpCover({ skipped: true }, false) === false,
);
check(
  'WASM running-but-failed does not fall through to HTTP',
  wasmSkipAllowsHttpCover({ skipped: false, ok: false }, true) === false,
);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
