/**
 * In-tab JSON-RPC against the running WASM full node.
 *
 * Full notes: docs/TRANSACTIONS.md
 *
 * Native HTTP `--rpc` is not available here. Use virtual_get / virtual_post
 * (or these helpers) after Start. Not a drop-in website-wallet node URL.
 */

/**
 * A hung node must not hang the caller. virtual_get/virtual_post resolve
 * inside the WASM worker; if that worker died (OOM, crashed pthread) the
 * promise never settles, and a signer tick awaiting it held its lock forever —
 * three WART signers went silent for an hour on 2026-09-08 while their ETH
 * signers in the same tabs kept beating.
 */
export const RPC_TIMEOUT_MS = 15000;

function withRpcTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`WASM node did not answer ${label} within ${RPC_TIMEOUT_MS}ms — node hung?`)),
      RPC_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** @returns {object|null} live Emscripten Module for the running node */
export function getWartNodeModule() {
  if (typeof window === 'undefined') return null;
  return window.wartNode || window.Module || null;
}

/**
 * GET-style virtual RPC (e.g. `/chain/head`, `/account/:addr/balance`).
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function rpcGet(path) {
  const mod = getWartNodeModule();
  if (!mod?.virtual_get) {
    throw new Error('WASM node not running (no virtual_get). Start the full node first.');
  }
  const p = String(path || '');
  if (!p.startsWith('/')) {
    throw new Error(`RPC path must start with / (got ${p})`);
  }
  return withRpcTimeout(mod.virtual_get(p), `GET ${p}`);
}

/**
 * POST-style virtual RPC (e.g. `/transaction/add` with JSON body string or object).
 * @param {string} path
 * @param {string|object} body
 * @returns {Promise<unknown>}
 */
export async function rpcPost(path, body) {
  const mod = getWartNodeModule();
  if (!mod?.virtual_post) {
    throw new Error('WASM node not running (no virtual_post). Start the full node first.');
  }
  const p = String(path || '');
  if (!p.startsWith('/')) {
    throw new Error(`RPC path must start with / (got ${p})`);
  }
  const data = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return withRpcTimeout(mod.virtual_post(p, data), `POST ${p}`);
}

/**
 * Submit a signed payment (same JSON as native POST /transaction/add).
 * Does not build or sign the tx — wallet / offline signer must produce the body.
 *
 * @param {object} payment — pinHeight, nonceId, toAddr, amount|amountE8, fee|feeE8, signature65
 * @returns {Promise<unknown>}
 */
export async function rpcAddTransaction(payment) {
  return rpcPost('/transaction/add', payment);
}
