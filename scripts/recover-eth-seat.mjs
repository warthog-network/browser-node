/**
 * Recover an ETH 3P seat share that was overwritten in extension storage.
 *
 * An ETH seat is born once: the point goes to the coordinator and `needBirth`
 * is false from then on, but the secret lives only in the tab that birthed it.
 * If that tab overwrites its own record with a secret for a dead Q, the seat
 * keeps its lease and keeps heartbeating while being unable to sign, and the
 * ticket parks at `wait_d2` forever.
 *
 * `chrome.storage.local` only exposes *current* values, so the sweep in
 * ethPoolSigner.js cannot see a superseded write. But Chrome's LevelDB log is
 * append-only: until it compacts, the overwritten record is still on disk.
 * This reads that log directly and pulls back the record whose secret actually
 * derives to the live seat point.
 *
 * Usage — from the repo root (needs @noble/curves from node_modules):
 *
 *   node scripts/recover-eth-seat.mjs <leveldb-log> <live-point> <signerId> [role] [out]
 *
 * Example:
 *   node scripts/recover-eth-seat.mjs \
 *     ~/e2-storage-backup/000003.log \
 *     03c3faffbdfbee5b44a321642f2e816a30f6fc858b09b814e2840e0ea7b6dcfd62 \
 *     eth-node-79fcad1f-16c3-4872-87a5-441d85e56ec0 2
 *
 * Point the log at a COPY, not the live profile — Chrome holds a lock and may
 * compact at any time. Output is written 0600 and is live key material: it is a
 * secp256k1 private share for the pool address. Do not paste it anywhere but
 * the node page's own DevTools console, and delete it once the seat signs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { secp256k1 } from '@noble/curves/secp256k1';

const [logPath, livePoint, signerId, roleArg, outArg] = process.argv.slice(2);

if (!logPath || !livePoint || !signerId) {
  console.error('usage: node scripts/recover-eth-seat.mjs <leveldb-log> <live-point> <signerId> [role] [out]');
  process.exit(2);
}

const role = Number(roleArg || 2);
const out = outArg || path.join(os.homedir(), `eth-e${role}-restore.js`);
const want = String(livePoint).toLowerCase();

const buf = fs.readFileSync(logPath).toString('latin1');

const pointOf = (h) =>
  [...secp256k1.ProjectivePoint.BASE.multiply(BigInt('0x' + h)).toRawBytes(true)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * Offset of the `{` that opens the object enclosing `i`.
 *
 * Not lastIndexOf('{', i): the nearest preceding brace is often a *nested* one
 * that has already closed (the tail of `"seal":{…}`), which brace-matches into
 * a valid-but-wrong fragment carrying no userShareHex. Walk back by depth so a
 * closed child is skipped over rather than entered.
 */
function enclosingOpen(i) {
  let depth = 0;
  for (let k = i - 1; k >= 0; k--) {
    const c = buf[k];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

/** Forward brace-match from an opening `{`. */
function objectAt(s) {
  let depth = 0;
  for (let k = s; k < buf.length && k < s + 200000; k++) {
    if (buf[k] === '{') depth++;
    else if (buf[k] === '}') {
      depth--;
      if (!depth) return buf.slice(s, k + 1);
    }
  }
  return null;
}

/**
 * The row holding `hex`. Expands outward a few levels and only accepts an
 * object that actually carries that secret, so a wrong nesting level is
 * rejected instead of silently returning a fragment.
 */
function rowFor(i, hex) {
  let from = i;
  for (let level = 0; level < 8; level++) {
    const s = enclosingOpen(from);
    if (s < 0) return null;
    const raw = objectAt(s);
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (o && o.userShareHex === hex) return o;
      } catch {
        /* torn / partial log write */
      }
    }
    from = s; // step outward past this candidate
  }
  return null;
}

const hits = [];
for (const m of buf.matchAll(/"userShareHex":"([0-9a-fA-F]{64})"/g)) {
  let pt;
  try {
    pt = pointOf(m[1]);
  } catch {
    continue; // not a valid scalar
  }
  if (pt !== want) continue;
  const row = rowFor(m.index, m[1]);
  if (row) hits.push(row);
}

if (!hits.length) {
  console.error(`no record deriving to ${want} found in ${logPath}`);
  console.error('the log may already have compacted — try an older profile backup');
  process.exit(1);
}

// Last matching write wins: it carries the freshest sibling fields (seal, P, …).
const found = hits[hits.length - 1];
const record = { ...found, nextQ: false, role, signerId };

if (pointOf(record.userShareHex) !== want) {
  console.error('refusing to write: recovered secret does not derive to the live point');
  process.exit(1);
}

const key = `eth.poolSigner.born.${signerId}.${role}`;
const snippet =
  `// Recovered ETH seat-${role} share for the live Q. LIVE KEY MATERIAL — do not share.\n` +
  `// Paste into the node page DevTools console, then reload the node page.\n` +
  // Stored as an object, matching what writeBornCache() itself puts here.
  // readBornCache() accepts either shape, but this keeps the record identical
  // to every other one the extension writes.
  `await chrome.storage.local.set({ ${JSON.stringify(key)}: ${JSON.stringify(record, null, 2)} });\n` +
  `console.log('restored:', Object.keys(await chrome.storage.local.get(${JSON.stringify(key)})));\n`;

fs.writeFileSync(out, snippet, { mode: 0o600 });

console.log(`matching records found : ${hits.length}`);
console.log(`record fields          : ${Object.keys(found).join(', ')}`);
console.log(`derives to live point  : yes (${want.slice(0, 16)}…)`);
console.log(`storage key            : ${key}`);
console.log(`written (0600)         : ${out}`);
console.log('');
console.log('Next: open the node page DevTools console and paste the contents of that file.');
console.log('Then reload the node page and watch for the seat to start posting D2.');
