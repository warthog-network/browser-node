import { useCallback, useEffect, useRef, useState } from 'react';
import {
  enrollEthSigner,
  fetchEth3pStatus,
  heartbeatEth,
  loadActiveEthShare,
  readEnabled,
  readPanelOpen,
  stopEthSigningLocal,
  writeEnabled,
  writePanelOpen,
} from '../lib/ethPoolSigner.js';

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
  if (share.role === 1) return 'e1 seat';
  if (share.role === 2) return 'e2 seat';
  return 'orbit';
}

export default function EthPoolThresholdSigner() {
  const [share, setShare] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [eth3p, setEth3p] = useState(null);
  const [log, setLog] = useState('ETH 3P off');
  const [error, setError] = useState(null);

  const join = useCallback(async () => {
    const s = await loadActiveEthShare();
    const st = await fetchEth3pStatus().catch(() => null);
    setShare(s);
    setEth3p(st);
    setLog(
      s.waitlist
        ? 'ETH orbit voter'
        : s.role === 1
          ? 'holding e1 — Enc(e1) stays in this tab'
          : s.role === 2
            ? 'holding e2'
            : 'joined ETH 3P',
    );
    setError(null);
    return s;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const on = await readEnabled();
      const open = await readPanelOpen();
      if (cancelled) return;
      setEnabled(on);
      setPanelOpen(open);
      if (!on) {
        stopEthSigningLocal();
        setReady(true);
        return;
      }
      try {
        await join();
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [join]);

  const shareRef = useRef(share);
  shareRef.current = share;
  useEffect(() => {
    if (!enabled) return undefined;
    let stop = false;
    let inflight = false;
    const tick = async () => {
      if (stop || inflight) return;
      inflight = true;
      try {
        const cur = shareRef.current;
        if (!cur) return;
        const hb = await heartbeatEth(cur);
        if (stop) return;
        if (hb?.share) setShare(hb.share);
        setEth3p((p) => ({
          ...(p || {}),
          holder1: hb.holder1 ?? p?.holder1,
          holder2: hb.holder2 ?? p?.holder2,
          orbit: hb.orbit || p?.orbit,
          address: hb.address || p?.address,
          e1Live: hb.orbit?.live?.includes(hb.holder1),
          e2Live: hb.orbit?.live?.includes(hb.holder2),
          open: hb.open ?? p?.open,
          lastPaid: hb.lastPaid ?? p?.lastPaid,
          burnBin: p?.burnBin,
        }));
        if ((hb.open || []).length) {
          setLog(
            hb.open[0].status === 'paid'
              ? `paid ${hb.open[0].txHash || ''}`.trim()
              : `room ${hb.open[0].ticketId} · ${hb.open[0].status}`,
          );
        }
      } catch (e) {
        if (!stop) setError(e?.message || String(e));
      } finally {
        inflight = false;
      }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [enabled]);

  const toggle = async () => {
    const next = !enabled;
    await writeEnabled(next);
    setEnabled(next);
    if (!next) {
      stopEthSigningLocal();
      setShare(null);
      setLog('ETH signing off');
      return;
    }
    try {
      await join();
    } catch (e) {
      setError(e?.message || String(e));
    }
  };

  const togglePanel = async () => {
    const next = !panelOpen;
    await writePanelOpen(next);
    setPanelOpen(next);
  };

  const liveN = eth3p?.orbit?.liveCount || 0;
  const room = (eth3p?.open || [])[0] || eth3p?.lastPaid || null;
  const steps = {
    e1: !!(room?.haveR1 || room?.R1Hex),
    e2: !!(room?.haveD2),
    lindell: !!(room?.hasPartial || room?.ciphertext || room?.status === 'partial' || room?.status === 'paid'),
    paid: room?.status === 'paid' || !!(room?.txHash || room?.payout?.txHash),
  };
  const phase =
    !enabled
      ? 'Off'
      : steps.paid
        ? 'Paid'
        : room && room.status !== 'paid'
          ? 'In the room'
          : seatLabel(share);
  const statusClass = steps.paid ? 'signed' : room && !steps.paid ? 'signing' : enabled ? 'idle' : 'idle';
  const controls = (
    <div className="pool-signer__controls">
      <button
        type="button"
        className={`btn btn--ghost${enabled ? ' is-on' : ''}`}
        onClick={toggle}
        disabled={!ready}
      >
        {enabled ? 'ETH Signing ON' : 'ETH Signing OFF'}
      </button>
      <button type="button" className="btn btn--ghost" onClick={togglePanel}>
        {panelOpen ? 'Hide ETH panel' : 'Show ETH panel'}
      </button>
    </div>
  );

  return (
    <section className={`panel pool-signer${panelOpen ? '' : ' pool-signer--collapsed'}`} aria-label="ETH 3P signer">
      <div className="panel__head">
        <h2>ETH 3P signer (e1 / e2)</h2>
        {controls}
      </div>
      <div className={`pool-signer__status is-${statusClass}`}>
        <span className="pool-signer__dot" aria-hidden />
        <strong>{phase}</strong>
        <span className="pool-signer__count">
          {enabled
            ? `${seatLabel(share)} · ${liveN} live · ${eth3p?.address ? 'Q sealed' : 'unsealed'}`
            : 'not in ETH orbit'}
        </span>
      </div>
      {error ? <p className="dash__error">{error}</p> : null}
      {panelOpen ? (
        <>
          <p className="pool-signer__lead">
            Separate from WART d1/d2. Two tabs with ETH Signing ON birth the Ethereum 3P Q.
            {share?.signerId ? (
              <>
                {' '}
                You are <code>{shortId(share.signerId)}</code>
              </>
            ) : null}
          </p>
          {enabled ? (
            <div className="pool-signer__seats" aria-label="e1 and e2 holders">
              <div className={`pool-signer__seat${share?.role === 1 ? ' is-you' : ''}${eth3p?.holder1 ? ' is-held' : ''}`}>
                <span className="pool-signer__seat-k">e1</span>
                <strong>
                  {share?.role === 1 ? 'YOU' : eth3p?.holder1 ? shortId(eth3p.holder1) : 'vacant'}
                </strong>
              </div>
              <div className={`pool-signer__seat${share?.role === 2 ? ' is-you' : ''}${eth3p?.holder2 ? ' is-held' : ''}`}>
                <span className="pool-signer__seat-k">e2</span>
                <strong>
                  {share?.role === 2 ? 'YOU' : eth3p?.holder2 ? shortId(eth3p.holder2) : 'vacant'}
                </strong>
              </div>
            </div>
          ) : null}
          {enabled ? (
            <ol className="pool-signer__steps" aria-label="ETH Lindell progress">
              <li className={steps.e1 ? 'is-done' : 'is-wait'}>
                <span>1</span> e1 R1 {steps.e1 ? 'in' : room ? 'waiting' : 'idle'}
              </li>
              <li className={steps.e2 ? 'is-done' : 'is-wait'}>
                <span>2</span> e2 share {steps.e2 ? 'in' : room ? 'waiting' : 'idle'}
              </li>
              <li className={steps.lindell ? 'is-done' : 'is-wait'}>
                <span>3</span> Lindell {steps.lindell ? 'combined' : room ? 'waiting' : 'idle'}
              </li>
              <li className={steps.paid ? 'is-done' : 'is-wait'}>
                <span>4</span> {steps.paid ? 'broadcast' : room ? 'broadcast' : 'idle'}
              </li>
            </ol>
          ) : null}
          {room ? (
            <p className="pool-signer__meta">
              {steps.paid ? 'paid' : 'open'} {shortTicket(room.ticketId)}
              {room.txHash || room.payout?.txHash
                ? ` · ${shortTx(room.txHash || room.payout.txHash)}`
                : ''}
            </p>
          ) : null}
          <p className="pool-signer__meta">
            {eth3p?.address ? `ETH Q ${eth3p.address}` : 'Waiting for e1 + e2 birth'}
            {eth3p?.burnBin ? ` · burn bin ${shortId(eth3p.burnBin)}` : ''}
          </p>
          <p className="pool-signer__meta">{log}</p>
        </>
      ) : null}
    </section>
  );
}
