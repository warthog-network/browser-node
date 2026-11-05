/**
 * Pool-rotation step gauge for browser signers (WART + ETH 3P).
 * Reads the public `rotation` view from pool3p_status / eth3p_status /
 * heartbeat: phase, lastError, optional phaseSince — no secrets.
 * Steps: Announced → Sweeping → Cutover → Done (idle).
 *
 * Demo: only when build sets PUBLIC_ROTATE_DEMO=1, then ?demoPhase=sweeping
 * (or announced|cutover|need_birth|next_ready|idle). Off in production builds.
 */
import { useEffect, useRef, useState } from 'react';

const STEPS = [
  { key: 'announced', label: 'Announced' },
  { key: 'sweeping', label: 'Sweeping' },
  { key: 'cutover', label: 'Cutover' },
  { key: 'idle', label: 'Done' },
];

/** need_birth / next_ready are the pre-announce half of step 1. */
function stepIndex(phase) {
  switch (phase) {
    case 'need_birth':
    case 'next_ready':
    case 'announced':
      return 0;
    case 'sweeping':
      return 1;
    case 'cutover':
      return 2;
    default:
      return 3;
  }
}

const PHASE_LABEL = {
  need_birth: 'Preparing next pool key',
  next_ready: 'Next pool key ready — announcing',
  announced: 'Announced',
  sweeping: 'Sweeping funds to the next pool',
  cutover: 'Cutting over to the next pool',
  idle: 'Rotation done',
};

/** Short human explanation of what the rotation is waiting on. */
export function explainRotation(phase, lastError) {
  const e = String(lastError || '');
  let m;
  if ((m = e.match(/need (\d+) confs?, have (\d+)/i)))
    return `Waiting for cutover confirmations (${m[2]}/${m[1]})`;
  if ((m = e.match(/has (\d+)\/(\d+) confirmations?/i)))
    return `Waiting for ${m[2]} confirmations (${m[1]}/${m[2]})`;
  if (/still unmined|unmined|not mined/i.test(e)) return 'Waiting for the sweep transaction to be mined';
  if (/pendingNext is not next Q/i.test(e)) return 'Waiting for the machine to register the next pool address';
  if (/inspect down/i.test(e)) return 'Waiting for the rollup inspect endpoint';
  if (/room\(s\) open|room still open/i.test(e)) return 'Waiting for open redeem rooms to finish';
  if (/next packs|re-sign|R1/i.test(e)) return 'Waiting for signers to sign the sweep';
  if (/machine replaying/i.test(e)) return 'Waiting for the rollup machine to catch up';
  if (/locked or unconfirmed/i.test(e)) return 'Waiting for the pool balance to confirm';
  if (/reserved for unpaid/i.test(e)) return 'Waiting for pending payouts to finish';
  if (/^cutover/i.test(e) || phase === 'cutover') return 'Waiting for cutover confirmations';
  if (phase === 'sweeping') return 'Waiting for the sweep transaction';
  if (phase === 'need_birth') return 'Waiting for browser signers to create the next key';
  if (phase === 'next_ready' || phase === 'announced') return 'Waiting for the announce to land on-chain';
  return null;
}

function fmtElapsed(ms) {
  if (!(ms >= 0)) return null;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

/** Accept epoch ms, numeric string, or ISO — missing/invalid → null. */
function coerceSince(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  const fromIso = Date.parse(String(v));
  if (Number.isFinite(fromIso) && fromIso > 0) return fromIso;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Vite/Astro static-replace — no optional chaining on import.meta.env.PUBLIC_*.
const DEMO =
  import.meta.env.PUBLIC_ROTATE_DEMO === '1' && typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('demoPhase')
    : null;

export default function RotationGauge({ asset, rotation }) {
  let phase = rotation?.phase || 'idle';
  let lastError = rotation?.lastError || null;
  let phaseSince =
    coerceSince(rotation?.phaseSince) || coerceSince(rotation?.nextStartedAt);
  if (DEMO) {
    phase = DEMO;
    lastError =
      {
        sweeping: 'sweep wait: 0xabc… still unmined',
        cutover: 'cutover: need 2 confs, have 1',
        announced: 'sweep wait: inspect pendingNext is not next Q',
        need_birth: null,
        next_ready: null,
      }[DEMO] || null;
    phaseSince = Date.now() - 95_000;
  }

  const seen = useRef({ phase: null, at: null });
  const [doneAt, setDoneAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  if (seen.current.phase !== phase) {
    if (phase === 'idle' && seen.current.phase && seen.current.phase !== 'idle') {
      // Show "Done" briefly after a rotation we watched finish.
      queueMicrotask(() => setDoneAt(Date.now()));
    }
    seen.current = { phase, at: Date.now() };
  }

  const active = phase !== 'idle';
  const showDone = !active && doneAt && now - doneAt < 60_000;

  useEffect(() => {
    if (!active && !showDone) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, showDone]);

  if (!active && !showDone) return null;

  const cur = stepIndex(phase);
  const serverSince = phaseSince;
  const since = serverSince || seen.current.at;
  const elapsed = active && since ? fmtElapsed(now - since) : null;
  const why = active ? explainRotation(phase, lastError) : null;
  const pct = Math.round((cur / (STEPS.length - 1)) * 100);
  const label = PHASE_LABEL[phase] || phase;

  return (
    <div className={`pool-signer__rot${active ? ' is-active' : ' is-done'}`}>
      <div className="pool-signer__rot-head">
        {active ? (
          <span className="pool-signer__rot-spinner" aria-hidden="true" />
        ) : (
          <span className="pool-signer__rot-check" aria-hidden="true">
            ✓
          </span>
        )}
        <strong className="pool-signer__rot-title">
          {asset} pool {active ? 'rotating' : 'rotated'}
        </strong>
        <span className="pool-signer__rot-phase">{label}</span>
        {elapsed ? (
          <span
            className="pool-signer__rot-elapsed"
            title={serverSince ? 'since phase started' : 'since first seen in this tab'}
          >
            {elapsed}
          </span>
        ) : null}
      </div>
      <ol
        className="pool-signer__rot-steps"
        role="progressbar"
        aria-label={`${asset} pool rotation progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={showDone ? 100 : pct}
        aria-valuetext={`${label} (step ${Math.min(cur + 1, STEPS.length)} of ${STEPS.length})`}
      >
        {STEPS.map((s, i) => {
          const st = showDone || i < cur ? 'done' : i === cur ? 'current' : 'pending';
          return (
            <li
              key={s.key}
              className={`pool-signer__rot-step is-${st}`}
              aria-current={st === 'current' ? 'step' : undefined}
            >
              <span className="pool-signer__rot-dot" aria-hidden="true">
                {st === 'done' ? (
                  '✓'
                ) : st === 'current' ? (
                  <span className="pool-signer__rot-spinner is-sm" />
                ) : (
                  i + 1
                )}
              </span>
              <span className="pool-signer__rot-label">{s.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="pool-signer__rot-why" aria-live="polite">
        {active
          ? `${why || 'Working'}. Deposits and redeems resume after cutover.`
          : 'New pool address is live.'}
      </p>
    </div>
  );
}
