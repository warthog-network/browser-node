/**
 * Bind a 3P payout to the transfer the signer intends to authorize.
 *
 * The ceremony hash is sha256 of the Warthog wartTransfer preimage
 * (pin, pin height, nonce, fee, destination account, amount). The signer
 * recomputes that hash from the notice destination and amount. The pin must
 * be a block hash this tab's DeFi node already has. A nonce this signer
 * already bound to a different payment is refused. The same destination,
 * amount, and nonce at a new pin is the same unpaid transfer: Warthog
 * accepts that nonce at the new pin, and a stale prepare has to be
 * replaced or the sweep can never be signed. A different destination,
 * amount, or nonce is still refused.
 */
import { sha256 } from '@noble/hashes/sha256';

/** 0.01 WART. Live pool fee is 1 E8. A larger fee is not a payout. */
export const MAX_PAYOUT_FEE_E8 = 1000000n;

const NONCE_KEY = 'wart.signer.payoutNonces';
const TICKET_KEY = 'wart.signer.payoutTickets';

function hexToBytes(hex) {
  const h = String(hex || '').replace(/^0x/i, '');
  if (h.length % 2) throw new Error('odd hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u32be(n) {
  const b = new Uint8Array(4);
  const v = Number(n) >>> 0;
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

function u64be(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n) throw new Error('negative integer');
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error('integer does not fit in 8 bytes');
  return b;
}

function concatBytes(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function normHex(h) {
  return String(h || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/** Account id only. The 4-byte checksum is not part of the transfer hash. */
export function normDest(to) {
  const h = normHex(to);
  if (h.length !== 40 && h.length !== 48) return '';
  return h.slice(0, 40);
}

/**
 * Same preimage as the coordinator's buildWartTransferHash.
 * Destination checksum bytes (hex past the first 40) are ignored.
 */
export function buildWartTransferHash({
  pinHash,
  pinHeight,
  nonceId,
  feeE8,
  toAddrHex,
  wartE8,
}) {
  const pin = hexToBytes(normHex(pinHash));
  if (pin.length !== 32) throw new Error('pinHash must be 32 bytes');
  const toRaw = normHex(toAddrHex);
  if (toRaw.length !== 40 && toRaw.length !== 48) {
    throw new Error('destination must be 40 or 48 hex chars');
  }
  const to = hexToBytes(toRaw.slice(0, 40));
  const binary = concatBytes(
    pin,
    u32be(pinHeight),
    u32be(nonceId),
    new Uint8Array(3),
    u64be(feeE8),
    to,
    u64be(wartE8),
  );
  return [...sha256(binary)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function e8(v) {
  if (v == null || v === '') throw new Error('amount missing');
  return BigInt(v);
}

function nonceKey(from, nonceId) {
  const addr = normHex(from);
  const n = Number(nonceId);
  if (!addr || !Number.isFinite(n)) return '';
  return `${addr}:${n}`;
}

function storeOf(storage) {
  if (storage) return storage;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* private mode */
  }
  return null;
}

function readMap(key, storage) {
  const s = storeOf(storage);
  if (!s) return {};
  try {
    const raw = s.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readNonces(storage) {
  return readMap(NONCE_KEY, storage);
}

export function priorPayoutHash(from, nonceId, storage) {
  const k = nonceKey(from, nonceId);
  if (!k) return null;
  const hit = readNonces(storage)[k];
  return hit ? normHex(hit) : null;
}

/**
 * Append-only unless `replace` is set. A pin refresh of the same payment
 * passes replace; a different payment must not overwrite the hash.
 */
export function rememberPayoutNonce(from, nonceId, hashHex, storage, opts) {
  const s = storeOf(storage);
  const k = nonceKey(from, nonceId);
  const next = normHex(hashHex);
  if (!s || !k || !/^[0-9a-f]{64}$/.test(next)) return false;
  const all = readNonces(storage);
  if (all[k] && all[k] !== next && !opts?.replace) return false;
  all[k] = next;
  s.setItem(NONCE_KEY, JSON.stringify(all));
  return true;
}

export function priorPayoutTicket(ticketId, storage) {
  const id = String(ticketId || '').trim();
  if (!id) return null;
  const hit = readMap(TICKET_KEY, storage)[id];
  if (!hit || typeof hit !== 'object') return null;
  const toAddress = normDest(hit.to);
  const hashHex = normHex(hit.hash);
  const pinHeight = Number(hit.pin);
  const nonceId = Number(hit.nonce);
  if (!toAddress || !/^[0-9a-f]{64}$/.test(hashHex)) return null;
  if (!Number.isFinite(pinHeight) || !Number.isFinite(nonceId)) return null;
  return {
    toAddress,
    amountE8: String(hit.amount),
    pinHeight,
    nonceId,
    hashHex,
  };
}

/**
 * One ticket, one payment. Destination, amount, and nonce are fixed.
 * A new pin for that same payment replaces the stored hash. A different
 * transfer is left untouched.
 */
export function rememberPayoutTicket(ticketId, fields, storage) {
  const s = storeOf(storage);
  const id = String(ticketId || '').trim();
  const to = normDest(fields?.toAddress);
  const hash = normHex(fields?.hashHex);
  const pin = Number(fields?.pinHeight);
  const nonce = Number(fields?.nonceId);
  let amount = null;
  try {
    amount = e8(fields?.amountE8).toString();
  } catch {
    amount = null;
  }
  if (!s || !id || !to || amount == null || !Number.isFinite(pin) || !Number.isFinite(nonce)) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) return false;
  const all = readMap(TICKET_KEY, storage);
  const prev = priorPayoutTicket(id, storage);
  if (prev) {
    const samePayment =
      prev.toAddress === to &&
      prev.amountE8 === amount &&
      prev.nonceId === nonce;
    if (!samePayment) return false;
    if (prev.pinHeight === pin && prev.hashHex === hash) return true;
  }
  all[id] = { to, amount, pin, nonce, hash };
  s.setItem(TICKET_KEY, JSON.stringify(all));
  return true;
}

/**
 * @returns {{ ok: boolean, hashHex: string|null, reasons: string[] }}
 */
export function evaluatePayoutBinding({
  toAddress,
  amountE8,
  pinHash,
  pinHeight,
  nonceId,
  feeE8,
  hashHex,
  localPinHash,
  priorHash = null,
  priorTicket = null,
} = {}) {
  const reasons = [];
  let recomputed = null;
  try {
    recomputed = buildWartTransferHash({
      pinHash,
      pinHeight,
      nonceId,
      feeE8,
      toAddrHex: toAddress,
      wartE8: amountE8,
    });
  } catch (e) {
    reasons.push(`payout hash: ${e?.message || e}`);
  }
  const want = normHex(hashHex);
  if (recomputed && recomputed !== want) {
    reasons.push('payout hash ≠ transfer of this destination, amount, nonce, fee and pin');
  }
  const pin = normHex(pinHash);
  const local = normHex(localPinHash);
  if (!local || local !== pin) {
    reasons.push('pin is not a block on this tab\'s DeFi node');
  }
  try {
    const fee = e8(feeE8);
    if (fee <= 0n || fee > MAX_PAYOUT_FEE_E8) {
      reasons.push(`fee ${fee} E8 is outside 1…${MAX_PAYOUT_FEE_E8}`);
    }
  } catch (e) {
    reasons.push(`payout fee: ${e?.message || e}`);
  }
  let pinRefresh = false;
  if (priorTicket && recomputed) {
    try {
      const samePayment =
        priorTicket.toAddress === normDest(toAddress) &&
        BigInt(priorTicket.amountE8) === e8(amountE8) &&
        Number(priorTicket.nonceId) === Number(nonceId);
      const samePin =
        Number(priorTicket.pinHeight) === Number(pinHeight) &&
        priorTicket.hashHex === recomputed;
      if (!samePayment) reasons.push('ticket already bound to a different payout');
      else if (!samePin) pinRefresh = true;
    } catch {
      reasons.push('ticket already bound to a different payout');
    }
  }
  if (priorHash && normHex(priorHash) !== recomputed && !pinRefresh) {
    reasons.push('nonce already signed for a different payout');
  }
  return { ok: reasons.length === 0, hashHex: recomputed, pinRefresh, reasons };
}
