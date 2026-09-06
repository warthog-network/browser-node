/**
 * Independent Warthog view from the in-tab DeFi WASM node (virtual_get).
 *
 * Prefer this over VPS HTTPS (`warthog-defitestnet.duckdns.org`) whenever the
 * DeFi triad is running — that host is the same box as the SPV relayer.
 */
import { getWartNodeModule, rpcGet } from './browserRpc.js';

/** Nothing-up-my-sleeve ETH unwrap burn bin (poolEth3p ETH_BURN_BIN). */
export const ETH_BURN_BIN = '0ff78d07d34e708356a54b94f832946e19c35df82259174a';

export function runningNetworkId() {
  try {
    return window.__wartRunningNetworkId || null;
  } catch {
    return null;
  }
}

export function isLocalDefiNodeLive() {
  if (runningNetworkId() !== 'defi') return false;
  const mod = getWartNodeModule();
  return typeof mod?.virtual_get === 'function';
}

function unwrapRpc(j) {
  if (j && typeof j === 'object' && 'code' in j) {
    if (j.code !== 0 && j.code != null) {
      throw new Error(j.error || `rpc code ${j.code}`);
    }
    return j.data;
  }
  return j;
}

function normAddr(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function e8Of(v) {
  if (v == null) return 0n;
  if (typeof v === 'object') {
    const n = v.E8 ?? v.u64 ?? v.e8 ?? v.amountE8;
    if (n != null) return BigInt(String(n));
  }
  try {
    return BigInt(String(v));
  } catch {
    return 0n;
  }
}

export function flattenWartLookup(data) {
  if (!data) return null;
  const t = data.transaction || data;
  const nested = t.data || {};
  const common = t.signedCommon || t.signingData || {};
  const asset = nested.asset || {};
  const toAddress = normAddr(nested.toAddress || t.toAddress);
  const fromAddress = normAddr(
    common.originAddress || nested.fromAddress || t.fromAddress,
  );
  const txHash = String(t.hash || t.txHash || data.hash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const amountE8 = e8Of(
    nested.amount || nested.tokenAmount || nested.amountE8 || t.amountE8,
  );
  const assetHash = String(
    nested.tokenHash || nested.assetHash || asset.hash || nested.tokenId || '',
  )
    .replace(/^0x/i, '')
    .toLowerCase();
  return {
    txHash,
    fromAddress,
    toAddress,
    amountE8: amountE8.toString(),
    assetHash: assetHash || null,
    confirmations: Number(data.confirmations ?? t.confirmations ?? 0),
    blockHeight: data.mined?.block?.height ?? t.blockHeight ?? null,
    raw: data,
  };
}

export async function fetchLocalChainHead() {
  const data = unwrapRpc(await rpcGet('/chain/head'));
  const head = data?.chainHead || data;
  const height = Number(head?.height ?? head?.blockHeight);
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error('local /chain/head has no height');
  }
  return {
    height,
    hash: String(head.hash || head.blockHash || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    synced: data?.synced ?? head?.synced ?? null,
  };
}

function normHash(h) {
  return String(h || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

export function isExplicitlyUnsynced(v) {
  if (v === false || v === 0 || v === '0') return true;
  if (typeof v === 'string' && v.toLowerCase() === 'false') return true;
  return false;
}

/** Local canonical hash at height — used to prove SPV tip is an ancestor. */
export async function fetchLocalBlockHash(height) {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) throw new Error('block height required');
  const data = unwrapRpc(await rpcGet(`/chain/block/${h}/hash`));
  const hash = normHash(data?.hash || data?.header?.hash);
  if (!hash) throw new Error(`local block ${h} has no hash`);
  return hash;
}

/**
 * Local WASM must be at/after the machine SPV tip, on the same chain:
 * hash(local, spv.bestHeight) === spv.bestHash.
 */
export async function assertLocalAncestorOfSpv(head, spv) {
  if (!spv?.bootstrapped) {
    throw new Error('in-machine SPV is not bootstrapped');
  }
  const spvH = Number(spv.bestHeight || 0);
  const spvHash = normHash(spv.bestHash);
  if (!spvH || !spvHash) throw new Error('in-machine SPV has no tip');
  const localH = Number(head?.height || 0);
  if (localH < spvH) {
    throw new Error(`local WASM height ${localH} < SPV tip ${spvH}`);
  }
  const atSpv = await fetchLocalBlockHash(spvH);
  if (atSpv !== spvHash) {
    throw new Error(
      `local hash at SPV #${spvH} ${atSpv.slice(0, 12)}… ≠ SPV ${spvHash.slice(0, 12)}…`,
    );
  }
  return {
    localHeight: localH,
    spvHeight: spvH,
    ancestorHash: atSpv,
  };
}

async function requireSyncedAncestor(spv) {
  const head = await fetchLocalChainHead();
  const reasons = [];
  if (isExplicitlyUnsynced(head.synced)) {
    reasons.push('local WASM is not synced');
  }
  let ancestry = null;
  if (!spv) {
    reasons.push('SPV tip missing — cannot check local ancestry');
  } else {
    try {
      ancestry = await assertLocalAncestorOfSpv(head, spv);
    } catch (e) {
      reasons.push(e?.message || String(e));
    }
  }
  return { head, ancestry, reasons };
}

export async function lookupLocalTx(txHash) {
  const h = String(txHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('txHash required');
  const data = unwrapRpc(await rpcGet(`/transaction/lookup/${h}`));
  const flat = flattenWartLookup(data);
  if (!flat?.txHash) throw new Error('local lookup returned no tx');
  return flat;
}

export async function localWartBalanceE8(address) {
  const addr = normAddr(address);
  if (!/^[0-9a-f]{48}$/.test(addr)) throw new Error('wart address required');
  const data = unwrapRpc(await rpcGet(`/account/${addr}/wart_balance`));
  const bal = data?.balance || data;
  const total = e8Of(bal?.total ?? bal);
  const locked = e8Of(bal?.locked);
  const free = total > locked ? total - locked : 0n;
  return { total, locked, free };
}

export function assertPoolPayoutCovered(freeE8, amountE8) {
  const need = e8Of(amountE8);
  if (need <= 0n) throw new Error('ticket amount must be > 0');
  if (freeE8 < need) {
    throw new Error(
      `local Q free ${freeE8} E8 < ticket ${need} E8`,
    );
  }
  return true;
}

export function assertEthBurnTx(flat, {
  burnBin = ETH_BURN_BIN,
  amountE8,
  burnerWart,
  assetHash,
  minConf = 1,
} = {}) {
  if (!flat?.txHash) throw new Error('local lookup: no tx');
  const bin = normAddr(burnBin);
  if (normAddr(flat.toAddress) !== bin) {
    throw new Error(
      `local burn to ${flat.toAddress || '∅'} is not burn bin ${bin.slice(0, 12)}…`,
    );
  }
  if (amountE8 != null && e8Of(flat.amountE8) !== e8Of(amountE8)) {
    throw new Error(
      `local burn amount ${flat.amountE8} ≠ ticket ${amountE8}`,
    );
  }
  if (burnerWart && normAddr(flat.fromAddress) !== normAddr(burnerWart)) {
    throw new Error('local burn from-address is not the claimed burner');
  }
  if (assetHash) {
    const want = String(assetHash).replace(/^0x/i, '').toLowerCase();
    if (flat.assetHash && flat.assetHash !== want) {
      throw new Error('local burn asset hash does not match wrap');
    }
  }
  if (minConf > 0 && Number(flat.confirmations || 0) < minConf) {
    throw new Error(
      `local burn ${flat.txHash.slice(0, 12)}… confirmations ${flat.confirmations}/${minConf}`,
    );
  }
  return true;
}

/**
 * Path A payout / ETH unwrap local checks.
 * Fail-closed: DeFi WASM down is not ok (callers must not sign).
 */
export async function verifyLocalForPayout({
  poolAddress,
  amountE8,
  spv,
} = {}) {
  if (!isLocalDefiNodeLive()) {
    return {
      ok: false,
      skipped: true,
      source: null,
      reasons: ['DeFi WASM node not running — start the full node to sign'],
    };
  }
  let head = null;
  let ancestry = null;
  let balance = null;
  const reasons = [];
  try {
    const gate = await requireSyncedAncestor(spv);
    head = gate.head;
    ancestry = gate.ancestry;
    reasons.push(...gate.reasons);
  } catch (e) {
    reasons.push(e?.message || String(e));
    return { ok: false, skipped: false, source: 'local-wasm', reasons, head };
  }
  if (poolAddress && amountE8 != null) {
    try {
      balance = await localWartBalanceE8(poolAddress);
      assertPoolPayoutCovered(balance.free, amountE8);
    } catch (e) {
      reasons.push(e?.message || String(e));
    }
  }
  return {
    ok: reasons.length === 0,
    skipped: false,
    source: 'local-wasm',
    reasons,
    head,
    ancestry,
    balance,
  };
}

export async function verifyLocalEthBurn(ticket, { spv } = {}) {
  if (!isLocalDefiNodeLive()) {
    return {
      ok: false,
      skipped: true,
      source: null,
      reasons: ['DeFi WASM node not running — start the full node to sign'],
    };
  }
  let head = null;
  let ancestry = null;
  try {
    const gate = await requireSyncedAncestor(spv);
    head = gate.head;
    ancestry = gate.ancestry;
    if (gate.reasons.length) {
      return {
        ok: false,
        skipped: false,
        source: 'local-wasm',
        reasons: gate.reasons,
        head,
        ancestry,
      };
    }
  } catch (e) {
    return {
      ok: false,
      skipped: false,
      source: 'local-wasm',
      reasons: [e?.message || String(e)],
      head,
    };
  }
  const txHash = ticket?.wartTxHash || ticket?.burnTxHash;
  if (!txHash) {
    return {
      ok: false,
      skipped: false,
      source: 'local-wasm',
      reasons: ['no wartTxHash — cannot verify burn on local WASM'],
      head,
      ancestry,
    };
  }
  try {
    const flat = await lookupLocalTx(txHash);
    assertEthBurnTx(flat, {
      amountE8: ticket.amountE8,
      burnerWart: ticket.burnerWart,
      assetHash: ticket.assetHash,
    });
    return { ok: true, skipped: false, source: 'local-wasm', tx: flat, head, ancestry };
  } catch (e) {
    return {
      ok: false,
      skipped: false,
      source: 'local-wasm',
      reasons: [e?.message || String(e)],
      head,
      ancestry,
    };
  }
}
