#!/usr/bin/env node
/**
 * Lighthouse pack custodian.
 *
 * Two long-lived node keys on a machine that is not the coordinator.
 * Each heartbeat publishes nodePubHex, attests open orbit tickets, and
 * reseals any sealed piece addressed to that key. The process never births
 * a seat, never calls claim_born, and never stores userShareHex.
 *
 * Signer ids must be 16–120 chars and must not contain "vps" or
 * "coordinator" (chooseTargets drops those). Defaults:
 *   lighthouse-1-pack, lighthouse-2-pack
 *
 * Keys are minted on first start under LIGHTHOUSE_KEY_DIR (mode 0600).
 * They stay on this host. Do not copy them onto the coordinator.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { toHex } from '../src/lib/nodeIdentity.js';
import { resealPiece } from '../src/lib/sealedPreshare.js';

const API = process.env.POOL_API_URL || 'https://cartesi-bridge.duckdns.org/api/pool';
const KEY_DIR = process.env.LIGHTHOUSE_KEY_DIR || '/var/lib/lighthouse';
const POLL_MS = Number(process.env.POLL_MS || 5000);
const IDS = (process.env.LIGHTHOUSE_IDS || 'lighthouse-1-pack,lighthouse-2-pack')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function log(...args) {
  console.log('[lighthouse]', new Date().toISOString(), ...args);
}

function loadKey(id) {
  const file = path.join(KEY_DIR, `${id}.json`);
  if (existsSync(file)) {
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    if (!rec?.privHex || !rec?.pubHex) throw new Error(`bad key file ${file}`);
    return rec;
  }
  const priv = secp256k1.utils.randomPrivateKey();
  const rec = {
    v: 1,
    privHex: toHex(priv),
    pubHex: toHex(secp256k1.getPublicKey(priv, true)),
    at: Date.now(),
  };
  writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
  chmodSync(file, 0o600);
  log('minted', id);
  return rec;
}

async function post(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

async function beat(id, key) {
  const hb = await post({
    action: 'pool3p_heartbeat',
    signerId: id,
    network: 'defi',
    client: 'lighthouse',
    clientVersion: 'lighthouse-1',
    nodePubHex: key.pubHex,
  });
  const role = Number(hb.role || 0);
  if (role === 1 || role === 2) {
    log('refusing seat', id, 'd' + role);
    await post({ action: 'pool3p_abandon', signerId: id, role }).catch((e) =>
      log('abandon failed', id, e.message || e),
    );
  }
  const open = Array.isArray(hb.open) ? hb.open : [];
  for (const ticket of open) {
    if (!ticket?.ticketId) continue;
    await post({
      action: 'pool3p_orbit_attest',
      signerId: id,
      ticketId: ticket.ticketId,
    }).catch((e) => log('attest failed', id, ticket.ticketId, e.message || e));
  }
  const requests = Array.isArray(hb.resealRequests) ? hb.resealRequests : [];
  let served = 0;
  for (const req of requests) {
    if (!req?.piece || !req.requesterPub || !req.requesterId) continue;
    try {
      const resealed = await resealPiece({
        piece: req.piece,
        toPubHex: req.requesterPub,
        aad: req.aad || '',
        privHex: key.privHex,
      });
      await post({
        action: 'pool3p_preshare_reseal_put',
        signerId: id,
        role: Number(req.role) || 0,
        requesterId: req.requesterId,
        resealed,
      });
      served += 1;
    } catch (e) {
      log('reseal skip', id, 'role', req.role, e.message || e);
    }
  }
  const listed = (hb.orbit?.live || []).includes(id);
  log(
    'beat',
    id,
    listed ? 'live' : 'not-listed',
    'role',
    role || 0,
    'tickets',
    open.length,
    'resealed',
    served,
  );
}

async function main() {
  if (!IDS.length) throw new Error('LIGHTHOUSE_IDS is empty');
  for (const id of IDS) {
    if (id.length < 16 || id.length > 120) throw new Error(`signer id length ${id}`);
    if (/(^|-)(vps|coordinator)(-|$)/i.test(id)) {
      throw new Error(`${id} is excluded by chooseTargets`);
    }
  }
  mkdirSync(KEY_DIR, { recursive: true });
  chmodSync(KEY_DIR, 0o700);
  const keys = IDS.map((id) => ({ id, key: loadKey(id) }));
  log('up', keys.map((k) => k.id).join(','), API);
  const tick = async () => {
    for (const row of keys) {
      await beat(row.id, row.key).catch((e) => log('err', row.id, e.message || e));
    }
  };
  await tick();
  setInterval(() => {
    tick().catch((e) => log('err', e.message || e));
  }, POLL_MS);
}

main().catch((e) => {
  console.error('[lighthouse]', e);
  process.exit(1);
});
