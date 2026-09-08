/**
 * Whether this tab may reload right now without hurting a signing round.
 *
 * Each signer (WART 3P, ETH 3P) reports after every heartbeat. A reload is
 * safe when no pool has an open room, and any seat this tab holds is packed
 * to the orbit (its share survives the tab). A signer that never reported —
 * signing off — does not block.
 */
const pools = new Map();

export function reportSignerSafety(pool, { holder = false, openRooms = 0, packReady = null } = {}) {
  pools.set(pool, { holder: !!holder, openRooms: Number(openRooms || 0), packReady, at: Date.now() });
}

export function clearSignerSafety(pool) {
  pools.delete(pool);
}

/** true, or a short reason string. */
export function isSafeToReload() {
  for (const [pool, s] of pools) {
    if (s.openRooms > 0) return `${pool}: ${s.openRooms} open room(s)`;
    if (s.holder && s.packReady === false) return `${pool}: held seat is not packed yet`;
  }
  return true;
}
