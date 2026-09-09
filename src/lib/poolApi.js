/**
 * Coordinator API URL, shared by the WART and ETH signers (and anything else
 * that talks to /api/pool). One place so an override applies to every signer
 * in the tab — the ETH signer used to keep its own constant and silently kept
 * talking to production while the WART signer followed `?coordinator=`.
 */
export const DEFAULT_POOL_API = 'https://cartesi-bridge.duckdns.org/api/pool';

const API_OVERRIDE_KEY = 'wart.poolSigner.api';

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
        if (v) localStorage.setItem(API_OVERRIDE_KEY, v);
        else localStorage.removeItem(API_OVERRIDE_KEY);
      }
    }
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(API_OVERRIDE_KEY) : null;
    if (saved && isPoolApiOverride(saved)) return saved;
  } catch {
    /* storage blocked — production coordinator */
  }
  return DEFAULT_POOL_API;
}
