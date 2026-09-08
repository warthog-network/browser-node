#!/usr/bin/env node
/**
 * Writes public/version.json before `astro build` so the deployed site can
 * answer "what is the latest build?" — tabs poll it and reload when behind.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentity } from './lib/clientVersion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = buildIdentity();
mkdirSync(path.join(root, 'public'), { recursive: true });
writeFileSync(path.join(root, 'public', 'version.json'), JSON.stringify(id, null, 2) + '\n');
console.log(`[version] public/version.json ${id.version} ${id.builtAt}`);
