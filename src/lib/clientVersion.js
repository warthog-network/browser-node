/**
 * Which build is this tab, and is a newer one deployed?
 *
 * A signer tab left open for a week never sees a fix — every fix ships as a
 * bundle change, and the coordinator cannot push code. So the tab polls
 * /version.json, tells the coordinator its version on each heartbeat, and
 * reloads itself when it is behind and it is safe to do so.
 */
/* global __CLIENT_VERSION__, __CLIENT_BUILT_AT__ */
export const CLIENT_VERSION =
  typeof __CLIENT_VERSION__ !== 'undefined' ? String(__CLIENT_VERSION__) : 'dev';
export const CLIENT_BUILT_AT =
  typeof __CLIENT_BUILT_AT__ !== 'undefined' ? String(__CLIENT_BUILT_AT__) : null;

export const EXTENSION_ZIP_URL = 'https://browser-node.netlify.app/downloads/warthog_node_extension.zip';
const CHECK_MS = 5 * 60 * 1000;
const RELOADED_KEY = 'wart.clientVersion.reloadedFor';

export function isExtensionPage() {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

const state = {
  current: CLIENT_VERSION,
  latest: null,
  latestBuiltAt: null,
  outdated: false,
  checkedAt: 0,
  error: null,
  reloadBlockedBy: null,
};
const listeners = new Set();
function emit() {
  for (const fn of listeners) {
    try {
      fn({ ...state });
    } catch {
      /* */
    }
  }
}
export function getUpdateState() {
  return { ...state };
}
export function subscribeUpdateState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The site's /version.json — the extension checks the site too (same build line). */
function versionUrl() {
  return isExtensionPage() ? 'https://browser-node.netlify.app/version.json' : '/version.json';
}

export async function checkForUpdate() {
  if (CLIENT_VERSION === 'dev') return getUpdateState();
  try {
    const res = await fetch(versionUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`version.json HTTP ${res.status}`);
    const j = await res.json();
    state.latest = String(j.version || '') || null;
    state.latestBuiltAt = j.builtAt || null;
    state.outdated = !!(state.latest && state.latest !== CLIENT_VERSION);
    state.error = null;
  } catch (e) {
    state.error = e?.message || String(e);
  }
  state.checkedAt = Date.now();
  emit();
  return getUpdateState();
}

function alreadyReloadedFor(version) {
  try {
    return sessionStorage.getItem(RELOADED_KEY) === version;
  } catch {
    return false;
  }
}
function markReloadedFor(version) {
  try {
    sessionStorage.setItem(RELOADED_KEY, version);
  } catch {
    /* */
  }
}

/**
 * Reload when behind — but only when nothing is mid-flight. `isSafeToReload`
 * is the signer's word (no open room; a held seat is packed). A tab that is
 * not safe keeps the banner and tries again next check. One reload per
 * version: if the CDN still serves the old bundle we do not loop.
 */
export function startUpdateWatcher({ isSafeToReload = () => true, intervalMs = CHECK_MS } = {}) {
  if (typeof window === 'undefined') return () => {};
  let timer = null;
  const tick = async () => {
    const st = await checkForUpdate();
    if (!st.outdated || isExtensionPage()) return;
    if (alreadyReloadedFor(st.latest)) {
      state.reloadBlockedBy = 'already reloaded for this version — CDN may still serve the old bundle';
      emit();
      return;
    }
    const why = isSafeToReload();
    if (why === true) {
      markReloadedFor(st.latest);
      window.location.reload();
      return;
    }
    state.reloadBlockedBy = typeof why === 'string' ? why : 'signer busy';
    emit();
  };
  timer = setInterval(tick, intervalMs);
  const onVis = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVis);
  setTimeout(tick, 15000);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVis);
  };
}

/** Manual reload from the banner: never blocked, but still one per version. */
export function reloadNow() {
  if (state.latest) markReloadedFor(state.latest);
  window.location.reload();
}
