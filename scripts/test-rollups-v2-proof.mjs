/**
 * Rollups v2 proof helpers (rollups-node 2.x / @cartesi/rollups 2.x):
 *  - output selectors equal keccak256(signature)[:4]
 *  - Outputs.Notice(bytes) raw_data encode/decode round-trips
 *  - validateOutput(bytes,(uint64,bytes32[])) calldata matches a hand-laid ABI
 *    layout for a fixed small proof
 *  - proof presence and the L1 result mapping (0x = ok, error = rejected,
 *    null proof = waiting)
 *
 * Run: npm run test:rollups-v2
 */
import { keccak_256 } from '@noble/hashes/sha3';
import {
  DELEGATE_CALL_VOUCHER_SELECTOR,
  NOTICE_SELECTOR,
  VOUCHER_SELECTOR,
  decodeNoticeRawData,
  encodeNoticeRawData,
  encodeValidateOutputCall,
  outputHasProof,
  validateOutputOnL1,
  validateOutputSelector,
} from '../src/lib/cartesiNoticeProof.js';
import { normalizeRollups, normalizeSnapshotNotice } from '../src/lib/poolVerify.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function keccakSel(sig) {
  return (
    '0x' +
    [...keccak_256(new TextEncoder().encode(sig))]
      .slice(0, 4)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// --- selectors -------------------------------------------------------------
check('Notice(bytes) selector = keccak', NOTICE_SELECTOR === keccakSel('Notice(bytes)'), NOTICE_SELECTOR);
check(
  'Voucher(address,uint256,bytes) selector = keccak',
  VOUCHER_SELECTOR === keccakSel('Voucher(address,uint256,bytes)'),
  VOUCHER_SELECTOR,
);
check(
  'DelegateCallVoucher(address,bytes) selector = keccak',
  DELEGATE_CALL_VOUCHER_SELECTOR === keccakSel('DelegateCallVoucher(address,bytes)'),
);
check(
  'validateOutput(bytes,(uint64,bytes32[])) selector = keccak',
  validateOutputSelector() === keccakSel('validateOutput(bytes,(uint64,bytes32[]))'),
  validateOutputSelector(),
);
// Known values from the 2.x Outputs library (regression pins).
check('Notice selector is 0xc258d6e5', NOTICE_SELECTOR === '0xc258d6e5', NOTICE_SELECTOR);
check('Voucher selector is 0x237a816f', VOUCHER_SELECTOR === '0x237a816f', VOUCHER_SELECTOR);

// --- Notice raw_data round trip --------------------------------------------
const payload = '0x' + Buffer.from(JSON.stringify({ type: 'pool_release_ticket', ticketId: 'wart-pool-0:9' })).toString('hex');
const raw = encodeNoticeRawData(payload);
check('raw_data starts with Notice selector', raw.startsWith(NOTICE_SELECTOR));
check('raw_data offset word is 0x20', raw.slice(10, 10 + 64) === word(32));
check('decodeNoticeRawData round-trips', decodeNoticeRawData(raw) === payload, decodeNoticeRawData(raw));
check('decodeNoticeRawData rejects a voucher', decodeNoticeRawData(VOUCHER_SELECTOR + word(32) + word(0)) === null);
check('decodeNoticeRawData handles missing 0x', decodeNoticeRawData(raw.slice(2)) === payload);
// 33-byte payload → padding to 64 bytes
const odd = '0x' + 'ab'.repeat(33);
const rawOdd = encodeNoticeRawData(odd);
check('33-byte payload pads to a word boundary', (rawOdd.length - 10) / 2 === 32 + 32 + 64);
check('33-byte payload decodes', decodeNoticeRawData(rawOdd) === odd);

// --- validateOutput calldata, hand-laid --------------------------------------
// output = 3 bytes 0x010203 ; proof = (outputIndex 7, siblings [s1, s2])
const s1 = '0x' + '11'.repeat(32);
const s2 = '0x' + '22'.repeat(32);
const out = '0x010203';
const call = encodeValidateOutputCall(out, { outputIndex: 7, outputHashesSiblings: [s1, s2] });
const expected =
  validateOutputSelector() +
  word(0x40) + // offset of bytes output (after 2 head words)
  word(0x40 + 0x20 + 0x20) + // offset of proof struct = 0x40 + len word + 1 padded word
  word(3) + // bytes length
  '010203' + '0'.repeat(58) + // 3 bytes padded to 32
  word(7) + // proof.outputIndex
  word(0x40) + // offset of siblings array within the struct (2 head words)
  word(2) + // array length
  '11'.repeat(32) +
  '22'.repeat(32);
check('validateOutput calldata matches hand layout', call === expected, `\n got ${call}\n exp ${expected}`);
check('calldata length = 4 + 9 words', (call.length - 2) / 2 === 4 + 9 * 32);

// empty siblings still encodes (length 0 array)
const callEmpty = encodeValidateOutputCall(out, { outputIndex: 0, outputHashesSiblings: [] });
check('empty siblings → array length word 0', callEmpty.endsWith(word(0)));

// --- proof presence ---------------------------------------------------------
check('outputHasProof null → false', outputHasProof(null) === false);
check('outputHasProof empty siblings → false', outputHasProof({ outputIndex: 1, outputHashesSiblings: [] }) === false);
check('outputHasProof missing index → false', outputHasProof({ outputHashesSiblings: [s1] }) === false);
check('outputHasProof ok', outputHasProof({ outputIndex: 0, outputHashesSiblings: [s1] }) === true);
check('outputHasProof rejects junk sibling', outputHasProof({ outputIndex: 0, outputHashesSiblings: ['zz'] }) === false);

// --- L1 result mapping (fetch stubbed) ---------------------------------------
const app = '0x' + 'ab'.repeat(20);
const realFetch = globalThis.fetch;
async function withRpc(reply, fn) {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return { json: async () => reply };
  };
  try {
    return { res: await fn(), seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  const r = await validateOutputOnL1({ rawDataHex: raw, proof: null, app, rpcUrl: 'http://x' });
  check('null proof → waiting', r.ok === false && r.waiting === true);
}
{
  const { res, seen } = await withRpc({ jsonrpc: '2.0', id: 1, result: '0x' }, () =>
    validateOutputOnL1({ rawDataHex: raw, proof: { outputIndex: 7, outputHashesSiblings: [s1] }, app, rpcUrl: 'http://x' }),
  );
  check('0x result → ok', res.ok === true, JSON.stringify(res));
  check('eth_call to app with validateOutput calldata', seen.body.method === 'eth_call' && seen.body.params[0].to === app && seen.body.params[0].data.startsWith(validateOutputSelector()));
}
{
  const { res } = await withRpc({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }, () =>
    validateOutputOnL1({ rawDataHex: raw, proof: { outputIndex: 7, outputHashesSiblings: [s1] }, app, rpcUrl: 'http://x' }),
  );
  check('revert → ok:false, not waiting', res.ok === false && res.waiting === false && /reverted/.test(res.error), res.error);
}
{
  const r = await validateOutputOnL1({ rawDataHex: raw, proof: { outputIndex: 7, outputHashesSiblings: [s1] }, app: 'nope', rpcUrl: 'http://x' });
  check('bad app address → error', r.ok === false && /app address/.test(r.error));
}

// --- coordinator rollups block + snapshot notice normalisation --------------
check('normalizeRollups ignores v1/absent', normalizeRollups(null) === null && normalizeRollups({ api: 'v1' }) === null);
check('normalizeRollups needs an app address', normalizeRollups({ api: 'v2' }) === null);
const nr = normalizeRollups({ api: 'v2', app, rpcUrl: 'https://h/v2/rpc/' });
check('normalizeRollups fills defaults + trims slash', nr.rpcUrl === 'https://h/v2/rpc' && /\/v2\/inspect$/.test(nr.inspectUrl) && /\/rpc$/.test(nr.l1RpcUrl));
const snapV2 = normalizeSnapshotNotice({ ticketId: 'wart-pool-0:9', index: 42, inputIndex: 5, rawData: raw, proof: { outputHashesSiblings: [s1] } });
check('snapshot v2 notice → _api v2, proof bound to index', snapV2._api === 'v2' && snapV2._proof.outputIndex === 42 && snapV2._hasProof === true && snapV2._payloadHex === payload);
const snapV1 = normalizeSnapshotNotice({ ticketId: 'x', _proof: { validity: {}, context: '0x' }, _payloadHex: payload });
check('snapshot v1 notice untouched', snapV1._api === undefined && snapV1._proof.validity);

console.log(failed ? `\n${failed} check(s) failed` : '\nall rollups v2 proof checks passed');
process.exit(failed ? 1 : 0);
