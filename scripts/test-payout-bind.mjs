/**
 * Payout hardening: Warthog transfer hash, pin/fee/nonce binding,
 * lab-demo exemption default, and lagged validateOutput.
 *
 * Run: npm run test:payout
 */
import { createHash } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import {
  buildWartTransferHash,
  evaluatePayoutBinding,
  priorPayoutHash,
  priorPayoutTicket,
  rememberPayoutNonce,
  rememberPayoutTicket,
} from '../src/lib/payoutBind.js';
import {
  labExemptionsEnabled,
  laggedBlockTag,
  ticketNeedsNoticeProof,
  validateOutputOnL1,
} from '../src/lib/cartesiNoticeProof.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(Number(n) >>> 0);
  return b;
}
function u64be(n) {
  let x = BigInt(n);
  const b = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

const pin = '11'.repeat(32);
const to40 = 'aa'.repeat(20);
const to48 = to40 + 'bb'.repeat(4);
const fields = {
  pinHash: pin,
  pinHeight: 100,
  nonceId: 1,
  feeE8: 1n,
  toAddrHex: to48,
  wartE8: 500000000n,
};

const hash = buildWartTransferHash(fields);
const hash40 = buildWartTransferHash({ ...fields, toAddrHex: to40 });
check('48-hex and 40-hex destination hash the same', hash === hash40 && hash.length === 64, hash);

const laid = Buffer.concat([
  Buffer.from(pin, 'hex'),
  u32be(100),
  u32be(1),
  Buffer.alloc(3),
  u64be(1n),
  Buffer.from(to40, 'hex'),
  u64be(500000000n),
]);
const expect = createHash('sha256').update(laid).digest('hex');
check('hash matches a hand-laid sha256 preimage', hash === expect, `${hash} ≠ ${expect}`);
check(
  'noble sha256 of that preimage matches',
  Buffer.from(sha256(laid)).toString('hex') === expect,
);

const changed = buildWartTransferHash({ ...fields, wartE8: 500000001n });
check('a different amount is a different hash', changed !== hash);

const ok = evaluatePayoutBinding({
  toAddress: to48,
  amountE8: 500000000n,
  pinHash: '0x' + pin,
  pinHeight: 100,
  nonceId: 1,
  feeE8: '1',
  hashHex: '0x' + hash,
  localPinHash: pin,
});
check('matching notice, pin and hash passes', ok.ok === true, ok.reasons.join('; '));

const swapped = evaluatePayoutBinding({
  toAddress: 'cc'.repeat(20),
  amountE8: 500000000n,
  pinHash: pin,
  pinHeight: 100,
  nonceId: 1,
  feeE8: 1,
  hashHex: hash,
  localPinHash: pin,
});
check('destination swap fails', swapped.ok === false && swapped.reasons.some((r) => /payout hash/.test(r)));

const badPin = evaluatePayoutBinding({
  toAddress: to40,
  amountE8: 500000000n,
  pinHash: pin,
  pinHeight: 100,
  nonceId: 1,
  feeE8: 1,
  hashHex: hash,
  localPinHash: '22'.repeat(32),
});
check('foreign pin fails', badPin.ok === false && badPin.reasons.some((r) => /DeFi node/.test(r)));

const fatFee = evaluatePayoutBinding({
  toAddress: to40,
  amountE8: 500000000n,
  pinHash: pin,
  pinHeight: 100,
  nonceId: 1,
  feeE8: 1000001n,
  hashHex: buildWartTransferHash({ ...fields, feeE8: 1000001n, toAddrHex: to40 }),
  localPinHash: pin,
});
check('fee above 0.01 WART fails', fatFee.ok === false && fatFee.reasons.some((r) => /fee/.test(r)));

const store = {
  mem: new Map(),
  getItem(k) { return this.mem.has(k) ? this.mem.get(k) : null; },
  setItem(k, v) { this.mem.set(k, String(v)); },
};
const from = 'dd'.repeat(24);
check('unseen nonce has no prior hash', priorPayoutHash(from, 7, store) === null);
check('remember nonce', rememberPayoutNonce(from, 7, hash, store) === true);
check('same hash is remembered', priorPayoutHash(from, 7, store) === hash);
const replay = evaluatePayoutBinding({
  toAddress: to40,
  amountE8: 1n,
  pinHash: pin,
  pinHeight: 100,
  nonceId: 7,
  feeE8: 1,
  hashHex: buildWartTransferHash({ ...fields, nonceId: 7, wartE8: 1n, toAddrHex: to40 }),
  localPinHash: pin,
  priorHash: hash,
});
check('nonce reused for another payout fails', replay.ok === false && replay.reasons.some((r) => /nonce already signed/.test(r)));
check('same nonce and hash is not a replay', rememberPayoutNonce(from, 7, hash, store) === true);

const ticketId = 'wart-pool-9';
const ticketFields = {
  toAddress: to48,
  amountE8: 500000000n,
  pinHeight: 100,
  nonceId: 1,
  hashHex: hash,
};
check('unseen ticket has no binding', priorPayoutTicket(ticketId, store) === null);
check('remember ticket', rememberPayoutTicket(ticketId, ticketFields, store) === true);
check('same ticket binding is kept', rememberPayoutTicket(ticketId, ticketFields, store) === true);
const again = evaluatePayoutBinding({
  toAddress: to48,
  amountE8: 500000000n,
  pinHash: pin,
  pinHeight: 100,
  nonceId: 1,
  feeE8: 1,
  hashHex: hash,
  localPinHash: pin,
  priorTicket: priorPayoutTicket(ticketId, store),
});
check('same ticket and transfer passes', again.ok === true, again.reasons.join('; '));
const refreshedHash = buildWartTransferHash({ ...fields, pinHeight: 101, nonceId: 1 });
const refreshed = evaluatePayoutBinding({
  toAddress: to48,
  amountE8: 500000000n,
  pinHash: pin,
  pinHeight: 101,
  nonceId: 1,
  feeE8: 1,
  hashHex: refreshedHash,
  localPinHash: pin,
  priorHash: hash,
  priorTicket: priorPayoutTicket(ticketId, store),
});
check(
  'same payment at a new pin is a refresh',
  refreshed.ok === true && refreshed.pinRefresh === true,
  refreshed.reasons.join('; '),
);
check(
  'refresh replaces the ticket pin',
  rememberPayoutTicket(ticketId, { ...ticketFields, pinHeight: 101, hashHex: refreshedHash }, store) === true
    && priorPayoutTicket(ticketId, store).pinHeight === 101,
);
check(
  'refresh replaces the nonce hash',
  rememberPayoutNonce(from, 1, refreshedHash, store, { replace: true }) === true
    && priorPayoutHash(from, 1, store) === refreshedHash,
);
const newPin = evaluatePayoutBinding({
  toAddress: to48,
  amountE8: 500000000n,
  pinHash: pin,
  pinHeight: 101,
  nonceId: 2,
  feeE8: 1,
  hashHex: buildWartTransferHash({ ...fields, pinHeight: 101, nonceId: 2 }),
  localPinHash: pin,
  priorTicket: priorPayoutTicket(ticketId, store),
});
check(
  'same ticket at a new pin and nonce fails',
  newPin.ok === false && newPin.reasons.some((r) => /ticket already bound/.test(r)),
);
check(
  'a different transfer does not overwrite the ticket',
  rememberPayoutTicket(ticketId, { ...ticketFields, nonceId: 2, pinHeight: 101 }, store) === false,
);

check('lab-demo needs a notice unless opted in', ticketNeedsNoticeProof('lab-demo-1') === true);
check('lab exemptions default off', labExemptionsEnabled() === false);
check('rotate sweep still has no burn notice', ticketNeedsNoticeProof('wart-pool-rotate-1') === false);
check('user ticket needs a notice', ticketNeedsNoticeProof('wart-pool-9') === true);

check('lagged tag 100 behind 3 is 0x61', laggedBlockTag(100, 3) === '0x61');
check('lagged tag refuses a short chain', laggedBlockTag(2, 3) === null);

{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === 'eth_chainId') return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x7a69' }) };
    if (body.method === 'eth_blockNumber') return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x64' }) };
    if (body.method === 'eth_call') return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) };
    return { json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'unexpected' } }) };
  };
  const proof = { outputIndex: 1, outputHashesSiblings: ['11'.repeat(32)] };
  const raw = '0x' + 'ab'.repeat(40);
  try {
    const res = await validateOutputOnL1({
      rawDataHex: raw,
      proof,
      app: '0x' + 'cd'.repeat(20),
      rpcUrl: 'http://l1',
      confirmations: 3,
      chainId: 31337,
    });
    check('lagged validateOutput accepts a non-reverting call', res.ok === true, JSON.stringify(res));
    const call = calls.find((c) => c.method === 'eth_call');
    check('eth_call uses the block 3 behind the tip', call?.params?.[1] === '0x61', call?.params?.[1]);
    calls.length = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      if (body.method === 'eth_chainId') return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) };
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) };
    };
    const wrong = await validateOutputOnL1({
      rawDataHex: raw,
      proof,
      app: '0x' + 'cd'.repeat(20),
      rpcUrl: 'http://l1',
      confirmations: 3,
      chainId: 31337,
    });
    check('wrong chain id refuses before the proof call', wrong.ok === false && /chain id/.test(wrong.error) && !calls.includes('eth_call'), wrong.error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

try {
  const { buildWartTransferHash: coordinatorHash } = await import(
    '../../../Cartesi/cartesi-bridge-frontend/src/utils/twoPartyEcdsa.js'
  );
  const other = String(coordinatorHash({ ...fields, feeE8: 1, wartE8: 500000000 })).replace(/^0x/i, '');
  check('matches the coordinator transfer hash', other === hash, `${other} ≠ ${hash}`);
} catch (e) {
  failed += 1;
  console.log(`FAIL coordinator hash import — ${e?.message || e}`);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\npayout bind ok');
