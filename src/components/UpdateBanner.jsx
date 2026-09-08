import { useEffect, useState } from 'react';
import {
  CLIENT_VERSION,
  EXTENSION_ZIP_URL,
  getUpdateState,
  isExtensionPage,
  reloadNow,
  startUpdateWatcher,
  subscribeUpdateState,
} from '../lib/clientVersion.js';
import { isSafeToReload } from '../lib/signerSafety.js';

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
  if (!st.outdated) return null;
  const ext = isExtensionPage();
  return (
    <div className="update-banner" role="status">
      <span>
        Update available: this {ext ? 'extension' : 'tab'} runs <code>{CLIENT_VERSION}</code>, latest is{' '}
        <code>{st.latest}</code>
        {!ext && st.reloadBlockedBy ? ` — auto-reload waiting (${st.reloadBlockedBy})` : ''}
      </span>
      {ext ? (
        <a className="btn btn--ghost" href={EXTENSION_ZIP_URL} target="_blank" rel="noreferrer">
          Get latest zip
        </a>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={reloadNow}>
          Reload now
        </button>
      )}
    </div>
  );
}
