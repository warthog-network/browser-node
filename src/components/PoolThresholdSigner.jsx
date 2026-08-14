import { useCallback, useEffect, useRef, useState } from 'react';
import {
  contributeOpen,
  fetchPool3pStatus,
  fetchThresholdStatus,
  heartbeat,
  loadActiveShare,
  readEnabled,
  readStats,
  writeEnabled,
  writeStats,
  DEFAULT_POOL_API,
} from '../lib/poolSigner.js';
import { formatVerifyLine } from '../lib/poolVerify.js';

const POLL_MS = 2500;

function shortId(id) {
  const s = String(id || '');
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-4)}`;
}

function shortTicket(id) {
  const s = String(id || '');
  if (s.length <= 22) return s;
  return `${s.slice(0, 14)}…`;
}

function seatLabel(share) {
  if (!share) return 'joining';
  if (share.waitlist) return 'orbit voter';
  if (share.role === 1) return 'd1 seat';
  if (share.role === 2) return 'd2 seat';
  return `slot ${share.shareIndex ?? '?'}`;
}

export default function PoolThresholdSigner() {
  const [share, setShare] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState(null);
  const [pool3p, setPool3p] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [log, setLog] = useState('joining 3P orbit…');
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ signedCount: 0 });
  const [verify, setVerify] = useState(null);
  const tickLock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const on = await readEnabled();
      const st = await readStats();
      if (!cancelled) {
        setEnabled(on);
        setStats(st);
      }
      try {
        const s = await loadActiveShare();
        const p3 = await fetchPool3pStatus().catch(() => null);
        if (!cancelled) {
          setShare(s);
          setPool3p(p3);
          setLog(
            s.waitlist
              ? 'orbit voter — d1/d2 leased; if a holder goes idle you can claim the seat'
              : s.role === 1
                ? 'holding d1 (Lindell finish). Idle > 2 min reissues this seat.'
                : s.role === 2
                  ? 'holding d2. Idle > 2 min reissues this seat.'
                  : `joined as slot ${s.shareIndex}`,
          );
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setPhase('error');
          setError(e?.message || String(e));
          setLog('could not join 3P orbit');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tick = useCallback(async () => {
    if (!share || !enabled || tickLock.current) return;
    tickLock.current = true;
    try {
      const hb = await heartbeat(share);
      if (hb?.orbit) {
        setPool3p((prev) => ({ ...(prev || {}), orbit: hb.orbit, seatEpoch: hb.seatEpoch }));
      }
      const { status: st, pool3p: p3, results, openCount, lastVerify } =
        await contributeOpen(share);
      if (lastVerify) setVerify(lastVerify);
      if (p3) setPool3p(p3);

      if (
        (st?.signers?.epoch != null &&
          share.epoch != null &&
          Number(st.signers.epoch) !== Number(share.epoch)) ||
        (p3?.seatEpoch != null &&
          share.seatEpoch != null &&
          Number(p3.seatEpoch) !== Number(share.seatEpoch))
      ) {
        const s = await loadActiveShare();
        setShare(s);
        setLog(
          s.waitlist
            ? `seat refreshed · now orbit voter · epoch ${p3?.seatEpoch ?? '?'}`
            : `new ${seatLabel(s)} lease · seatEpoch ${s.seatEpoch ?? p3?.seatEpoch ?? '?'}`,
        );
        setStatus(st);
        setError(null);
        return;
      }
      setStatus(st);
      setError(null);

      const liveN = p3?.orbit?.liveCount ?? hb?.orbit?.liveCount ?? 0;
      const needN = Math.max(liveN, p3?.orbit?.orbitMin ?? 2);

      if (openCount === 0) {
        setPhase('online');
        setLog(
          `${seatLabel(share)} · orbit ${liveN} live · n-of-n among live (need ${needN})`,
        );
        return;
      }

      setPhase('signing');
      const last = results[results.length - 1] || {};
      const fresh = results.filter(
        (r) => (r.contributed || r.ok) && !r.alreadyHad && !r.skipped && !r.orbitOnly,
      );
      if (fresh.length) {
        setStats(
          await writeStats({
            signedCount: Number(stats.signedCount || 0) + fresh.length,
            lastTicket: last.ticketId || null,
            lastPaid: Boolean(last.paid || last.txHash),
            lastTx: last.payout?.txHash || last.txHash || null,
            lastAt: Date.now(),
            lastMsg: last.message || last.error || null,
          }),
        );
      }

      if (last.paid || last.txHash) {
        setPhase('signed');
        setLog(
          `3P paid ${shortTicket(last.ticketId)} · ${String(last.txHash || last.payout?.txHash || '').slice(0, 10)}…`,
        );
      } else if (last.orbitOnly || last.waiting) {
        setPhase('online');
        setLog(
          last.waiting
            ? `d1 waiting for d2 / orbit on ${shortTicket(last.ticketId)}`
            : `orbit attested ${shortTicket(last.ticketId)}`,
        );
      } else {
        const skipped = results.filter((r) => r.skipped);
        if (skipped.length && !fresh.length) {
          setPhase('error');
          setError(skipped[0].error || 'verification failed');
          setLog(`held — ${skipped[0].error || 'verify failed'}`);
        } else {
          setLog(`signing ${shortTicket(last.ticketId)} · ${seatLabel(share)}`);
        }
      }
    } catch (e) {
      const msg = e?.message || String(e);
      setPhase('error');
      setError(msg);
      if (
        /EPOCH_ROTATED|SEAT_ROTATED|share is dead|mismatch|not issued|does not own|share material/i.test(
          msg,
        )
      ) {
        try {
          const s = await loadActiveShare();
          setShare(s);
          setLog(`re-enrolled as ${seatLabel(s)} · seatEpoch ${s.seatEpoch ?? '?'}`);
          setPhase('online');
          setError(null);
        } catch {
          /* keep error */
        }
      }
      try {
        setStatus(await fetchThresholdStatus(DEFAULT_POOL_API));
        setPool3p(await fetchPool3pStatus(DEFAULT_POOL_API));
      } catch {
        /* */
      }
    } finally {
      tickLock.current = false;
    }
  }, [share, enabled, stats.signedCount]);

  useEffect(() => {
    if (!share || !enabled) return undefined;
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [share, enabled, tick]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await writeEnabled(next);
    setPhase(next ? 'online' : 'paused');
  };

  const open = (status?.open || []).filter(
    (r) => !r.labDemo && !/^lab-demo-/.test(String(r.ticketId || '')),
  );
  const liveOrbit = pool3p?.orbit?.live || [];
  const liveN = pool3p?.orbit?.liveCount ?? liveOrbit.length;
  const needN = Math.max(liveN, pool3p?.orbit?.orbitMin ?? 2);

  const phaseLabel =
    !share && phase === 'error'
      ? 'Offline'
      : !share
        ? 'Joining'
        : phase === 'signing'
          ? 'Signing now'
          : phase === 'signed'
            ? 'Just signed'
            : phase === 'error'
              ? 'Retrying'
              : enabled
                ? 'Listening'
                : 'Paused';

  return (
    <section className="panel pool-signer" aria-label="3P pool signer">
      <div className="panel__head">
        <h2>3P pool signer</h2>
        <button
          type="button"
          className={`btn btn--ghost${enabled ? ' is-on' : ''}`}
          onClick={toggle}
          disabled={!share}
        >
          {enabled ? 'Signing ON' : 'Signing OFF'}
        </button>
      </div>

      <div
        className={`pool-signer__status is-${
          phase === 'signing' ? 'signing' : phase === 'error' ? 'err' : 'idle'
        }`}
      >
        <span className="pool-signer__dot" aria-hidden />
        <strong>{phaseLabel}</strong>
        <span className="pool-signer__count">
          {seatLabel(share)} · orbit {liveN}/{needN}
        </span>
      </div>

      <p className="pool-signer__lead">
        {share ? (
          <>
            You are <code>{shortId(share.signerId)}</code> · {seatLabel(share)}
            {share.seatEpoch != null ? ` · seatEpoch ${share.seatEpoch}` : ''}
            {'. '}
            3P core is d_dapp + d1 + d2. Orbit is n-of-n among live tabs. Idle drops a
            seat and reissues it — old hex dies, same pool address.
            {share.sealOk
              ? ' Seal checked against published P1+P2+Pdapp=Q.'
              : ''}
            {share.seal?.dealerSawPlaintext
              ? ' This epoch was minted on the VPS (dealer saw plaintext).'
              : ''}
          </>
        ) : (
          <>Joining the 3P orbit (website or extension)…</>
        )}
      </p>
      <p className="pool-signer__meta">{log}</p>
      {pool3p?.address ? (
        <p className="pool-signer__meta" style={{ wordBreak: 'break-all' }}>
          Pool {pool3p.address}
          <br />
          d1 {pool3p.holder1 ? shortId(pool3p.holder1) : 'vacant'} · d2{' '}
          {pool3p.holder2 ? shortId(pool3p.holder2) : 'vacant'}
        </p>
      ) : null}
      {verify && (
        <p className={`pool-signer__meta${verify.ok === false ? ' is-warn' : ''}`}>
          {formatVerifyLine(verify)}
        </p>
      )}
      {open.length > 0 && (
        <p className="pool-signer__meta">
          Open: {open.map((r) => shortTicket(r.ticketId)).join(' · ')}
        </p>
      )}
      {stats.lastTicket && (
        <p className="pool-signer__meta">
          Last: {shortTicket(stats.lastTicket)}
          {stats.lastPaid ? ' · paid' : ''}
          {stats.lastAt ? ` · ${new Date(stats.lastAt).toLocaleTimeString()}` : ''}
        </p>
      )}
      {error ? <p className="dash__error">{error}</p> : null}

      {liveOrbit.length > 0 && (
        <ul className="pool-signer__slots">
          {liveOrbit.map((id) => (
            <li key={id} className={id === share?.signerId ? 'is-me' : undefined}>
              {shortId(id)}
              {id === pool3p?.holder1 ? ' · d1' : ''}
              {id === pool3p?.holder2 ? ' · d2' : ''}
              {id === share?.signerId ? ' · you' : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
