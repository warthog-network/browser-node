/**
 * Local-only preview for rotation gauge screenshots.
 * Built with PUBLIC_ROTATE_DEMO=1 — not shipped in production.
 */
import { createRoot } from 'react-dom/client';
import RotationGauge from '../src/components/RotationGauge.jsx';
import '../src/styles/global.css';
import '../src/components/NodeDashboard.css';

function Panel({ asset, title, eth }) {
  return (
    <section className={`panel pool-signer${eth ? ' pool-signer--eth' : ''}`} aria-label={title}>
      <div className="panel__head">
        <div className="pool-signer__title">
          <h2>{title}</h2>
        </div>
      </div>
      <div className="pool-signer__status is-idle">
        <span className="pool-signer__dot" aria-hidden />
        <strong>watching rotation</strong>
        <span className="pool-signer__count">demo · {asset}</span>
      </div>
      <RotationGauge asset={asset} rotation={{ phase: 'idle' }} />
      <p className="pool-signer__rotate">
        {asset === 'WART' ? 'Q' : 'e1/e2'} rotate (demo) · epochs left hidden while rotating
      </p>
    </section>
  );
}

function App() {
  const phase = new URLSearchParams(location.search).get('demoPhase') || 'sweeping';
  // Force query so RotationGauge DEMO branch sees it even if URL was bare.
  if (!new URLSearchParams(location.search).get('demoPhase')) {
    const u = new URL(location.href);
    u.searchParams.set('demoPhase', phase);
    history.replaceState(null, '', u);
  }
  return (
    <div className="dash" style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <header className="dash__header" style={{ marginBottom: '1rem' }}>
        <div className="dash__brand">
          <h1>Rotation gauge preview</h1>
          <p className="dash__subtitle">local demo · phase={phase} · not production</p>
        </div>
      </header>
      <Panel asset="WART" title="3P pool signer" />
      <Panel asset="ETH" title="ETH 3P signer" eth />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
