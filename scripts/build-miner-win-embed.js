#!/usr/bin/env node
// Сборка pool-miner.exe с зашитым хостом пула (host:port).
// QTR_POOL_BUILD_HOST=1.2.3.4:3002 node scripts/build-miner-win-embed.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const host = (process.env.QTR_POOL_BUILD_HOST || '').trim();
if (!host || !/^\S+:\d+$/.test(host)) {
  console.error('Укажи QTR_POOL_BUILD_HOST=IP_или_домен:3002');
  process.exit(1);
}

const srcPath = path.join(root, 'pool', 'miner-client.js');
let src = fs.readFileSync(srcPath, 'utf8');
if (!src.includes('__QTR_POOL_HOST__')) {
  console.error('В pool/miner-client.js нет плейсхолдера __QTR_POOL_HOST__');
  process.exit(1);
}

const outDir = path.join(root, 'dist', 'build');
fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, 'miner-client.embed.js');
src = src.replace(/__QTR_POOL_HOST__/g, host);
fs.writeFileSync(tmp, src);

const outExe = path.join(root, 'dist', 'qtr-pool-miner-public.exe');
const q = p => `"${p.replace(/"/g, '\\"')}"`;
execSync(`npx pkg ${q(tmp)} --targets node18-win-x64 --output ${q(outExe)}`, {
  stdio: 'inherit',
  cwd: root,
  shell: true,
  env: process.env
});

console.log('Готово:', outExe, '| пул:', host);
