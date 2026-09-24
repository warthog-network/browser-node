/**
 * Decide whether this tab should seal its incoming-seat share.
 *
 * Rotation stays in next_ready until both incoming seats have a sealed pack
 * held by peers who could claim the seat. The live-seat pack does not count:
 * it is bound to the current P, and the coordinator stores the next P in a
 * separate slot. Only the tab that birthed the next share has the secret.
 */

function normAddr(v) {
  return String(v || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * Peers the sweep gate will not count: denylisted ids, and anyone who has
 * declared a network other than the one seats must sit on. Unknown network
 * stays eligible, matching the coordinator's vacate check.
 */
export function excludeIdsForPack(st) {
  const deny = (Array.isArray(st?.seatDenylist) && st.seatDenylist.length
    ? st.seatDenylist
    : ['alabama-', 'node-8c92950a']
  )
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);
  const want = String(st?.seatRequireNetwork || 'defi').trim().toLowerCase();
  const byId = new Map();
  for (const m of st?.orbit?.members || []) {
    if (!m) continue;
    if (typeof m === 'string') byId.set(m, {});
    else if (m.id) byId.set(m.id, m);
  }
  const ids = new Set([...byId.keys(), ...(st?.orbit?.live || [])]);
  const out = [];
  for (const id of ids) {
    const low = String(id).toLowerCase();
    const net = String(byId.get(id)?.network || '')
      .trim()
      .toLowerCase();
    const denied = deny.some((p) => low.startsWith(p) || low.includes(p));
    const wrongNet = !!(net && want && net !== want);
    if (denied || wrongNet) out.push(id);
  }
  return out;
}

/** Fields a recovered tab needs in order to sign. Sealed under the pack key. */
export function nextSeatRecord(cached, role) {
  const rec = {
    userShareHex: cached.userShareHex,
    role: Number(role),
    P: cached.P,
    scheme: cached.scheme || null,
  };
  for (const k of [
    'paillierN',
    'paillierG',
    'paillierLambda',
    'paillierMu',
    'publicKey',
    'Pdapp',
    'poolAddress',
  ]) {
    if (cached[k] != null && cached[k] !== '') rec[k] = cached[k];
  }
  if (cached.seal) rec.seal = cached.seal;
  return rec;
}

/**
 * Return a pack plan, or null when this tab should not post a next pack.
 * `coordinatorHasPack` is null when the status has no next-slot view, so the
 * tab posts once and then remembers it. An explicit unsealed view forces a retry.
 */
export function nextPackPlan(st, { signerId, role, cached } = {}) {
  const phase = String(st?.rotation?.phase || '');
  if (!['need_birth', 'next_ready', 'announced'].includes(phase)) return null;
  const r = Number(role);
  if (r !== 1 && r !== 2) return null;
  if (!cached?.userShareHex || !cached?.P) return null;
  const bornBy = st?.rotation?.next?.bornBy || {};
  const dealer = bornBy[r] || bornBy[String(r)] || null;
  if (dealer && dealer !== signerId) return null;
  if (!dealer && cached.signerId && signerId && cached.signerId !== signerId) return null;
  const nextAddr = normAddr(st?.rotation?.next?.address);
  const cachedAddr = normAddr(cached.poolAddress);
  if (nextAddr && cachedAddr && nextAddr !== cachedAddr) return null;
  if (!nextAddr && phase !== 'need_birth') return null;
  const other = r === 1 ? bornBy[2] || bornBy['2'] : bornBy[1] || bornBy['1'];
  const view = st?.packs?.[String(r)]?.next || st?.packs?.[r]?.next || null;
  // null view means this status shape does not report the next slot (ETH) or
  // the slot is empty. Do not force a repost on every beat: a successful post
  // is remembered locally. An explicit not-sealed view does force one.
  let coordinatorHasPack = null;
  if (view && (view.sealed || view.ready)) coordinatorHasPack = true;
  else if (view && view.sealed === false) coordinatorHasPack = false;
  return {
    P: cached.P,
    otherHolderId: other || null,
    coordinatorHasPack,
    exclude: excludeIdsForPack(st),
  };
}
