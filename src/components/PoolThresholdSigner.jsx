import { useCallback, useEffect, useRef, useState } from 'react';
import {
  contributeOpen,
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

export default function PoolThresholdSigner() {
  const [share, setShare] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [log, setLog] = useState('joining roster…');
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
        if (!cancelled) {
          setShare(s);
          setLog(`joined as slot ${s.shareIndex}`);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setPhase('error');
          setError(e?.message || String(e));
          setLog('could not join roster');
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
      await heartbeat(share);
      const { status: st, results, openCount, lastVerify } = await contributeOpen(share);
      if (lastVerify) setVerify(lastVerify);
      const serverEpoch = st.signers?.epoch ?? st.epoch;
      if (
        serverEpoch != null &&
        share.epoch != null &&
        Number(serverEpoch) !== Number(share.epoch)
      ) {
        const s = await loadActiveShare();
        setShare(s);
        setLog(`new lease · epoch ${s.epoch ?? serverEpoch}`);
        setStatus(st);
        setError(null);
        return;
      }
      setStatus(st);
      setError(null);

      const me = (st.signers?.slots || []).find(
        (x) => x.signerId === share.signerId,
      );
      const serverCount = Number(me?.signedCount ?? 0);
      const need = st.t || st.signers?.policyT || 3;
      const active = st.signers?.active ?? 0;

      if (openCount === 0) {
        setPhase('online');
        setLog(`online · ${active} running · need ${need} of ${active || need}`);
        if (serverCount > Number(stats.signedCount || 0)) {
          setStats(await writeStats({ signedCount: serverCount }));
        }
        return;
      }

      setPhase('signing');
      const last = results[results.length - 1] || {};
      const fresh = results.filter((r) => r.contributed && !r.alreadyHad);
      if (fresh.length) {
        setStats(
          await writeStats({
            signedCount: Math.max(
              serverCount,
              Number(stats.signedCount || 0) + fresh.length,
            ),
            lastTicket: last.ticketId || null,
            lastPaid: Boolean(last.paid),
            lastTx: last.payout?.txHash || null,
            lastAt: Date.now(),
            lastMsg: last.message || null,
          }),
        );
      } else if (serverCount > Number(stats.signedCount || 0)) {
        setStats(await writeStats({ signedCount: serverCount }));
      }

      if (last.paid) {
        setPhase('signed');
        setLog(
          `signed ${shortTicket(last.ticketId)} · paid ${String(last.payout?.txHash || '').slice(0, 10)}…`,
        );
      } else {
        const skipped = results.filter((r) => r.skipped);
        const waitingNotice = skipped.filter((r) =>
          /no pool_release_ticket|burn attestation/i.test(r.error || ''),
        );
        if (waitingNotice.length && waitingNotice.length === skipped.length && !fresh.length) {
          setPhase('online');
          setError(null);
          setLog('watching · no burn/release notice yet');
        } else if (skipped.length && !fresh.length) {
          setPhase('error');
          setError(skipped[0].error || 'verification failed');
          setLog(`held share — ${skipped[0].error || 'verify failed'}`);
        } else {
          setLog(
            `signing ${shortTicket(last.ticketId)} · ${last.count || '?'}/${last.need || need}`,
          );
        }
      }
    } catch (e) {
      const msg = e?.message || String(e);
      setPhase('error');
      setError(msg);
      if (/EPOCH_ROTATED|share is dead|mismatch|not issued|does not own|share material/i.test(msg)) {
        try {
          const s = await loadActiveShare();
          setShare(s);
          setLog(`new lease · epoch ${s.epoch ?? '?'} · slot ${s.shareIndex}`);
          setPhase('online');
          setError(null);
        } catch {
          /* keep error */
        }
      }
      try {
        setStatus(await fetchThresholdStatus(DEFAULT_POOL_API));
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

  const signers = status?.signers;
  const issued = (signers?.slots || []).filter((s) => s.issued);
  const live = issued.filter((s) => s.online);
  const abandoned = issued.filter((s) => !s.online);
  const me = issued.find((s) => share && s.signerId === share.signerId);
  const displayCount = Math.max(
    Number(stats.signedCount || 0),
    Number(me?.signedCount || 0),
  );
  const open = (status?.open || []).filter(
    (r) => !r.labDemo && !/^lab-demo-/.test(String(r.ticketId || '')),
  );
  const need = status?.t || signers?.policyT || share?.need || 3;
  const active = signers?.active ?? live.length;

  const renderSlot = (s) => (
    <li
      key={s.shareIndex}
      className={s.signerId === share?.signerId ? 'is-me' : undefined}
    >
      #{s.shareIndex} {shortId(s.signerId)}
      {s.online ? ' · live' : ''}
      {s.signedCount ? ` · ${s.signedCount} signed` : ''}
    </li>
  );

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
    <section className="panel pool-signer" aria-label="Pool threshold signer">
      <div className="panel__head">
        <h2>Pool signer</h2>
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
          signed {displayCount} · need {need}/{active || need}
        </span>
      </div>

      <p className="pool-signer__lead">
        {share ? (
          <>
            You are <code>{shortId(share.signerId)}</code> · slot {share.shareIndex}
            {share.epoch != null ? ` · epoch ${share.epoch}` : ''}
            {' · '}
            share lives in this tab only. Signs only after notice + machine + SPV tip check out.
          </>
        ) : (
          <>Anyone with this page or the extension is a unique signer — joining…</>
        )}
      </p>
      <p className="pool-signer__meta">{log}</p>
      {verify && (
        <p className={`pool-signer__meta${verify.ok === false ? ' is-warn' : ''}`}>
          {formatVerifyLine(verify)}
        </p>
      )}
      {open.length > 0 && (
        <p className="pool-signer__meta">
          Open:{' '}
          {open.map((r) => `${shortTicket(r.ticketId)} ${r.count}/${r.need}`).join(' · ')}
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

      {live.length > 0 && (
        <ul className="pool-signer__slots">{live.map(renderSlot)}</ul>
      )}
      {abandoned.length > 0 && (
        <details className="pool-signer__history">
          <summary>
            Abandoned history
            <span>{abandoned.length}</span>
          </summary>
          <ul className="pool-signer__slots pool-signer__slots--history">
            {abandoned.map(renderSlot)}
          </ul>
        </details>
      )}
    </section>
  );
}
