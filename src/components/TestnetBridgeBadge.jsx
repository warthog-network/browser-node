const TITLE =
  'This signer only joins the Cartesi ↔ Warthog DeFi testnet bridge (cartesi-bridge.duckdns.org). It never signs Warthog mainnet.';

/** Visual-only scope marker for pool signers. No signing / node side effects. */
export default function TestnetBridgeBadge() {
  return (
    <span className="pool-signer__net-badge" title={TITLE}>
      <span className="pool-signer__net-badge-dot" aria-hidden />
      Testnet-bridge only
    </span>
  );
}

export function TestnetBridgeScope() {
  return (
    <p className="pool-signer__scope">
      Cartesi ↔ Warthog DeFi testnet pool — not mainnet.{' '}
      <a href="https://cartesi-bridge.duckdns.org" target="_blank" rel="noreferrer">
        Open bridge
      </a>
    </p>
  );
}
