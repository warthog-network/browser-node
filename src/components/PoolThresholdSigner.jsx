import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  contributeOpen,
  fetchPool3pStatus,
  fetchThresholdStatus,
  heartbeat,
  loadActiveShare,
  readEnabled,
  readPanelOpen,
  readStats,
  stopSigningLocal,
  writeEnabled,
  writePanelOpen,
  writeStats,
  DEFAULT_POOL_API,
} from '../lib/poolSigner.js';
import { formatVerifyLine } from '../lib/poolVerify.js';

const POLL_IDLE_MS = 2000;
const POLL_HOT_MS = 800;
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

/** Lab Cartesi epoch is 3s. Keep the extension clock moving between server polls. */
function useRotateDue(rotation) {
  const [due, setDue] = useState(
    rotation?.dueInEpochs == null ? null : Number(rotation.dueInEpochs),
  );
  const snap = useRef({
    due: rotation?.dueInEpochs,
    at: Date.now(),
  });
  useEffect(() => {
    snap.current = { due: rotation?.dueInEpochs, at: Date.now() };
    setDue(rotation?.dueInEpochs == null ? null : Number(rotation.dueInEpochs));
  }, [rotation?.dueInEpochs, rotation?.block, rotation?.phase]);
  useEffect(() => {
    const id = setInterval(() => {
      const s = snap.current;
      if (s.due == null || !Number.isFinite(Number(s.due))) return;
      const slipped = Math.floor((Date.now() - s.at) / 3000);
      setDue(Math.max(0, Number(s.due) - slipped));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return due;
}

export default function PoolThresholdSigner() {
  const [share, setShare] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState(null);
  const [pool3p, setPool3p] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [log, setLog] = useState('node ready — signing is opt-in');
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ signedCount: 0, history: [] });
  const [verify, setVerify] = useState(null);
  const tickLock = useRef(false);
  const lastLog = useRef('');
  const signedUntil = useRef(0);
  const hotRef = useRef(false);

  const putLog = (msg) => {
    if (!msg || msg === lastLog.current) return;
    lastLog.current = msg;
    setLog(msg);
  };

  const joinOrbit = useCallback(async () => {
    const s = await loadActiveShare();
    const p3 = await fetchPool3pStatus().catch(() => null);
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
    setPhase('online');
    return s;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const on = await readEnabled();
      const open = await readPanelOpen();
      const st = await readStats();
      if (cancelled) return;
      setEnabled(on);
      setPanelOpen(open);
      setStats(st);
      if (!on) {
        stopSigningLocal();
        setShare(null);
        setPhase('paused');
        putLog('signing off — this tab is a node only until you opt in');
        setReady(true);
        return;
      }
      try {
        await joinOrbit();
      } catch (e) {
        if (!cancelled) {
          setPhase('error');
          setError(e?.message || String(e));
          putLog('could not join 3P orbit');
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [joinOrbit]);

  const tick = useCallback(async () => {
    if (!share || !enabled || tickLock.current) return;
    tickLock.current = true;
    try {
      const hb = await heartbeat(share);
      if (hb?.share && hb.share !== share) {
        setShare(hb.share);
      }
      if (hb?.orbit || hb?.holders || hb?.holder1 || hb?.seatEpoch != null || hb?.rotation) {
        setPool3p((prev) => ({
          ...(prev || {}),
          orbit: hb.orbit || prev?.orbit,
          seatEpoch: hb.seatEpoch ?? prev?.seatEpoch,
          holder1: hb.holder1 ?? prev?.holder1,
          holder2: hb.holder2 ?? prev?.holder2,
          holders: hb.holders || prev?.holders,
          rotation: hb.rotation || prev?.rotation,
          packs: hb.packs || prev?.packs,
        }));
      }
      const active = hb?.share || share;
      const { status: st, pool3p: p3, results, openCount, lastVerify } =
        await contributeOpen(active);
      hotRef.current = Number(openCount || 0) > 0;
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
    let stopped = false;
    let tid;
    const loop = async () => {
      try {
        await tick();
      } catch {
        /* keep polling — a thrown tick used to kill the loop until refresh */
      }
      if (stopped) return;
      const hidden =
        typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const wait = hidden
        ? POLL_IDLE_MS
        : hotRef.current
          ? POLL_HOT_MS
          : POLL_IDLE_MS;
      tid = setTimeout(loop, wait);
    };
    const wake = () => {
      if (stopped || tickLock.current) return;
      clearTimeout(tid);
      loop();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    loop();
    return () => {
      stopped = true;
      clearTimeout(tid);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [share, enabled, tick]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await writeEnabled(next);
    if (!next) {
      stopSigningLocal();
      setShare(null);
      setPhase('paused');
      setError(null);
      putLog('signing off — left the 3P orbit (node still runs)');
      return;
    }
    setPhase('online');
    putLog('joining 3P orbit…');
    try {
      await joinOrbit();
    } catch (e) {
      setPhase('error');
      setError(e?.message || String(e));
      putLog('could not join 3P orbit');
    }
  };

  const togglePanel = async () => {
    const next = !panelOpen;
    setPanelOpen(next);
    await writePanelOpen(next);
  };

  const open = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of [...(pool3p?.open || []), ...(status?.open || [])]) {
      const id = String(r?.ticketId || '');
      if (!id || seen.has(id)) continue;
      if (r.labDemo || /^lab-demo-/.test(id)) continue;
      seen.add(id);
      out.push(r);
    }
    return out;
  }, [pool3p?.open, status?.open]);
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
    for (const row of [...fromServer, ...fromLocal]) {
      const key = row.ticketId || row.txHash;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out.slice(0, 16);
  }, [pool3p?.paid, stats.history]);

  const room = open[0] || null;
  const steps = {
    d1: !!(room?.steps?.d1 ?? room?.haveR1),
    d2: !!(room?.steps?.d2 ?? room?.haveD2),
    lindell: !!(room?.steps?.lindell ?? room?.hasPartial),
    paid: !!(room?.steps?.paid || phase === 'signed'),
  };
  const wait = room?.waitingOn || [];
  const lastErr = room?.lastError ? String(room.lastError).slice(0, 48) : '';
  const errStep = !lastErr
    ? null
    : wait.includes('d2') || wait.includes('d2-holder') || /d2/i.test(lastErr)
      ? 'd2'
      : wait.includes('d1') || /r1|\bd1\b/i.test(lastErr)
        ? 'd1'
        : wait.includes('lindell') || /lindell|partial|k1/i.test(lastErr)
          ? 'lindell'
          : wait.includes('notice-proof')
            ? !steps.d1
              ? 'd1'
              : !steps.d2
                ? 'd2'
                : 'lindell'
            : steps.lindell
              ? 'paid'
              : null;
  const stepHint = (key, idle, done) => {
    if (done) return idle;
    if (!room) return 'idle';
    if (errStep === key && lastErr) return `waiting · ${lastErr}`;
    return 'waiting';
  };
  const isOrbit = !share || share.waitlist || Number(share.role) === 0;
  const rotateDue = useRotateDue(pool3p?.rotation);
  const d1Pack = pool3p?.packs?.['1'] || pool3p?.packs?.[1];
  const d2Pack = pool3p?.packs?.['2'] || pool3p?.packs?.[2];

  const phaseLabel =
    !enabled
      ? 'Off'
      : !share && phase === 'error'
        ? 'Offline'
        : !share
          ? 'Joining'
          : phase === 'signed'
            ? 'Paid'
            : phase === 'error'
              ? 'Retrying'
              : room
                ? isOrbit
                  ? 'Attesting'
                  : 'In the room'
                : 'Listening';

  const controls = (
    <div className="pool-signer__controls">
      <button
        type="button"
        className={`btn btn--ghost${enabled ? ' is-on' : ''}`}
        onClick={toggle}
        disabled={!ready}
        title={
          enabled
            ? 'Leave the 3P orbit. The WASM node keeps running.'
            : 'Join the 3P orbit as a signer (attest tickets; may hold d1/d2).'
        }
      >
        {enabled ? 'Signing ON' : 'Signing OFF'}
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={togglePanel}
        aria-expanded={panelOpen}
        title={panelOpen ? 'Hide the signer dashboard' : 'Show the signer dashboard'}
      >
        {panelOpen ? 'Hide panel' : 'Show panel'}
      </button>
    </div>
  );

  if (!panelOpen) {
    return (
      <section className="panel pool-signer pool-signer--collapsed" aria-label="3P pool signer">
        <div className="panel__head">
          <h2>3P pool signer</h2>
          {controls}
        </div>
        <div
          className={`pool-signer__status is-${
            !enabled ? 'idle' : phase === 'signing' ? 'signing' : phase === 'error' ? 'err' : phase === 'signed' ? 'ok' : 'idle'
          }`}
        >
          <span className="pool-signer__dot" aria-hidden />
          <strong>{phaseLabel}</strong>
          <span className="pool-signer__count">
            {enabled ? `${seatLabel(share)} · ${liveN} live` : 'node only — not in the orbit'}
          </span>
        </div>
        {error ? <p className="dash__error">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="panel pool-signer" aria-label="3P pool signer">
      <div className="panel__head">
        <h2>3P pool signer</h2>
        {controls}
      </div>

      <div
        className={`pool-signer__status is-${
          phase === 'signing' ? 'signing' : phase === 'error' ? 'err' : phase === 'signed' ? 'ok' : 'idle'
        }`}
      >
        <span className="pool-signer__dot" aria-hidden />
        <strong>{phaseLabel}</strong>
        <span className="pool-signer__count">
          {enabled ? `${seatLabel(share)} · ${liveN} live` : 'node only — not in the orbit'}
        </span>
      </div>

      <p className="pool-signer__lead">
        {!enabled ? (
          <>
            This tab can run the WASM node without signing. Turn{' '}
            <strong>Signing ON</strong> to join the 3P orbit (attest tickets;
            you may be offered d1 or d2).
          </>
        ) : share ? (
          <>
            You are <code>{shortId(share.signerId)}</code>
            {share.role === 1
              ? ' · d1 finishes Lindell (Paillier stays in this tab)'
              : share.role === 2
                ? ' · d2 offers its share into the room'
                : ' · orbit voter: no d1/d2 share (expected) — you only attest'}
            {pool3p?.clientBorn ? '. VPS has d_dapp only.' : ''}
          </>
        ) : (
          <>Joining the 3P orbit…</>
        )}
      </p>

      {enabled ? (
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
      ) : null}

      {enabled ? (
        <>
          <ol className="pool-signer__steps" aria-label="ceremony progress">
            <li className={steps.d1 ? 'is-done' : 'is-wait'}>
              <span>1</span> d1 R1 {stepHint('d1', 'in', steps.d1)}
            </li>
            <li className={steps.d2 ? 'is-done' : 'is-wait'}>
              <span>2</span> d2 share {stepHint('d2', 'in', steps.d2)}
            </li>
            <li className={steps.lindell ? 'is-done' : 'is-wait'}>
              <span>3</span> Lindell {stepHint('lindell', 'combined', steps.lindell)}
            </li>
            <li className={steps.paid ? 'is-done' : 'is-wait'}>
              <span>4</span>{' '}
              {steps.paid
                ? 'broadcast'
                : errStep === 'paid' && lastErr
                  ? `held · ${lastErr}`
                  : room
                    ? isOrbit
                      ? 'orbit attested'
                      : 'broadcast'
                    : 'idle'}
            </li>
          </ol>
          {d1Pack && !d1Pack.ready ? (
            <p className="pool-signer__meta is-warn">
              d1 pack not on this orbit ({d1Pack.liveCovered || 0}/
              {d1Pack.liveNeed || 0} live) — the d1 tab must republish
            </p>
          ) : null}
          {d2Pack && !d2Pack.ready ? (
            <p className="pool-signer__meta is-warn">
              d2 pack not on this orbit ({d2Pack.liveCovered || 0}/
              {d2Pack.liveNeed || 0} live)
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
              {open.some((r) => Number(r.amountE8) > 0 && !r.steps?.paid)
                ? ' — stranded unlock: leave Signing ON to pay from the live Q'
                : ''}
            </p>
          )}
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
        </>
      ) : null}

      <p className="pool-signer__meta">{log}</p>
      {pool3p?.address ? (
        <p className="pool-signer__meta" style={{ wordBreak: 'break-all' }}>
          Pool {pool3p.address}
          {pool3p.clientBorn ? ' · client-born 3P' : ''}
        </p>
      ) : null}
      {pool3p?.rotation || rotateDue != null ? (
        <p className="pool-signer__rotate">
          Q rotate {pool3p?.rotation?.phase || 'idle'}
          {rotateDue != null ? ` · ${rotateDue} epochs left` : ''}
          {pool3p?.rotation?.intervalEpochs
            ? ` / ${pool3p.rotation.intervalEpochs}`
            : ''}
          {(() => {
            const need = pool3p?.rotation?.next?.needBirth || {};
            const bornBy = pool3p?.rotation?.next?.bornBy || {};
            const sid = share?.signerId;
            const role = Number(share?.role || 0);
            const can =
              (need[1] && bornBy[1] !== sid && (role === 1 || role === 0)) ||
              (need[2] && bornBy[2] !== sid && (role === 2 || role === 0));
            return can ? ' · this tab should birth the next Q' : '';
          })()}
          {pool3p?.rotation?.next?.address
            ? ` · next ${String(pool3p.rotation.next.address).slice(0, 12)}…`
            : ''}
        </p>
      ) : (
        <p className="pool-signer__rotate">Q rotate · waiting for coordinator clock</p>
      )}
      {error ? <p className="dash__error">{error}</p> : null}

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
