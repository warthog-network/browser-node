/**
 * Browser-node networks: Official1 mainnet (0.9.6) vs DeFi testnet (0.10.22).
 *
 * Different GRUNT magic, DB schema, and WASM triad — never mix peers or OPFS.
 * DeFi triad lives at /node/defi/; Official1 stays at /node/.
 */

import {
  DEFI_TESTNET,
  OFFICIAL1,
  LOCAL_WS_BRIDGE_PATH,
  isExtensionPage,
  isLocalDevHost,
  localDevWsBridgeUrl,
} from './bridge.js';

/** Dev proxy path → warthog-defitestnet.duckdns.org/ws (astro.config).
 * Not `/ws-bridge-defi`: Vite would prefix-match `/ws-bridge` (Official1). */
export const LOCAL_WS_BRIDGE_DEFI_PATH = '/ws-defi';

export const NODE_NETWORKS = {
  official1: {
    id: 'official1',
    label: 'Official1 (mainnet)',
    shortLabel: 'Official1',
    httpBase: OFFICIAL1.httpBase,
    wsBridge: OFFICIAL1.wsBridge,
    wsStream: OFFICIAL1.wsStream,
    glueUrl: '/node/wart-node.js',
    assetDir: '/node',
    argv: ['--enable-webrtc'],
    session: '/opfs',
    /** null = chain.db3 at OPFS root (existing Official1 layout). */
    opfsSubdir: null,
    version: { major: 0, minor: 9, patch: 6 },
    versionText: '0.9.6',
    gruntConnect: 'WARTHOG GRUNT?',
    gruntAccept: 'WARTHOG GRUNT!',
    testnet: false,
    flags: OFFICIAL1.flags,
  },
  defi: {
    id: 'defi',
    label: 'DeFi testnet',
    shortLabel: 'DeFi testnet',
    httpBase: DEFI_TESTNET.httpBase,
    wsBridge: DEFI_TESTNET.wsBridge,
    wsStream: DEFI_TESTNET.wsStream,
    glueUrl: '/node/defi/wart-node.js',
    assetDir: '/node/defi',
    argv: ['--testnet', '--enable-webrtc', '--session', '/opfs/defi'],
    session: '/opfs/defi',
    opfsSubdir: 'defi',
    version: { major: 0, minor: 10, patch: 22 },
    versionText: '0.10.22',
    gruntConnect: 'TESTNET GRUNT?',
    gruntAccept: 'TESTNET GRUNT!',
    testnet: true,
    flags: ['--testnet', '--enable-webrtc'],
  },
};

export const NODE_NETWORK_LIST = [NODE_NETWORKS.official1, NODE_NETWORKS.defi];

export const DEFAULT_NODE_NETWORK_ID = 'official1';

const NETWORK_QUERY_ALIASES = {
  defi: 'defi',
  testnet: 'defi',
  defitestnet: 'defi',
  'defi-testnet': 'defi',
  official1: 'official1',
  official: 'official1',
  mainnet: 'official1',
};

export function getNodeNetwork(id) {
  return NODE_NETWORKS[id] || NODE_NETWORKS[DEFAULT_NODE_NETWORK_ID];
}

export function resolveNodeNetworkId(
  search = typeof window !== 'undefined' ? window.location.search : '',
) {
  try {
    const q = new URLSearchParams(search).get('network')
      || new URLSearchParams(search).get('net')
      || '';
    const aliased = NETWORK_QUERY_ALIASES[String(q).trim().toLowerCase()];
    if (aliased) return aliased;
  } catch {
    // ignore
  }
  try {
    const stored = localStorage.getItem('wartNetwork');
    if (stored && NODE_NETWORKS[stored]) return stored;
  } catch {
    // ignore
  }
  return DEFAULT_NODE_NETWORK_ID;
}

export function persistNodeNetworkId(id) {
  if (!NODE_NETWORKS[id]) return;
  try {
    localStorage.setItem('wartNetwork', id);
  } catch {
    // ignore
  }
}

export function peersStorageKey(networkId) {
  return `wsPeers:${getNodeNetwork(networkId).id}`;
}

export function defaultWsPeersForNetwork(
  networkId,
  loc = typeof window !== 'undefined' ? window.location : null,
) {
  const net = getNodeNetwork(networkId);
  if (loc && isExtensionPage(loc)) return net.wsBridge;
  if (loc && isLocalDevHost(loc.hostname)) {
    const path = net.testnet ? LOCAL_WS_BRIDGE_DEFI_PATH : LOCAL_WS_BRIDGE_PATH;
    return localDevWsBridgeUrl(loc, path);
  }
  return net.wsBridge;
}

/** True when a stored peer list belongs to a different network than `networkId`. */
export function peersLookCrossNetwork(peers, networkId) {
  const raw = String(peers || '');
  const net = getNodeNetwork(networkId);
  if (net.testnet) {
    return /warthognode\.duckdns\.org/i.test(raw) && !/defitestnet/i.test(raw);
  }
  return /warthog-defitestnet\.duckdns\.org/i.test(raw);
}
