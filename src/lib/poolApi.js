/**
 * Coordinator API URL, shared by the WART and ETH signers (and anything else
 * that talks to /api/pool). One place so an override applies to every signer
 * in the tab — the ETH signer used to keep its own constant and silently kept
 * talking to production while the WART signer followed `?coordinator=`.
 */
export const DEFAULT_POOL_API = 'https://cartesi-bridge.duckdns.org/api/pool';
export const LAB_POOL_API = DEFAULT_POOL_API;
export const SEPOLIA_POOL_API = 'https://cartesi-bridge.duckdns.org/sepolia/api/pool';

const API_OVERRIDE_KEY = 'wart.poolSigner.api';
const L1_PREF_KEY = 'wart.l1';

/** Public Sepolia coordinator. Not the signer page's own origin. */
export function sepoliaPoolApi() {
  return SEPOLIA_POOL_API;
}

export function signerChain() {
  try {
    return localStorage.getItem(L1_PREF_KEY) === 'sepolia' ? 'sepolia' : 'anvil';
  } catch {
    return 'anvil';
  }
}

/**
 * Lab uses the live pool. Sepolia uses the public Sepolia pool path.
 * Default stays lab until this is called.
 */
export function setSignerChain(id) {
  const next = id === 'sepolia' ? 'sepolia' : 'anvil';
  localStorage.setItem(L1_PREF_KEY, next);
  localStorage.setItem(API_OVERRIDE_KEY, next === 'sepolia' ? SEPOLIA_POOL_API : LAB_POOL_API);
  return next;
}

/**
 * Coordinator API. Normally the production coordinator; a tab can be pointed
 * at a staging / lab coordinator with `?coordinator=<url>` — remembered in
 * localStorage — or cleared with `?coordinator=`. Never changes anything for
 * tabs that never used the parameter.
 *
 * Override URLs may be `http://` or `https://` and must end in `/api/pool`
 * (prod default stays `https://cartesi-bridge.duckdns.org/api/pool`). Browsers
 * block mixed content: an https page cannot call an http lab coordinator —
 * serve the signer over http for that lab, or put TLS on the coordinator.
 */
export function isPoolApiOverride(url) {
  return typeof url === 'string' && /^https?:\/\/[^\s]+\/api\/pool$/.test(url);
}

export function defaultPoolApi() {
  try {
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      if (q.has('coordinator')) {
        const v = String(q.get('coordinator') || '').trim();
        if (!v) {
          localStorage.removeItem(API_OVERRIDE_KEY);
          localStorage.removeItem(L1_PREF_KEY);
        } else if (isPoolApiOverride(v)) {
          localStorage.setItem(API_OVERRIDE_KEY, v);
          if (v === SEPOLIA_POOL_API) localStorage.setItem(L1_PREF_KEY, 'sepolia');
          else if (v === LAB_POOL_API) localStorage.setItem(L1_PREF_KEY, 'anvil');
          return v;
        }
      }
    }
    const pref = typeof localStorage !== 'undefined' ? localStorage.getItem(L1_PREF_KEY) : null;
    if (pref === 'sepolia') return SEPOLIA_POOL_API;
    if (pref === 'anvil') return LAB_POOL_API;
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(API_OVERRIDE_KEY) : null;
    if (saved && isPoolApiOverride(saved) && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(saved)) {
      return saved;
    }
  } catch {
    /* storage blocked — production coordinator */
  }
  return DEFAULT_POOL_API;
}
