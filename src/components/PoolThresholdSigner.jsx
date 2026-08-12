import { useCallback, useEffect, useRef, useState } from 'react';
import {
  contributeOpen,
  fetchThresholdStatus,
  heartbeat,
  loadActiveShare,
  readEnabled,
  readStats,
  saveOverrideShare,
  clearOverrideShare,
  writeEnabled,
  writeStats,
  DEFAULT_POOL_API,
} from '../lib/poolSigner.js';

const POLL_MS = 2500;

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
  const [log, setLog] = useState('idle');
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ signedCount: 0 });
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const tickLock = useRef(false);
  const fileRef = useRef(null);

  const refreshShare = useCallback(async () => {
    const s = await loadActiveShare();
    setShare(s);
    return s;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, on, st] = await Promise.all([
        loadActiveShare(),
        readEnabled(),
        readStats(),
      ]);
      if (!cancelled) {
        setShare(s);
        setEnabled(on);
        setStats(st);
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
      const hb = await heartbeat(share).catch(() => null);
      const { status: st, results, openCount } = await contributeOpen(share);
      setStatus(st);
      setError(null);

      const me = (st.signers?.slots || []).find(
        (x) => x.signerId === share.signerId,
      );
      const serverCount = Number(me?.signedCount ?? hb?.signedCount ?? 0);

      if (openCount === 0) {
        setPhase('online');
        setLog(
          `online · need ${st.t || 3} of ${st.signers?.enrolled || '?'} unique`,
        );
        if (serverCount > Number(stats.signedCount || 0)) {
          const next = await writeStats({ signedCount: serverCount });
          setStats(next);
        }
        return;
      }

      setPhase('signing');
      const last = results[results.length - 1] || {};
      const fresh = results.filter((r) => r.contributed && !r.alreadyHad);
      if (fresh.length) {
        const next = await writeStats({
          signedCount: Math.max(serverCount, Number(stats.signedCount || 0) + fresh.length),
          lastTicket: last.ticketId || null,
          lastPaid: Boolean(last.paid),
          lastTx: last.payout?.txHash || null,
          lastAt: Date.now(),
          lastMsg: last.message || null,
        });
        setStats(next);
      } else if (serverCount > Number(stats.signedCount || 0)) {
        const next = await writeStats({ signedCount: serverCount });
        setStats(next);
      }

      if (last.paid) {
        setPhase('signed');
        setLog(
          `signed ${shortTicket(last.ticketId)} · paid ${String(last.payout?.txHash || '').slice(0, 10)}…`,
        );
      } else {
        setLog(
          `signing ${shortTicket(last.ticketId)} · ${last.count || '?'}/${last.need || st.t || 3}`,
        );
      }
    } catch (e) {
      setPhase('error');
      setError(e?.message || String(e));
      try {
        const st = await fetchThresholdStatus(DEFAULT_POOL_API);
        setStatus(st);
      } catch {
        /* keep last status */
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

  const onImport = async () => {
    try {
      const obj = JSON.parse(importText);
      const s = await saveOverrideShare(obj);
      setShare(s);
      setImportOpen(false);
      setImportText('');
      setError(null);
      setLog(`imported ${s.signerId} · slot ${s.shareIndex}`);
    } catch (e) {
      setError(e?.message || 'Import failed');
    }
  };

  const onFile = async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      setImportText(text);
      const obj = JSON.parse(text);
      const s = await saveOverrideShare(obj);
      setShare(s);
      setImportOpen(false);
      setError(null);
      setLog(`imported ${s.signerId} · slot ${s.shareIndex}`);
    } catch (e) {
      setError(e?.message || 'File import failed');
    }
    ev.target.value = '';
  };

  const onClearImport = async () => {
    await clearOverrideShare();
    const s = await refreshShare();
    setLog(s ? `back to baked ${s.signerId}` : 'no share');
  };

  const signers = status?.signers;
  const slots = signers?.slots || [];
  const issued = slots.filter((s) => s.issued);
  const me = issued.find((s) => share && s.signerId === share.signerId);
  const displayCount = Math.max(
    Number(stats.signedCount || 0),
    Number(me?.signedCount || 0),
  );
  const open = status?.open || [];
  const need = status?.t || signers?.policyT || 3;
  const enrolled = signers?.enrolled || issued.length || 0;

  const phaseLabel =
    phase === 'signing'
      ? 'Signing now'
      : phase === 'signed'
        ? 'Just signed'
        : phase === 'error'
          ? 'Retrying'
          : enabled && share
            ? 'Listening'
            : share
              ? 'Paused'
              : 'No share';

  return (
    <section className="panel pool-signer" aria-label="Pool threshold signer">
      <div className="panel__head">
        <h2>Pool signer</h2>
        {share ? (
          <button
            type="button"
            className={`btn btn--ghost${enabled ? ' is-on' : ''}`}
            onClick={toggle}
          >
            {enabled ? 'Signing ON' : 'Signing OFF'}
          </button>
        ) : null}
      </div>

      <div className={`pool-signer__status is-${phase === 'signing' ? 'signing' : phase === 'error' ? 'err' : 'idle'}`}>
        <span className="pool-signer__dot" aria-hidden />
        <strong>{phaseLabel}</strong>
        <span className="pool-signer__count">
          signed {displayCount} ticket{displayCount === 1 ? '' : 's'}
        </span>
      </div>

      {!share ? (
        <p className="pool-signer__lead">
          No unique share on this device. Import a <code>signer-share.json</code>{' '}
          (phone vs desktop must be <em>different</em> slots).
        </p>
      ) : (
        <>
          <p className="pool-signer__lead">
            <code>{share.signerId}</code> · slot {share.shareIndex}
            {share.source === 'imported' ? ' · imported' : ' · baked'}
            {' · '}
            need {need} of {enrolled} unique
          </p>
          <p className="pool-signer__meta">{log}</p>
          {open.length > 0 && (
            <p className="pool-signer__meta">
              Open: {open.map((r) => `${shortTicket(r.ticketId)} ${r.count}/${r.need}`).join(' · ')}
            </p>
          )}
          {stats.lastTicket && (
            <p className="pool-signer__meta">
              Last: {shortTicket(stats.lastTicket)}
              {stats.lastPaid ? ' · paid' : ''}
              {stats.lastAt
                ? ` · ${new Date(stats.lastAt).toLocaleTimeString()}`
                : ''}
            </p>
          )}
        </>
      )}

      {error ? <p className="dash__error">{error}</p> : null}

      {issued.length > 0 && (
        <ul className="pool-signer__slots">
          {issued.map((s) => (
            <li
              key={s.shareIndex}
              className={s.signerId === share?.signerId ? 'is-me' : undefined}
            >
              #{s.shareIndex} {s.signerId}
              {s.role ? ` · ${s.role}` : ''}
              {s.signedCount ? ` · ${s.signedCount} signed` : ''}
              {s.lastSeen ? ' · seen' : ' · offline'}
            </li>
          ))}
        </ul>
      )}

      <div className="pool-signer__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setImportOpen((v) => !v)}
        >
          {importOpen ? 'Close import' : 'Import other device share'}
        </button>
        {share?.source === 'imported' && (
          <button type="button" className="btn btn--ghost" onClick={onClearImport}>
            Use baked share
          </button>
        )}
      </div>

      {importOpen && (
        <div className="pool-signer__import">
          <p className="pool-signer__lead">
            Phone and desktop need <strong>different</strong> unique shares. Same
            file twice still counts as one signer.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={onFile}
          />
          <textarea
            rows={4}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder='{"signerId":"phone-browser-node","shareIndex":5,"shareHex":"…"}'
          />
          <button type="button" className="btn btn--ghost" onClick={onImport}>
            Save imported share
          </button>
        </div>
      )}
    </section>
  );
}
