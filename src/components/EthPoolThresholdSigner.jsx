import { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => {
    if (!enabled || !share) return undefined;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const hb = await heartbeatEth(share);
        if (hb?.share) setShare(hb.share);
        if (hb?.holder1 || hb?.orbit) {
          setEth3p((p) => ({
            ...(p || {}),
            holder1: hb.holder1 ?? p?.holder1,
            holder2: hb.holder2 ?? p?.holder2,
            orbit: hb.orbit || p?.orbit,
            address: hb.address || p?.address,
            seatsReady: p?.seatsReady,
          }));
        }
        const st = await fetchEth3pStatus().catch(() => null);
        if (st) setEth3p(st);
      } catch (e) {
        setError(e?.message || String(e));
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [enabled, share]);

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
      <div className={`pool-signer__status is-${enabled ? 'idle' : 'idle'}`}>
        <span className="pool-signer__dot" aria-hidden />
        <strong>{enabled ? seatLabel(share) : 'Off'}</strong>
        <span className="pool-signer__count">
          {enabled ? `${liveN} live · ${eth3p?.address ? 'Q sealed' : 'unsealed'}` : 'not in ETH orbit'}
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
