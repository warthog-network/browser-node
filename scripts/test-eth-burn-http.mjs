/**
 * ETH redeem HTTP cover: a missing DeFi node may use /transaction/lookup.
 * A running node that already failed must not be replaced by that lookup.
 *
 * Run: npm run test:eth-burn
 */
const { assertEthBurnTx, flattenWartLookup, httpCoverForSkippedEthBurn } = await import(
  '../src/lib/localWartChain.js'
);

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

const ticket = {
  wartTxHash: '219bd2beba6e466eeaa813633a3dcecacf6e4cdfabe6e62870b634abcd50fb7b',
  amountE8: '4900000',
  burnerWart: '0571344c03ee99b9849a6c855619e8f27710a6aef2b36e23',
  assetHash: '5c909c1f99f0888aa4560ac94a4b2aa9efaa20a56c695e23dcdb2e899e8d4677',
};

const httpBody = {
  code: 0,
  data: {
    transaction: {
      data: {
        toAddress: '0ff78d07d34e708356a54b94f832946e19c35df82259174a',
        amount: { str: '0.04900000', u64: 4900000, decimals: 8 },
        asset: {
          hash: ticket.assetHash,
          name: 'WETH',
        },
      },
      hash: ticket.wartTxHash,
      signedCommon: { originAddress: ticket.burnerWart },
    },
    type: 'tokenTransfer',
    confirmations: 1695,
  },
};

const flat = flattenWartLookup(httpBody.data);
check(
  'unwrapped lookup flattens burn bin, amount, burner, asset',
  flat.txHash === ticket.wartTxHash &&
    flat.toAddress === '0ff78d07d34e708356a54b94f832946e19c35df82259174a' &&
    flat.amountE8 === '4900000' &&
    flat.fromAddress === ticket.burnerWart &&
    flat.assetHash === ticket.assetHash &&
    flat.confirmations === 1695,
  JSON.stringify(flat),
);

const wrapped = flattenWartLookup(httpBody);
check(
  'code/data envelope is not the burn body',
  wrapped.toAddress !== flat.toAddress || wrapped.amountE8 !== flat.amountE8,
);

try {
  assertEthBurnTx(flat, ticket);
  check('assertEthBurnTx accepts the HTTP burn', true);
} catch (e) {
  check('assertEthBurnTx accepts the HTTP burn', false, e.message);
}

const skipped = {
  ok: false,
  skipped: true,
  source: null,
  reasons: ['DeFi WASM node not running — start the full node to sign'],
};
const covered = httpCoverForSkippedEthBurn(skipped, flat, ticket);
check(
  'skipped node is covered by HTTP',
  covered.ok === true && covered.skipped === false && covered.source === 'defi-http',
  JSON.stringify({ ok: covered.ok, skipped: covered.skipped, source: covered.source }),
);

const failed = {
  ok: false,
  skipped: false,
  source: 'local-wasm',
  reasons: ['local WASM is not synced'],
};
const stayed = httpCoverForSkippedEthBurn(failed, flat, ticket);
check('running node failure is not HTTP-covered', stayed === failed);

try {
  httpCoverForSkippedEthBurn(skipped, { ...flat, amountE8: '1' }, ticket);
  check('wrong amount still refuses', false);
} catch (e) {
  check('wrong amount still refuses', /4900000/.test(e.message), e.message);
}

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\neth burn HTTP cover ok');
