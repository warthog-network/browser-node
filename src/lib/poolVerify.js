/**
 * Independent checks a pool signer must pass before handing over a share.
 *
 *   1. Cartesi inspect/pool — machine state + recent release tickets + in-machine SPV
 *   2. GraphQL notices — pool_release_ticket (the burn/redeem attestation)
 *   3. Independent Warthog head — DeFi testnet tip vs the machine light-client tip
 *
 * The coordinator is not trusted for "this ticket is real." We read rollup
 * outputs and a Warthog node, then compare. Lab-demo tickets skip the notice
 * but still require a live machine + SPV tip.
 */

export const ROLLUP_INSPECT =
  'https://cartesi-bridge.duckdns.org/rollup/inspect/pool';
export const ROLLUP_GRAPHQL = 'https://cartesi-bridge.duckdns.org/rollup/graphql';
export const WART_HEAD = 'https://warthog-defitestnet.duckdns.org/chain/head';
export const VERIFY_SNAPSHOT =
  'https://cartesi-bridge.duckdns.org/api/pool?verifyTicket=';

export const MAX_SPV_LAG = 64;
export const MIN_SPV_LAG = -8;

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

async function fetchJson(url, init) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${url} HTTP ${res.status}`);
  return body;
}

export async function fetchInspectPool() {
  try {
    const raw = await fetchJson(ROLLUP_INSPECT);
    const pool = decodeInspectBody(raw);
    if (!pool?.ok) throw new Error('inspect/pool not ok');
    return { source: 'rollup-inspect', raw, pool };
  } catch (directErr) {
    const snap = await fetchJson(`${VERIFY_SNAPSHOT}1`);
    if (snap?.inspect?.pool?.ok) {
      return { source: 'pool-snapshot', raw: snap.inspect.raw || snap.inspect, pool: snap.inspect.pool };
    }
    throw new Error(
      `inspect failed (${directErr?.message || directErr})`,
    );
  }
}

async function graphqlNoticesPage(cursor) {
  const after = cursor ? `, before: "${cursor}"` : '';
  const query = `{ notices(last: 100${after}) { pageInfo { hasPreviousPage startCursor } edges { node { index payload } } } vouchers(last: 20) { edges { node { index destination payload } } } }`;
  return fetchJson(ROLLUP_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}

export async function fetchReleaseNotice(ticketId) {
  const id = String(ticketId || '').trim();
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
        if (!best || idx >= best._index) best = { ...obj, _index: idx };
      }
      if (best) break;
      if (!conn.pageInfo?.hasPreviousPage || !conn.pageInfo?.startCursor) break;
      cursor = conn.pageInfo.startCursor;
    }
    return { source: 'rollup-graphql', notice: best, voucherCount };
  } catch {
    const snap = await fetchJson(`${VERIFY_SNAPSHOT}${encodeURIComponent(id)}`);
    return {
      source: 'pool-snapshot',
      notice: snap.notice || null,
      voucherCount: Number(snap.voucherCount || 0),
    };
  }
}

export async function fetchIndependentHead() {
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
    inspectTicket: false,
    spv: false,
  };
  const reasons = [];
  const lab = Boolean(req?.labDemo) || /^lab-demo-/.test(String(req?.ticketId || ''));

  if (!inspectPool?.ok) {
    reasons.push('Cartesi inspect/pool is not ok');
  } else {
    checks.inspect = true;
  }

  if (req?.poolAddress && inspectPool?.poolAddress) {
    if (!addrsMatch(req.poolAddress, inspectPool.poolAddress)) {
      checks.inspect = false;
      reasons.push('inspect poolAddress ≠ ticket pool');
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

  const ok =
    checks.inspect &&
    checks.spv &&
    (!requireNotice || checks.notice);

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
          reason: inspectTicket.reason || null,
        }
      : null,
    notice: notice
      ? {
          ticketId: notice.ticketId,
          index: notice._index ?? notice.index ?? null,
          amountE8: notice.amountE8,
          toAddress: notice.toAddress,
          reason: notice.reason || null,
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
  const gql = await fetchReleaseNotice(req.ticketId);
  const wartHead = await fetchIndependentHead();
  const ev = evaluateVerification({
    req,
    inspectPool: inspect.pool,
    notice: gql.notice,
    wartHead,
  });
  return {
    ...ev,
    sources: {
      inspect: inspect.source,
      notice: gql.source,
      head: wartHead.source,
    },
    voucherCount: gql.voucherCount || 0,
    attestation: {
      ticketId: req.ticketId,
      noticeOk: ev.checks.notice,
      inspectOk: ev.checks.inspect,
      inspectTicketOk: ev.checks.inspectTicket,
      spvOk: ev.checks.spv,
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
        head: wartHead.source,
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
  const bit = (ok, label) => `${ok ? '✓' : '✗'} ${label}`;
  const lag =
    v.wartHead?.lag == null ? '' : ` · lag ${v.wartHead.lag}`;
  const h = v.machine?.bestHeight
    ? ` · SPV #${v.machine.bestHeight}/${v.wartHead?.height || '?'}${lag}`
    : '';
  return `${bit(v.checks?.notice, 'notice')} · ${bit(v.checks?.inspect, 'machine')} · ${bit(v.checks?.spv, 'SPV')}${h}`;
}
