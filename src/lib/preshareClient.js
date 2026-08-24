/**
 * Wire layer for sealed preshare packs — pool-agnostic.
 *
 * `poolSigner.js` and `ethPoolSigner.js` differ in almost everything except
 * this: both have a seat whose secret lives in one tab, both heartbeat, and
 * both need a way for another tab to take over when that one goes away. The
 * only per-pool inputs are the action prefix (`pool3p_` / `eth3p_`) and what
 * counts as the seat record, so they are parameters rather than two copies.
 *
 * Every call here is best-effort. A coordinator that has not yet deployed the
 * endpoints answers with an error, and packing quietly does not happen — a node
 * running this against an old server keeps signing exactly as before. The one
 * thing that must never be best-effort is the opposite direction: a *failed*
 * recovery has to return null so the caller reports a seat fault, rather than
 * carrying a half-recovered secret into a signing round.
 */
import {
  buildPack,
  openPack,
  resealPiece,
  chooseTargets,
  packAad,
} from './sealedPreshare.js';
import { getNodeIdentity, attest } from './nodeIdentity.js';

/** Remember the target set a pack was built for, so we do not re-pack every beat. */
const packSig = new Map();

function sigOf(role, targets) {
  return `${role}:${targets
    .map((t) => t.id)
    .sort()
    .join(',')}`;
}

/**
 * Publish this node's public key and a signed presence claim.
 *
 * The attestation is what makes a holder's participation checkable later: a
 * pool signature produced without the seats it names becomes something the
 * operator would have to lie about in public, rather than something invisible.
 */
export async function identityFields({ pool, role, seatEpoch, signerId }) {
  const { pubHex } = await getNodeIdentity();
  const att = await attest({
    pool,
    role: Number(role) || 0,
    seatEpoch: Number(seatEpoch) || 0,
    signerId: String(signerId || ''),
  });
  return { nodePubHex: pubHex, attestation: { sigHex: att.sigHex, claim: att.claim } };
}

/**
 * Pack the live seat for churn recovery.
 *
 * Returns the chosen targets, or null when nothing was done — no usable
 * targets, an unchanged target set, or a coordinator without the endpoint.
 */
export async function packSeat({
  post,
  prefix,
  pool,
  signerId,
  role,
  P,
  record,
  orbit,
  orbitKeys,
  otherHolderId,
  t = 2,
  max = 4,
}) {
  if (!record || !P || !(Number(role) === 1 || Number(role) === 2)) return null;

  const targets = chooseTargets({
    orbit,
    selfId: signerId,
    otherHolderId,
    pubKeys: orbitKeys || {},
    max,
  });
  if (targets.length < t) return null;

  const sig = sigOf(role, targets);
  if (packSig.get(`${pool}:${role}`) === sig) return null;

  try {
    const pack = await buildPack({ record, targets, t, aad: packAad({ pool, role, P }) });
    const r = await post(`${prefix}_preshare_put`, { signerId, role: Number(role), pack });
    if (r?.ok === false) return null;
    packSig.set(`${pool}:${role}`, sig);
    return targets.map((x) => x.id);
  } catch {
    // An old coordinator, or too few sealable targets. Not fatal: the seat
    // still signs, it just is not protected against this tab going away.
    return null;
  }
}

/**
 * Answer any outstanding reseal requests for pieces this node holds.
 *
 * This is the cooperative half. Sealing means the recovering tab cannot read
 * stored pieces, so recovery only works if the holders are online and willing —
 * which is what the heartbeat gives us for free.
 */
export async function serveResealRequests({ post, prefix, signerId, requests }) {
  if (!Array.isArray(requests) || !requests.length) return 0;
  const { privHex } = await getNodeIdentity();
  let served = 0;
  for (const req of requests) {
    if (!req?.piece || !req?.requesterPub || !req?.requesterId) continue;
    try {
      const resealed = await resealPiece({
        piece: req.piece,
        toPubHex: req.requesterPub,
        aad: req.aad || '',
        privHex,
      });
      await post(`${prefix}_preshare_reseal_put`, {
        signerId,
        role: Number(req.role) || 0,
        requesterId: req.requesterId,
        resealed,
      });
      served++;
    } catch {
      // Not our piece, or a stale request. Skip it — another holder can serve.
    }
  }
  return served;
}

/**
 * Try to recover a seat we cannot sign for.
 *
 * Two round trips by design: the first publishes a request that holders answer
 * on their next beat, the second collects whatever came back. A caller should
 * treat null as "still cannot sign" and report a fault, then try again next
 * beat — holders may simply not have beaten yet.
 */
export async function recoverSeat({ post, prefix, signerId, role, P, pool }) {
  const { pubHex, privHex } = await getNodeIdentity();
  const aad = packAad({ pool, role, P });

  try {
    await post(`${prefix}_preshare_reseal_request`, {
      signerId,
      role: Number(role),
      pubHex,
      aad,
    });
  } catch {
    return null;
  }

  let r;
  try {
    r = await post(`${prefix}_preshare_collect`, { signerId, role: Number(role) });
  } catch {
    return null;
  }
  if (!r?.pack || !Array.isArray(r.resealed) || !r.resealed.length) return null;
  if (r.stale) return null;

  const record = await openPack({ pack: r.pack, resealed: r.resealed, privHex });
  if (!record?.userShareHex) return null;
  return record;
}
