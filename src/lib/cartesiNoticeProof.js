/**
 * Cartesi CLI 1.5 notice proof: GraphQL OutputValidityProof + Application.validateNotice.
 * Signers call L1 themselves — /api/pool JSON is not the attestation.
 */
import { keccak_256 } from '@noble/hashes/sha3';

export const CARTESI_L1_RPC = 'https://cartesi-bridge.duckdns.org/rpc';
export const CARTESI_DAPP = '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e';

const VALIDATE_NOTICE_ABI =
  'validateNotice(bytes,((uint64,uint64,bytes32,bytes32,bytes32,bytes32,bytes32[],bytes32[]),bytes))';

export const NOTICE_PROOF_GQL = `
  index
  payload
  input { index }
  proof {
    context
    validity {
      inputIndexWithinEpoch
      outputIndexWithinInput
      outputHashesRootHash
      vouchersEpochRootHash
      noticesEpochRootHash
      machineStateHash
      outputHashInOutputHashesSiblings
      outputHashesInEpochSiblings
    }
  }
`;

function keccakHex(bytes) {
  const out = keccak_256(bytes);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function validateNoticeSelector() {
  return '0x' + keccakHex(new TextEncoder().encode(VALIDATE_NOTICE_ABI)).slice(0, 8);
}

function hexToBytes(hex) {
  const h = String(hex || '').replace(/^0x/i, '');
  if (h.length % 2) throw new Error('odd hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pad32(hex) {
  return String(hex || '')
    .replace(/^0x/i, '')
    .padStart(64, '0');
}

function word(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

function encodeBytes(hex) {
  const h = String(hex || '').replace(/^0x/i, '');
  const even = h.length % 2 ? '0' + h : h;
  const len = even.length / 2;
  const pad = (64 - (even.length % 64)) % 64;
  return word(len) + even + '0'.repeat(pad);
}

function encodeBytes32Array(arr) {
  const list = arr || [];
  let out = word(list.length);
  for (const x of list) out += pad32(x);
  return out;
}

/** OutputValidityProof ABI (dynamic because of the two sibling arrays). */
function encodeValidity(v) {
  const headStatic = [
    word(v.inputIndexWithinEpoch),
    word(v.outputIndexWithinInput),
    pad32(v.outputHashesRootHash),
    pad32(v.vouchersEpochRootHash),
    pad32(v.noticesEpochRootHash),
    pad32(v.machineStateHash),
  ].join('');
  // two dynamic arrays: offsets from start of this struct
  const headDynOff = 8 * 32;
  const arr1 = encodeBytes32Array(v.outputHashInOutputHashesSiblings);
  const arr2 = encodeBytes32Array(v.outputHashesInEpochSiblings);
  const off1 = headDynOff;
  const off2 = headDynOff + arr1.length / 2;
  return headStatic + word(off1) + word(off2) + arr1 + arr2;
}

/** Proof = (validity, context). Both members dynamic. */
function encodeProof(proof) {
  const v = proof.validity;
  const validityEnc = encodeValidity(v);
  const ctx = proof.context?.startsWith?.('0x') ? proof.context : `0x${proof.context || ''}`;
  const contextEnc = encodeBytes(ctx);
  const offValidity = 64;
  const offContext = 64 + validityEnc.length / 2;
  return word(offValidity) + word(offContext) + validityEnc + contextEnc;
}

export function encodeValidateNoticeCall(payloadHex, proof) {
  const noticeEnc = encodeBytes(payloadHex);
  const proofEnc = encodeProof(proof);
  const offNotice = 64;
  const offProof = 64 + noticeEnc.length / 2;
  return (
    validateNoticeSelector() +
    word(offNotice) +
    word(offProof) +
    noticeEnc +
    proofEnc
  );
}

export function noticeHasProof(proof) {
  const v = proof?.validity;
  if (!v?.outputHashesRootHash || !v?.noticesEpochRootHash || !v?.machineStateHash) {
    return false;
  }
  return (
    Array.isArray(v.outputHashInOutputHashesSiblings) &&
    v.outputHashInOutputHashesSiblings.length > 0 &&
    Array.isArray(v.outputHashesInEpochSiblings) &&
    v.outputHashesInEpochSiblings.length > 0
  );
}

export async function validateNoticeOnL1({
  payloadHex,
  proof,
  rpcUrl = CARTESI_L1_RPC,
  dapp = CARTESI_DAPP,
} = {}) {
  if (!noticeHasProof(proof)) {
    return { ok: false, waiting: true, error: 'waiting for Cartesi notice proof (epoch not claimed)' };
  }
  const data = encodeValidateNoticeCall(payloadHex, proof);
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: dapp, data }, 'latest'],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    return { ok: false, waiting: false, error: body.error.message || 'validateNotice rpc error' };
  }
  const raw = String(body.result || '');
  const ok = /^0x0*1$/.test(raw);
  if (!ok) {
    return { ok: false, waiting: false, error: 'validateNotice returned false' };
  }
  return { ok: true, dapp, rpcUrl };
}

/* ------------------------------------------------------------------------ */
/* Rollups v2 (rollups-node 2.x, @cartesi/rollups 2.x contracts)             */
/*                                                                          */
/* An output's `raw_data` is the ABI-encoded Outputs.Notice(bytes) /        */
/* Outputs.Voucher(address,uint256,bytes) call; the proof is                */
/* (uint64 outputIndex, bytes32[] outputHashesSiblings) and exists only once */
/* the epoch's claim is accepted. Application.validateOutput(bytes,proof)   */
/* is a view that reverts on a bad proof and returns nothing on success.    */
/* ------------------------------------------------------------------------ */

function selectorOf(signature) {
  return '0x' + keccakHex(new TextEncoder().encode(signature)).slice(0, 8);
}

export const NOTICE_SIGNATURE = 'Notice(bytes)';
export const VOUCHER_SIGNATURE = 'Voucher(address,uint256,bytes)';
export const DELEGATE_CALL_VOUCHER_SIGNATURE = 'DelegateCallVoucher(address,bytes)';
export const VALIDATE_OUTPUT_ABI = 'validateOutput(bytes,(uint64,bytes32[]))';

export const NOTICE_SELECTOR = selectorOf(NOTICE_SIGNATURE);
export const VOUCHER_SELECTOR = selectorOf(VOUCHER_SIGNATURE);
export const DELEGATE_CALL_VOUCHER_SELECTOR = selectorOf(DELEGATE_CALL_VOUCHER_SIGNATURE);

export function validateOutputSelector() {
  return selectorOf(VALIDATE_OUTPUT_ABI);
}

function stripHex(hex) {
  return String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/** Outputs.Notice(bytes) raw_data → notice payload hex ('0x…'). null if not a Notice. */
export function decodeNoticeRawData(rawDataHex) {
  const h = stripHex(rawDataHex);
  if (h.length < 8 + 64 + 64) return null;
  if ('0x' + h.slice(0, 8) !== NOTICE_SELECTOR) return null;
  const body = h.slice(8);
  const offset = Number(BigInt('0x' + body.slice(0, 64)));
  if (!Number.isFinite(offset) || offset * 2 + 64 > body.length) return null;
  const lenPos = offset * 2;
  const len = Number(BigInt('0x' + body.slice(lenPos, lenPos + 64)));
  const start = lenPos + 64;
  if (start + len * 2 > body.length) return null;
  return '0x' + body.slice(start, start + len * 2);
}

/** Wrap a notice payload back into Outputs.Notice(bytes) raw_data. */
export function encodeNoticeRawData(payloadHex) {
  return NOTICE_SELECTOR + word(32) + encodeBytes(payloadHex);
}

export function outputHasProof(proof) {
  if (!proof) return false;
  if (proof.outputIndex == null) return false;
  const sib = proof.outputHashesSiblings;
  return Array.isArray(sib) && sib.length > 0 && sib.every((s) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(s)));
}

/**
 * calldata for Application.validateOutput(bytes output, OutputValidityProof proof).
 * Both arguments are dynamic (bytes; a struct containing a bytes32[]), so the
 * head is two offsets. Inside the struct the head is (uint64, offset to the
 * array) and the array follows the struct head.
 */
export function encodeValidateOutputCall(rawDataHex, proof) {
  const outputEnc = encodeBytes(rawDataHex);
  const siblings = encodeBytes32Array(proof?.outputHashesSiblings || []);
  // struct head: outputIndex, offset(array) = 2 words
  const proofEnc = word(proof?.outputIndex ?? 0) + word(2 * 32) + siblings;
  const offOutput = 64;
  const offProof = 64 + outputEnc.length / 2;
  return validateOutputSelector() + word(offOutput) + word(offProof) + outputEnc + proofEnc;
}

/**
 * eth_call Application.validateOutput. Success = the call does not revert
 * (result is `0x`). A revert / JSON-RPC error = proof rejected.
 */
export async function validateOutputOnL1({ rawDataHex, proof, app, rpcUrl = CARTESI_L1_RPC } = {}) {
  if (!outputHasProof(proof)) {
    return { ok: false, waiting: true, error: 'waiting for epoch claim (v2)' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(app || ''))) {
    return { ok: false, waiting: false, error: 'rollups v2 app address missing' };
  }
  if (!stripHex(rawDataHex)) {
    return { ok: false, waiting: false, error: 'output raw_data missing' };
  }
  const data = encodeValidateOutputCall(rawDataHex, proof);
  let body;
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: app, data }, 'latest'],
      }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, waiting: false, error: e?.message || 'validateOutput rpc failed' };
  }
  if (body.error) {
    return {
      ok: false,
      waiting: false,
      error: `validateOutput reverted: ${body.error.message || 'rpc error'}`,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
    return { ok: false, waiting: false, error: 'validateOutput: empty rpc response' };
  }
  // A view with no return value yields `0x`; anything else is not a success path.
  const raw = String(body.result ?? '');
  if (raw !== '0x' && raw !== '') {
    return { ok: false, waiting: false, error: `validateOutput unexpected result ${raw.slice(0, 20)}` };
  }
  return { ok: true, app, rpcUrl, api: 'v2' };
}

export function ticketNeedsNoticeProof(ticketId, { labDemo } = {}) {
  const id = String(ticketId || '');
  if (!id) return false;
  if (labDemo || /^lab-demo-/.test(id)) return false;
  if (/^wart-pool-rotate-/.test(id)) return false;
  return true;
}
