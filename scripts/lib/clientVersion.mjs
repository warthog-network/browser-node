/**
 * One build identity for the site bundle, the extension bundle and
 * public/version.json, so a running tab can tell whether it is current.
 *
 * Netlify exposes the commit as COMMIT_REF; local builds ask git.
 */
import { execSync } from 'node:child_process';

export function resolveClientVersion() {
  const ref = String(process.env.COMMIT_REF || process.env.GIT_SHA || '').trim();
  if (ref) return ref.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export function buildIdentity() {
  return { version: resolveClientVersion(), builtAt: new Date().toISOString() };
}
