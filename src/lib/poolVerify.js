import {
  NOTICE_PROOF_GQL,
  NOTICE_SELECTOR,
  VOUCHER_SELECTOR,
  decodeNoticeRawData,
  noticeHasProof,
  outputHasProof,
  ticketNeedsNoticeProof,
  validateNoticeOnL1,
  validateOutputOnL1,
} from './cartesiNoticeProof.js';
import {
  assertPoolPayoutCovered,
  fetchLocalChainHead,
  isLocalDefiNodeLive,
  parseWartBalanceE8,
  verifyLocalForPayout,
} from './localWartChain.js';

/**
 * Independent checks a pool signer must pass before handing over a share.
 *
 *   1. Cartesi inspect/pool — machine state + recent release tickets
 *   2. GraphQL notices — pool_release_ticket + Cartesi output proof
 *   3. Application.validateNotice on L1 — not /api/pool JSON, not inspect "authorized"
 *   4. This tab's DeFi WASM node — synced; SPV tip/checkpoint/pin + header
 *      window (hash + merkelroot / txs) equal on WASM; Q free ≥ ticket
 *
 * Inspect "authorized" is not an attestation. Epoch proof + validateNotice is.
 * WASM down / unsynced / fork vs SPV → do not sign. Lab-demo tickets skip the notice.
 */

export const ROLLUP_INSPECT =
  'https://cartesi-bridge.duckdns.org/rollup/inspect/pool';
export const ROLLUP_GRAPHQL = 'https://cartesi-bridge.duckdns.org/rollup/graphql';
export const WART_DEFI_RPC = 'https://warthog-defitestnet.duckdns.org';
export const WART_HEAD = `${WART_DEFI_RPC}/chain/head`;
export const VERIFY_SNAPSHOT =
  'https://cartesi-bridge.duckdns.org/api/pool?verifyTicket=';

export const MAX_SPV_LAG = 256;
export const MIN_SPV_LAG = -8;

/* ------------------------------------------------------------------------ */
/* Rollups API selection                                                     */
/*                                                                          */
/* The coordinator advertises which rollups stack it runs in every snapshot */
/* the signer already reads (`?verifyTicket=`, `pool3p_status`,             */
/* `eth3p_status`):                                                         */
/*   rollups: { api:'v2', app:'0x…', rpcUrl, inspectUrl, l1RpcUrl }         */
/* Absent, or api !== 'v2', means Cartesi 1.5 (GraphQL + validateNotice),   */
/* byte-for-byte today's behaviour. v2 = rollups-node 2.x: JSON-RPC reads   */
/* (`cartesi_listOutputs`), POST inspect, Application.validateOutput.       */
/* ------------------------------------------------------------------------ */

export const V2_DEFAULTS = {
  rpcUrl: 'https://cartesi-bridge.duckdns.org/v2/rpc',
  inspectUrl: 'https://cartesi-bridge.duckdns.org/v2/inspect',
  l1RpcUrl: 'https://cartesi-bridge.duckdns.org/rpc',
};

let rollupsInfo = null;

export function normalizeRollups(info) {
  if (!info || typeof info !== 'object') return null;
  if (String(info.api || '').toLowerCase() !== 'v2') return null;
  const app = String(info.app || info.appAddress || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(app)) return null;
  const trim = (u, d) => String(u || d).replace(/\/$/, '');
  return {
    api: 'v2',
    app,
    appName: info.appName || null,
    rpcUrl: trim(info.rpcUrl, V2_DEFAULTS.rpcUrl),
    inspectUrl: trim(info.inspectUrl, V2_DEFAULTS.inspectUrl),
    l1RpcUrl: trim(info.l1RpcUrl, V2_DEFAULTS.l1RpcUrl),
  };
}

/** Remember the coordinator's rollups block (any status/snapshot that carries one). */
export function noteRollupsInfo(info) {
  if (info === undefined) return rollupsInfo;
  rollupsInfo = normalizeRollups(info);
  return rollupsInfo;
}

export function currentRollups() {
  return rollupsInfo;
}

export function isRollupsV2() {
  return rollupsInfo?.api === 'v2';
}

function hexToUtf8(raw) {
  const s = String(raw || '');
  if (!s.startsWith('0x')) return s;
  const hex = s.slice(2);
  if (hex.length % 2 !== 0) return '';
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

export function normAddr(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

export function addrsMatch(a, b) {
  const na = normAddr(a);
  const nb = normAddr(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const a40 = na.length >= 40 ? na.slice(-40) : na;
  const b40 = nb.length >= 40 ? nb.slice(-40) : nb;
  return a40 === b40;
}

export function e8Match(a, b) {
  try {
    return BigInt(String(a || '0')) === BigInt(String(b || '0'));
  } catch {
    return false;
  }
}

export function decodeInspectBody(body) {
  if (!body || typeof body !== 'object') return null;
  for (const r of body.reports || []) {
    const txt = hexToUtf8(r?.payload);
    try {
      const obj = JSON.parse(txt);
      if (obj && typeof obj === 'object') {
        return {
          ...obj,
          processedInputCount: Number(body.processed_input_count ?? obj.processedInputCount ?? 0),
        };
      }
    } catch {
      /* next report */
    }
  }
  return null;
}

function parseNoticePayload(raw) {
  const txt = hexToUtf8(raw);
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export function extractWartHead(j) {
  const head =
    j?.data?.chainHead ||
    j?.chainHead ||
    j?.data ||
    j;
  if (!head || typeof head !== 'object') return null;
  const height = Number(head.height ?? head.blockHeight);
  if (!Number.isFinite(height) || height <= 0) return null;
  return {
    height,
    hash: String(head.hash || head.blockHash || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
  };
}

/** One hung inspect/GraphQL/rpc call must not stall the signer poll loop. */
export const FETCH_TIMEOUT_MS = 20000;

async function fetchJson(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', ...init, signal: ctl.signal });
  } catch (e) {
    const why = e?.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : e?.message || String(e);
    throw new Error(`${url}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${url} HTTP ${res.status}`);
  return body;
}

let inspectCache = { at: 0, value: null };
const INSPECT_TTL_MS = 15000;

export async function fetchInspectPool() {
  if (inspectCache.value && Date.now() - inspectCache.at < INSPECT_TTL_MS) {
    return inspectCache.value;
  }
  // Prefer the coordinator snapshot (server-cached) so many browser
  // signers do not lock Cartesi InspectState.
  try {
    const snap = await fetchJson(`${VERIFY_SNAPSHOT}1`);
    if (snap && Object.prototype.hasOwnProperty.call(snap, 'rollups')) noteRollupsInfo(snap.rollups);
    if (snap?.inspect?.pool?.ok) {
      const value = {
        source: 'pool-snapshot',
        raw: snap.inspect.raw || snap.inspect,
        pool: snap.inspect.pool,
        // Coordinator's read of the machine's replay state. A replaying
        // machine reports a ledger hours behind — nothing verified against it
        // is trustworthy, and a signer must say so rather than "no notice".
        machine: snap.machine || null,
      };
      inspectCache = { at: Date.now(), value };
      return value;
    }
  } catch {
    /* fall through to direct inspect */
  }
  const raw = isRollupsV2() ? await inspectV2('pool') : await fetchJson(ROLLUP_INSPECT);
  const pool = decodeInspectBody(raw);
  if (!pool?.ok) throw new Error('inspect/pool not ok');
  const value = { source: isRollupsV2() ? 'rollups-v2-inspect' : 'rollup-inspect', raw, pool };
  inspectCache = { at: Date.now(), value };
  return value;
}

/* ---- rollups v2 transport ------------------------------------------------ */

/** v2 inspect: POST {inspectUrl}/{app} with the payload as the body. */
async function inspectV2(payload) {
  const r = rollupsInfo;
  if (!r) throw new Error('rollups v2 not configured');
  return fetchJson(`${r.inspectUrl}/${r.app}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', accept: 'application/json' },
    body: String(payload ?? ''),
  });
}

/** v2 node JSON-RPC (`cartesi_*`, named params). */
async function rpcV2(method, params) {
  const r = rollupsInfo;
  if (!r) throw new Error('rollups v2 not configured');
  const body = await fetchJson(r.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { application: r.app, ...params } }),
  });
  if (body?.error) {
    throw new Error(`${method}: ${body.error.message || 'rpc error'}`);
  }
  return body?.result ?? null;
}

function toHexPayload(v) {
  const s = String(v || '');
  if (!s) return null;
  return s.startsWith('0x') ? s : `0x${s}`;
}

/** One `cartesi_listOutputs` row → signer notice row, or null if it is not the ticket. */
function noticeRowV2(row, ticketId) {
  const rawData = toHexPayload(row?.raw_data);
  const payloadHex = toHexPayload(row?.decoded_data?.payload) || decodeNoticeRawData(rawData);
  if (!payloadHex) return null;
  const obj = parseNoticePayload(payloadHex);
  if (!obj || obj.type !== 'pool_release_ticket') return null;
  if (String(obj.ticketId || '') !== String(ticketId)) return null;
  const idx = Number(row.index ?? 0);
  const siblings = Array.isArray(row.output_hashes_siblings) ? row.output_hashes_siblings : null;
  const proof = siblings && siblings.length ? { outputIndex: idx, outputHashesSiblings: siblings } : null;
  return {
    ...obj,
    _api: 'v2',
    _index: idx,
    _inputIndex: row.input_index != null ? Number(row.input_index) : null,
    _epochIndex: row.epoch_index != null ? Number(row.epoch_index) : null,
    _payloadHex: payloadHex,
    _rawDataHex: rawData,
    _proof: proof,
    _hasProof: outputHasProof(proof),
  };
}

const V2_PAGE = 100;

/**
 * v2 ticket → notice. With an input index (the burn's input) one filtered
 * call answers; without it, walk outputs newest-first, the way v1 walks
 * GraphQL notices. The proof rides on the row (siblings non-null once the
 * epoch claim is accepted) — no second query.
 */
async function fetchReleaseNoticeV2(ticketId, { inputIndex = null } = {}) {
  const id = String(ticketId || '').trim();
  let best = null;
  const hint = Number(inputIndex);
  if (Number.isFinite(hint) && hint >= 0) {
    const res = await rpcV2('cartesi_listOutputs', {
      input_index: hint,
      output_type: NOTICE_SELECTOR,
      limit: V2_PAGE,
    });
    for (const row of res?.data || []) {
      const n = noticeRowV2(row, id);
      if (n && (!best || n._index >= best._index)) best = n;
    }
  }
  if (!best) {
    for (let page = 0; page < 20; page++) {
      const res = await rpcV2('cartesi_listOutputs', {
        output_type: NOTICE_SELECTOR,
        descending: true,
        limit: V2_PAGE,
        offset: page * V2_PAGE,
      });
      const rows = res?.data || [];
      for (const row of rows) {
        const n = noticeRowV2(row, id);
        if (n && (!best || n._index >= best._index)) best = n;
      }
      if (best || rows.length < V2_PAGE) break;
    }
  }
  let voucherCount = 0;
  try {
    const v = await rpcV2('cartesi_listOutputs', {
      output_type: VOUCHER_SELECTOR,
      descending: true,
      limit: 20,
    });
    voucherCount = Math.min(20, Number(v?.pagination?.total_count ?? (v?.data || []).length));
  } catch {
    /* informational */
  }
  return { source: 'rollups-v2-rpc', notice: best, voucherCount };
}

/**
 * A coordinator snapshot notice can be v1-shaped (validity/context proof) or
 * v2-shaped. Accept both spellings and mark the row so the L1 step picks
 * validateOutput vs validateNotice.
 */
export function normalizeSnapshotNotice(n) {
  if (!n || typeof n !== 'object') return n;
  const rawData = n._rawDataHex || n.rawDataHex || n.rawData || null;
  const proof = n._proof || n.proof || null;
  const v2 = Boolean(rawData || proof?.outputHashesSiblings || n.api === 'v2' || n._api === 'v2');
  if (!v2) return n;
  const p = proof && proof.outputHashesSiblings
    ? { outputIndex: proof.outputIndex ?? n._index ?? n.index, outputHashesSiblings: proof.outputHashesSiblings }
    : null;
  return {
    ...n,
    _api: 'v2',
    _index: n._index ?? n.index ?? n.outputIndex ?? null,
    _inputIndex: n._inputIndex ?? n.inputIndex ?? null,
    _payloadHex: n._payloadHex || n.payloadHex || (rawData ? decodeNoticeRawData(rawData) : null),
    _rawDataHex: rawData ? toHexPayload(rawData) : null,
    _proof: p,
    _hasProof: outputHasProof(p),
  };
}

async function graphqlNoticesPage(cursor) {
  const after = cursor ? `, before: "${cursor}"` : '';
  // Payloads only — pulling OutputValidityProof for 100 header notices
  // times out the browser, so d1 never sees an already-claimed epoch.
  const query = `{ notices(last: 100${after}) { pageInfo { hasPreviousPage startCursor } edges { node { index payload input { index } } } } vouchers(last: 20) { edges { node { index destination payload } } } }`;
  return fetchJson(ROLLUP_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}

async function graphqlInputNoticeProof(inputIndex) {
  const idx = Number(inputIndex);
  if (!Number.isFinite(idx) || idx < 0) return null;
  const query = `{ input(index: ${idx}) { index notices { edges { node { ${NOTICE_PROOF_GQL} } } } } }`;
  const json = await fetchJson(ROLLUP_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return json?.data?.input || null;
}

function noticeRow(obj, node) {
  const proof = node?.proof || null;
  return {
    ...obj,
    _index: Number(node?.index ?? 0),
    _inputIndex: node?.input?.index ?? null,
    _payloadHex: node?.payload || null,
    _proof: proof,
    _hasProof: noticeHasProof(proof),
  };
}

export async function fetchReleaseNotice(ticketId, opts = {}) {
  const id = String(ticketId || '').trim();
  if (isRollupsV2()) {
    try {
      return await fetchReleaseNoticeV2(id, opts);
    } catch (e) {
      const gqlError = e?.message || String(e);
      const snap = await fetchJson(`${VERIFY_SNAPSHOT}${encodeURIComponent(id)}`);
      if (snap && Object.prototype.hasOwnProperty.call(snap, 'rollups')) noteRollupsInfo(snap.rollups);
      return {
        source: 'pool-snapshot',
        notice: normalizeSnapshotNotice(snap.notice || null),
        voucherCount: Number(snap.voucherCount || 0),
        gqlError,
      };
    }
  }
  try {
    let cursor = null;
    let best = null;
    let voucherCount = 0;
    for (let page = 0; page < 20; page++) {
      const json = await graphqlNoticesPage(cursor);
      voucherCount = Math.max(
        voucherCount,
        (json?.data?.vouchers?.edges || []).length,
      );
      const conn = json?.data?.notices || {};
      for (const e of conn.edges || []) {
        const obj = parseNoticePayload(e?.node?.payload);
        if (!obj || obj.type !== 'pool_release_ticket') continue;
        if (String(obj.ticketId || '') !== id) continue;
        const idx = Number(e?.node?.index ?? 0);
        const row = {
          ...obj,
          _index: idx,
          _inputIndex: e?.node?.input?.index ?? null,
          _payloadHex: e?.node?.payload || null,
          _proof: null,
          _hasProof: false,
        };
        if (!best || idx >= best._index) best = row;
      }
      if (best) break;
      if (!conn.pageInfo?.hasPreviousPage || !conn.pageInfo?.startCursor) break;
      cursor = conn.pageInfo.startCursor;
    }
    if (best?._inputIndex != null) {
      const inp = await graphqlInputNoticeProof(best._inputIndex);
      for (const e of inp?.notices?.edges || []) {
        const obj = parseNoticePayload(e?.node?.payload);
        if (!obj || String(obj.ticketId || '') !== id) continue;
        best = noticeRow(obj, {
          ...e.node,
          input: { index: inp.index },
        });
        break;
      }
    }
    return { source: 'rollup-graphql', notice: best, voucherCount };
  } catch (e) {
    // Keep the GraphQL failure: a snapshot notice without its epoch proof
    // otherwise reads as "epoch not claimed" when the real fault is the fetch.
    const gqlError = e?.message || String(e);
    const snap = await fetchJson(`${VERIFY_SNAPSHOT}${encodeURIComponent(id)}`);
    if (snap && Object.prototype.hasOwnProperty.call(snap, 'rollups')) noteRollupsInfo(snap.rollups);
    return {
      source: 'pool-snapshot',
      notice: normalizeSnapshotNotice(snap.notice || null),
      voucherCount: Number(snap.voucherCount || 0),
      gqlError,
    };
  }
}

/** DeFi HTTPS balance — used when this tab's WASM node is on Official1 / down. */
export async function fetchHttpDefiBalanceE8(address, rpc = WART_DEFI_RPC) {
  const addr = String(address || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(addr)) throw new Error('wart address required');
  const j = await fetchJson(`${String(rpc).replace(/\/$/, '')}/account/${addr}/wart_balance`);
  return { ...parseWartBalanceE8(j), address: addr, source: 'defi-http' };
}

export function wasmSkipAllowsHttpCover(local, noticeAndInspectOk) {
  return Boolean(local?.skipped && noticeAndInspectOk);
}

export async function fetchIndependentHead({ allowVpsFallback = true } = {}) {
  if (isLocalDefiNodeLive()) {
    try {
      const head = await fetchLocalChainHead();
      if (head?.height) return { source: 'local-wasm', ...head };
    } catch (e) {
      if (!allowVpsFallback) throw e;
      /* fall through to VPS — local node may still be catching up */
    }
  } else if (!allowVpsFallback) {
    throw new Error('DeFi WASM node not running — start the full node to sign');
  }
  try {
    const j = await fetchJson(WART_HEAD);
    const head = extractWartHead(j);
    if (head) return { source: 'defi-head', ...head };
  } catch {
    /* fall through */
  }
  try {
    const snap = await fetchJson(`${VERIFY_SNAPSHOT}1`);
    const head = snap.wartHead;
    if (head?.height) return { source: 'pool-snapshot', ...head };
  } catch {
    /* */
  }
  throw new Error('independent Warthog head unavailable');
}

export function findInspectTicket(pool, ticketId) {
  const id = String(ticketId || '').trim();
  const list = pool?.recentTickets || [];
  return list.find((t) => String(t.ticketId || '') === id) || null;
}

export function evaluateVerification({
  req,
  inspectPool,
  notice,
  wartHead,
  requireNotice = true,
}) {
  const checks = {
    inspect: false,
    notice: false,
    noticeProof: false,
    inspectTicket: false,
    spv: false,
    localChain: false,
  };
  const reasons = [];
  const lab = Boolean(req?.labDemo) || /^lab-demo-/.test(String(req?.ticketId || ''));

  if (!inspectPool?.ok) {
    reasons.push('Cartesi inspect/pool is not ok');
  } else {
    checks.inspect = true;
  }

  if (req?.poolAddress && inspectPool?.poolAddress) {
    const known = [
      inspectPool.poolAddress,
      inspectPool.previousAddress,
      inspectPool.pendingNext?.address || inspectPool.pendingNext,
    ].filter(Boolean);
    const liveOrRotate = known.some((a) => addrsMatch(req.poolAddress, a));
    if (!liveOrRotate) {
      const known3p = 'ee6cfa285ab4c83c08622dfb1c64d75759d86ec13b18ec03';
      const knownOld = '966d1012941b1fb41d4fff2cadefca7115237dc1818a7cd7';
      const ticket3p = addrsMatch(req.poolAddress, known3p);
      const inspectLegacy = addrsMatch(inspectPool.poolAddress, knownOld);
      if (!(ticket3p && inspectLegacy)) {
        checks.inspect = false;
        reasons.push('inspect poolAddress ≠ ticket pool');
      }
    }
  }

  const inspectTicket = inspectPool ? findInspectTicket(inspectPool, req.ticketId) : null;
  if (inspectTicket) {
    const amtOk = e8Match(inspectTicket.amountE8, req.amountE8);
    const toOk = !req.toAddress || addrsMatch(inspectTicket.toAddress, req.toAddress);
    if (amtOk && toOk) checks.inspectTicket = true;
    else reasons.push('inspect ticket amount/to mismatch');
  }

  if (notice && String(notice.ticketId || '') === String(req.ticketId || '')) {
    const amtOk = e8Match(notice.amountE8, req.amountE8);
    const toOk = !req.toAddress || !notice.toAddress || addrsMatch(notice.toAddress, req.toAddress);
    if (amtOk && toOk) checks.notice = true;
    else reasons.push('release notice amount/to mismatch — not this burn');
  } else if (requireNotice) {
    reasons.push('no pool_release_ticket notice — that notice is the burn attestation');
  }

  const needProof = requireNotice && ticketNeedsNoticeProof(req?.ticketId, { labDemo: lab });
  if (needProof && checks.notice) {
    if (notice?._noticeProofOk) checks.noticeProof = true;
    else if (!notice?._hasProof) {
      reasons.push('waiting for Cartesi notice proof (epoch not claimed)');
    } else {
      reasons.push('Cartesi notice proof present but validateNotice has not passed');
    }
  } else if (!needProof) {
    checks.noticeProof = true;
  }

  const spv = inspectPool?.spv || {};
  const machineH = Number(spv.bestHeight || 0);
  const machineHash = String(spv.bestHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const netH = Number(wartHead?.height || 0);
  const netHash = String(wartHead?.hash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const lag = netH && machineH ? netH - machineH : null;

  if (!spv.bootstrapped) reasons.push('in-machine SPV light client is not bootstrapped');
  else if (!machineH) reasons.push('in-machine SPV has no tip');
  else if (!netH) reasons.push('independent Warthog head missing');
  else if (lag != null && (lag > MAX_SPV_LAG || lag < MIN_SPV_LAG)) {
    reasons.push(`SPV tip lag ${lag} outside ${MIN_SPV_LAG}…${MAX_SPV_LAG}`);
  } else if (lag === 0 && machineHash && netHash && machineHash !== netHash) {
    reasons.push('SPV hash ≠ independent head at same height');
  } else {
    checks.spv = true;
  }

  // Inspect "authorized" is not a substitute for notice proof or WASM.
  // Machine SPV lag is informational; Warthog truth is this tab's WASM node.
  const ok =
    checks.inspect &&
    (!requireNotice || checks.notice) &&
    (!needProof || checks.noticeProof);

  return {
    ok,
    lab,
    checks,
    reasons,
    inspectTicket: inspectTicket
      ? {
          ticketId: inspectTicket.ticketId,
          amountE8: inspectTicket.amountE8,
          toAddress: inspectTicket.toAddress,
          status: inspectTicket.status || null,
          reason: inspectTicket.reason || null,
        }
      : null,
    notice: notice
      ? {
          ticketId: notice.ticketId,
          index: notice._index ?? notice.index ?? null,
          inputIndex: notice._inputIndex ?? null,
          amountE8: notice.amountE8,
          toAddress: notice.toAddress,
          reason: notice.reason || null,
          hasProof: !!notice._hasProof,
        }
      : null,
    machine: {
      processedInputCount: Number(inspectPool?.processedInputCount || 0),
      poolAddress: inspectPool?.poolAddress || null,
      bestHeight: machineH || null,
      bestHash: machineHash || null,
      checkpointHeight: spv.checkpointHeight ?? null,
      checkpointHash: spv.checkpointHash || null,
    },
    wartHead: wartHead
      ? { height: netH, hash: netHash, source: wartHead.source || null, lag }
      : null,
  };
}

export async function verifyOpenRequest(req) {
  const inspect = await fetchInspectPool();
  const gql = await fetchReleaseNotice(req.ticketId, { inputIndex: req.inputIndex ?? null });
  let wartHead = null;
  try {
    wartHead = await fetchIndependentHead({ allowVpsFallback: false });
  } catch {
    /* localChain check below records WASM-down / local-head failure */
  }
  const notice = gql.notice;
  if (
    notice &&
    ticketNeedsNoticeProof(req.ticketId, { labDemo: req.labDemo }) &&
    notice._hasProof &&
    (notice._api === 'v2' ? notice._rawDataHex : notice._payloadHex)
  ) {
    const l1 =
      notice._api === 'v2'
        ? await validateOutputOnL1({
            rawDataHex: notice._rawDataHex,
            proof: notice._proof,
            app: rollupsInfo?.app,
            rpcUrl: rollupsInfo?.l1RpcUrl || V2_DEFAULTS.l1RpcUrl,
          })
        : await validateNoticeOnL1({
            payloadHex: notice._payloadHex,
            proof: notice._proof,
          });
    notice._noticeProofOk = !!l1.ok;
    notice._noticeProofError = l1.error || null;
    if (!l1.ok && l1.error && !l1.waiting) {
      /* keep error for evaluate reasons */
    }
  }
  const ev = evaluateVerification({
    req,
    inspectPool: inspect.pool,
    notice,
    wartHead,
  });
  if (inspect.machine?.replaying) {
    const m = inspect.machine;
    ev.ok = false;
    ev.checks.inspect = false;
    ev.reasons.unshift(
      `machine replaying ${m.processed}/${m.total} inputs` +
        (m.etaMinutes != null ? ` (eta ${m.etaMinutes} min)` : '') +
        ' — ledger is stale, holding',
    );
  }
  if (gql.gqlError && notice && !notice._hasProof) {
    ev.reasons.unshift(
      gql.source === 'pool-snapshot' && isRollupsV2()
        ? `rollups v2 rpc failed — ${gql.gqlError}`
        : `rollup GraphQL failed — ${gql.gqlError}`,
    );
  }
  const local = await verifyLocalForPayout({
    poolAddress: req.poolAddress,
    amountE8: req.amountE8,
    spv: inspect.pool?.spv,
  });
  ev.local = {
    skipped: local.skipped,
    source: local.source,
    freeE8: local.balance?.free?.toString?.() || null,
    ancestry: local.ancestry || null,
    synced: local.head?.synced ?? null,
  };
  if (local.ok && !local.skipped) {
    ev.checks.localChain = true;
    if (local.ancestry) ev.checks.spv = true;
  } else if (wasmSkipAllowsHttpCover(local, ev.ok) && req.poolAddress && req.amountE8 != null) {
    // Holder tabs often stay on Official1. Rotate still requires WASM; an
    // inspect+notice user burn can cover from DeFi HTTP so d1/d2 can offer.
    try {
      const httpBal = await fetchHttpDefiBalanceE8(req.poolAddress);
      assertPoolPayoutCovered(httpBal.free, req.amountE8, req.poolAddress);
      ev.checks.localChain = true;
      ev.local = {
        ...ev.local,
        skipped: false,
        source: 'defi-http',
        freeE8: httpBal.free.toString(),
      };
    } catch (e) {
      ev.ok = false;
      ev.checks.localChain = false;
      const msg = e?.message || String(e);
      if (!ev.reasons.includes(msg)) ev.reasons.push(msg);
    }
  } else {
    ev.ok = false;
    ev.checks.localChain = false;
    for (const r of local.reasons || []) {
      if (!ev.reasons.includes(r)) ev.reasons.push(r);
    }
  }
  if (notice && notice._hasProof && !notice._noticeProofOk && ev.checks.notice) {
    const extra = notice._noticeProofError || 'validateNotice failed';
    if (!ev.reasons.some((r) => /validateNotice|notice proof/i.test(r))) {
      ev.reasons.push(extra);
    }
    ev.ok = false;
    ev.checks.noticeProof = false;
  }
  return {
    ...ev,
    sources: {
      inspect: inspect.source,
      notice: gql.source,
      head: wartHead?.source || null,
    },
    gqlError: gql.gqlError || null,
    voucherCount: gql.voucherCount || 0,
    attestation: {
      ticketId: req.ticketId,
      noticeOk: ev.checks.notice,
      noticeProofOk: ev.checks.noticeProof,
      inspectOk: ev.checks.inspect,
      inspectTicketOk: ev.checks.inspectTicket,
      spvOk: ev.checks.spv,
      localChainOk: ev.checks.localChain,
      noticeIndex: ev.notice?.index ?? null,
      machineInputs: ev.machine.processedInputCount,
      machineBestHeight: ev.machine.bestHeight,
      machineBestHash: ev.machine.bestHash,
      independentHeight: ev.wartHead?.height ?? null,
      independentHash: ev.wartHead?.hash ?? null,
      lag: ev.wartHead?.lag ?? null,
      sources: {
        inspect: inspect.source,
        notice: gql.source,
        head: wartHead?.source || null,
      },
      checkedAt: new Date().toISOString(),
    },
  };
}

export async function probeMachineHealth() {
  const inspect = await fetchInspectPool();
  const wartHead = await fetchIndependentHead();
  const ev = evaluateVerification({
    req: { ticketId: 'probe' },
    inspectPool: inspect.pool,
    notice: null,
    wartHead,
    requireNotice: false,
  });
  return ev;
}

export function formatVerifyLine(v) {
  if (!v) return 'verify —';
  const noticeBit = v.rotationSweep
    ? 'rotate'
    : v.checks?.noticeProof
      ? '✓ notice-proof'
      : v.checks?.notice
        ? '… notice-proof'
        : v.ok
          ? '— notice'
          : '✗ notice';
  const bit = (ok, label) => `${ok ? '✓' : '✗'} ${label}`;
  const lag =
    v.wartHead?.lag == null ? '' : ` · lag ${v.wartHead.lag}`;
  const localBit = v.checks?.localChain
    ? ' · ✓ local-node'
    : v.local ||
        v.reasons?.some((r) =>
          /WASM node not running|local Q free|not synced|SPV tip|local hash at SPV|local WASM height/i.test(
            r,
          ),
        )
      ? ' · ✗ local-node'
      : v.wartHead?.source === 'local-wasm'
        ? ' · local-head'
        : v.wartHead?.source === 'defi-head'
          ? ' · vps-head'
          : '';
  const h = v.machine?.bestHeight
    ? ` · SPV #${v.machine.bestHeight}/${v.wartHead?.height || '?'}${lag}`
    : '';
  const why =
    v.ok === false && v.reasons?.[0]
      ? ` · ${String(v.reasons[0]).slice(0, 80)}`
      : '';
  return `${noticeBit} · ${bit(v.checks?.inspect, 'machine')} · ${bit(v.checks?.spv, 'SPV')}${h}${localBit}${why}`;
}
