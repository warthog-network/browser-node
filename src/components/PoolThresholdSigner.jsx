import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const SIGNED_HOLD_MS = 12000;
const TRANSIENT =
  /missing prepare|hash mismatch|recovery failed|do not submit v=0|R1 rejected|waiting|rebuild failed|not the current d[12]|orbit pack incomplete/i;

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

function shortTx(id) {
  const s = String(id || '');
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
}

function seatLabel(share) {
  if (!share) return 'joining';
  if (share.waitlist) return 'orbit voter';
  if (share.role === 1) return 'd1 seat';
  if (share.role === 2) return 'd2 seat';
  return `slot ${share.shareIndex ?? '?'}`;
}

function e8ToWart(e8) {
  const n = Number(e8);
  if (!Number.isFinite(n)) return null;
  return (n / 1e8).toFixed(2).replace(/\.00$/, '');
}

export default function PoolThresholdSigner() {
  const [share, setShare] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState(null);
  const [pool3p, setPool3p] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [log, setLog] = useState('joining 3P orbit…');
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ signedCount: 0, history: [] });
  const [verify, setVerify] = useState(null);
  const tickLock = useRef(false);
  const lastLog = useRef('');
  const signedUntil = useRef(0);

  const putLog = (msg) => {
    if (!msg || msg === lastLog.current) return;
    lastLog.current = msg;
    setLog(msg);
  };

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
          putLog(
            s.waitlist
              ? 'orbit voter — this tab attests tickets and can rebuild a vacant seat'
              : s.role === 1
                ? 'holding d1 — this tab finishes 3P Lindell'
                : s.role === 2
                  ? 'holding d2 — this tab offers the additive share'
                  : `joined as slot ${s.shareIndex}`,
          );
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setPhase('error');
          setError(e?.message || String(e));
          putLog('could not join 3P orbit');
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
      if (hb?.share && hb.share !== share) {
        setShare(hb.share);
      }
      if (hb?.orbit || hb?.holders || hb?.holder1 || hb?.seatEpoch != null) {
        setPool3p((prev) => ({
          ...(prev || {}),
          orbit: hb.orbit || prev?.orbit,
          seatEpoch: hb.seatEpoch ?? prev?.seatEpoch,
          holder1: hb.holder1 ?? prev?.holder1,
          holder2: hb.holder2 ?? prev?.holder2,
          holders: hb.holders || prev?.holders,
        }));
      }
      const active = hb?.share || share;
      const { status: st, pool3p: p3, results, openCount, lastVerify } =
        await contributeOpen(active);
      if (lastVerify) setVerify(lastVerify);
      if (p3) {
        setPool3p((prev) => ({
          ...(prev || {}),
          ...p3,
          holders: p3.holders || hb?.holders || prev?.holders,
        }));
      }
      setStatus(st);

      const liveN = p3?.orbit?.liveCount ?? hb?.orbit?.liveCount ?? 0;
      const last = results[results.length - 1] || {};
      const paidTx = last.payout?.txHash || last.txHash || null;
      const justPaid = Boolean(last.paid || last.alreadyPaid || paidTx);

      if (justPaid && paidTx) {
        signedUntil.current = Date.now() + SIGNED_HOLD_MS;
        setStats(
          await writeStats({
            signedCount: Number(stats.signedCount || 0) + 1,
            lastTicket: last.ticketId || null,
            lastPaid: true,
            lastTx: paidTx,
            lastAt: Date.now(),
            lastMsg: last.message || null,
            appendPaid: {
              ticketId: last.ticketId,
              txHash: paidTx,
              amountE8: last.amountE8 || last.payout?.amountE8,
              at: Date.now(),
            },
          }),
        );
        setPhase('signed');
        setError(null);
        putLog(`paid ${shortTicket(last.ticketId)} · ${shortTx(paidTx)}`);
        return;
      }

      if (last.fatal) {
        setPhase('error');
        setError(last.error || 'this tab cannot finish the ticket');
        putLog(last.error || 'cannot finish from this tab');
        return;
      }

      if (openCount === 0) {
        if (Date.now() < signedUntil.current) {
          setPhase('signed');
        } else {
          setPhase('online');
          setError(null);
          putLog(`${seatLabel(active)} · ${liveN} live · idle`);
        }
        return;
      }

      const waiting = last.waiting || last.orbitOnly;
      if (waiting || TRANSIENT.test(String(last.error || ''))) {
        setPhase('signing');
        if (!TRANSIENT.test(String(last.error || ''))) setError(null);
        else setError(null);
        putLog(
          last.waiting
            ? `room ${shortTicket(last.ticketId)} · waiting on the other seat`
            : last.orbitOnly
              ? `orbit attested ${shortTicket(last.ticketId)}`
              : `${seatLabel(active)} · ${shortTicket(last.ticketId)}`,
        );
        return;
      }

      setPhase('signing');
      setError(null);
      putLog(`signing ${shortTicket(last.ticketId)} · ${seatLabel(active)}`);
    } catch (e) {
      const msg = e?.message || String(e);
      if (TRANSIENT.test(msg)) {
        setPhase('signing');
        setError(null);
        putLog(msg.replace(/^Error:\s*/i, ''));
      } else {
        setPhase('error');
        setError(msg);
        putLog(msg);
      }
      if (
        /EPOCH_ROTATED|SEAT_ROTATED|share is dead|does not own|share material|missing Paillier/i.test(
          msg,
        )
      ) {
        try {
          const s = await loadActiveShare();
          setShare(s);
          putLog(`rejoined as ${seatLabel(s)}`);
          setPhase('online');
          setError(null);
        } catch {
          /* keep */
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

  const open = (status?.open || pool3p?.open || []).filter(
    (r) => !r.labDemo && !/^lab-demo-/.test(String(r.ticketId || '')),
  );
  const liveOrbit = pool3p?.orbit?.live || [];
  const liveN = pool3p?.orbit?.liveCount ?? liveOrbit.length;

  const paidList = useMemo(() => {
    const fromServer = (pool3p?.paid || []).map((p) => ({
      ticketId: p.ticketId,
      txHash: p.txHash,
      amountE8: p.amountE8,
      at: p.at,
    }));
    const fromLocal = stats.history || [];
    const seen = new Set();
    const out = [];
    for (const row of [...fromLocal, ...fromServer]) {
      const key = row.txHash || row.ticketId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out.slice(0, 16);
  }, [pool3p?.paid, stats.history]);

  const phaseLabel =
    !share && phase === 'error'
      ? 'Offline'
      : !share
        ? 'Joining'
        : phase === 'signing'
          ? open.length
            ? 'In the room'
            : 'Listening'
          : phase === 'signed'
            ? 'Paid'
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
          phase === 'signing' ? 'signing' : phase === 'error' ? 'err' : phase === 'signed' ? 'ok' : 'idle'
        }`}
      >
        <span className="pool-signer__dot" aria-hidden />
        <strong>{phaseLabel}</strong>
        <span className="pool-signer__count">
          {seatLabel(share)} · {liveN} live
        </span>
      </div>

      <p className="pool-signer__lead">
        {share ? (
          <>
            You are <code>{shortId(share.signerId)}</code>
            {share.role === 1
              ? ' · d1 finishes Lindell (Paillier stays in this tab)'
              : share.role === 2
                ? ' · d2 offers its share into the room'
                : ' · orbit voter (does not hold d1/d2)'}
            {pool3p?.clientBorn ? '. VPS has d_dapp only.' : ''}
          </>
        ) : (
          <>Joining the 3P orbit…</>
        )}
      </p>

      <div className="pool-signer__seats" aria-label="d1 and d2 holders">
        <div
          className={`pool-signer__seat${share?.role === 1 ? ' is-you' : ''}${
            pool3p?.holder1 ? ' is-held' : ''
          }`}
        >
          <span className="pool-signer__seat-k">d1</span>
          <strong>
            {share?.role === 1
              ? 'YOU'
              : pool3p?.holder1
                ? shortId(pool3p.holder1)
                : 'vacant'}
          </strong>
          <span>
            {share?.role === 1
              ? 'Lindell finish'
              : pool3p?.holder1
                ? pool3p.d1Live
                  ? 'live'
                  : 'assigned'
                : 'will rebuild from orbit pack'}
          </span>
        </div>
        <div
          className={`pool-signer__seat${share?.role === 2 ? ' is-you' : ''}${
            pool3p?.holder2 ? ' is-held' : ''
          }`}
        >
          <span className="pool-signer__seat-k">d2</span>
          <strong>
            {share?.role === 2
              ? 'YOU'
              : pool3p?.holder2
                ? shortId(pool3p.holder2)
                : 'vacant'}
          </strong>
          <span>
            {share?.role === 2
              ? 'additive share'
              : pool3p?.holder2
                ? pool3p.d2Live
                  ? 'live'
                  : 'assigned'
                : 'will rebuild from orbit pack'}
          </span>
        </div>
      </div>

      <p className="pool-signer__meta">{log}</p>
      {pool3p?.address ? (
        <p className="pool-signer__meta" style={{ wordBreak: 'break-all' }}>
          Pool {pool3p.address}
          {pool3p.clientBorn ? ' · client-born 3P' : ''}
        </p>
      ) : null}
      {verify && (
        <p className={`pool-signer__meta${verify.ok === false ? ' is-warn' : ''}`}>
          {formatVerifyLine(verify)}
        </p>
      )}
      {open.length > 0 && (
        <p className="pool-signer__meta">
          Open room: {open.map((r) => shortTicket(r.ticketId)).join(' · ')}
        </p>
      )}
      {error ? <p className="dash__error">{error}</p> : null}

      <ul className="pool-signer__slots" aria-label="live orbit">
        {liveOrbit.length === 0 ? (
          <li>No live orbit yet — this tab appears after the first heartbeat.</li>
        ) : (
          liveOrbit.map((id) => (
            <li key={id} className={id === share?.signerId ? 'is-me' : undefined}>
              {shortId(id)}
              {id === pool3p?.holder1 ? ' · d1' : ''}
              {id === pool3p?.holder2 ? ' · d2' : ''}
              {id === 'pool-3p-orbit-vps' ? ' · VPS' : ''}
              {id !== pool3p?.holder1 &&
              id !== pool3p?.holder2 &&
              id !== 'pool-3p-orbit-vps'
                ? ' · orbit'
                : ''}
              {id === share?.signerId ? ' · you' : ''}
            </li>
          ))
        )}
      </ul>

      <details className="pool-signer__history" open={paidList.length > 0}>
        <summary>
          Signed
          <span>{paidList.length}</span>
        </summary>
        {paidList.length === 0 ? (
          <p className="pool-signer__meta">No paid 3P withdraws in this tab yet.</p>
        ) : (
          <ul className="pool-signer__slots pool-signer__slots--history">
            {paidList.map((row) => (
              <li key={row.txHash || row.ticketId}>
                {row.amountE8 ? `${e8ToWart(row.amountE8) || '?'} WART · ` : ''}
                {shortTicket(row.ticketId)}
                {row.txHash ? (
                  <>
                    {' · '}
                    <code className="pool-signer__tx" title={row.txHash}>
                      {shortTx(row.txHash)}
                    </code>
                  </>
                ) : (
                  ' · submitted'
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
