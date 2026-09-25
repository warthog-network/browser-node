import { useEffect, useState } from 'react';
import {
  CLIENT_VERSION,
  EXTENSION_ZIP_URL,
  getUpdateState,
  isExtensionPage,
  reloadNow,
  setAutoReloadEnabled,
  startUpdateWatcher,
  subscribeUpdateState,
} from '../lib/clientVersion.js';
import { isSafeToReload } from '../lib/signerSafety.js';

function AutoUpdateToggle({ on }) {
  if (isExtensionPage()) return null;
  return (
    <label
      className="update-banner__auto"
      title="When a new build is deployed, reload this tab once signing is idle. If the node was on, it starts again."
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => setAutoReloadEnabled(e.target.checked)}
      />
      Auto-update
    </label>
  );
}

/**
 * "A newer build is deployed" — with a reload button, and an automatic reload
 * once the signers say it is safe. The extension cannot reload into new code
 * (unpacked builds do not self-update), so it links the zip instead.
 */
export default function UpdateBanner() {
  const [st, setSt] = useState(getUpdateState());
  useEffect(() => {
    const unsub = subscribeUpdateState(setSt);
    const stop = startUpdateWatcher({ isSafeToReload });
    return () => {
      unsub();
      stop();
    };
  }, []);
  const ext = isExtensionPage();
  if (!st.outdated) {
    // Always say which build this is — a tab that looks fine but is a week
    // behind is exactly the case nobody notices.
    const checked = st.checkedAt ? new Date(st.checkedAt).toLocaleTimeString() : null;
    return (
      <div className="update-banner__meta">
        <p className="update-banner__version" title={st.error ? `update check failed: ${st.error}` : undefined}>
          {ext ? 'extension' : 'site'} build <code>{CLIENT_VERSION}</code>
          {st.latest
            ? ' · up to date'
            : st.error
              ? ' · update check failed'
              : ' · checking…'}
          {checked ? ` · checked ${checked}` : ''}
        </p>
        <AutoUpdateToggle on={st.autoReload !== false} />
      </div>
    );
  }
  return (
    <div className="update-banner" role="status">
      <span>
        Update available: this {ext ? 'extension' : 'tab'} runs <code>{CLIENT_VERSION}</code>, latest is{' '}
        <code>{st.latest}</code>
        {!ext && st.autoReload === false
          ? ' — auto-update off'
          : !ext && st.reloadBlockedBy
            ? ` — auto-reload waiting (${st.reloadBlockedBy})`
            : ''}
      </span>
      {!ext && <AutoUpdateToggle on={st.autoReload !== false} />}
      {ext ? (
        <a
          className="btn btn--ghost"
          href={EXTENSION_ZIP_URL}
          target="_blank"
          rel="noreferrer"
          title="Unzip over this extension's folder, then press Reload on this same extension in chrome://extensions. Loading it as a second unpacked extension creates a new node id. Reloading this one keeps the id and the shares."
        >
          Update in place
        </a>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={reloadNow}>
          Reload now
        </button>
      )}
    </div>
  );
}
