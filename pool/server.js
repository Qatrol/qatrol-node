// pool/server.js — Qatrol Coin Mining Pool
'use strict';

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// Загрузка .env — иначе пул не видит QTR_POOL_ADDRESS/QTR_POOL_PRIVATE_KEY
// при запуске через `node pool/server.js` (раньше .env читал только miner.js).
(function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (let line of fs.readFileSync(p, 'utf8').split('\n')) {
    line = line.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) process.env[key] = val;
  }
})();

const bc     = require('../blockchain');
const ecdsa  = require('../crypto/ecdsa');

const POOL_PORT    = parseInt(process.env.QTR_POOL_PORT || process.env.POOL_PORT || '3002');
const API_PORT     = parseInt(process.env.QTR_PORT  || '3001');
const POOL_ADDRESS = process.env.QTR_POOL_ADDRESS || '';
const POOL_API_KEY = process.env.QTR_POOL_API_KEY || '';
const POOL_PRIVATE_KEY = process.env.QTR_POOL_PRIVATE_KEY || '';
const POOL_FEE     = 0.02; // 2% пулу
const SHARE_DIFF   = 3;    // сложность шары (легче основной)
const MAX_WORKERS  = 1000; // потолок, чтобы /pool/job не раздувал память
const BIND_HOST    = process.env.QTR_BIND || '127.0.0.1';

// Подключённые воркеры: id -> { address, shares, lastSeen, socket? }
const workers     = new Map();
const shareLog    = []; // последние 1000 шар
let   currentJob  = null;
let   previousJob = null; // предыдущее задание (grace period для шар)
let   jobId       = 0;

// ─── Диагностика ─────────────────────────────────────────────────────────────
const poolStats = {
  blocksFound:       0,
  blocksRejected:    0,
  sharesAccepted:    0,
  sharesBad:         0,
  lastBlockTime:     null,
  lastBlockIndex:    null,
  lastBlockHash:     null,
  lastRejectReason:  null,
  sessionStart:      Date.now(),
  shareTimings:      [], // последние 50 временных меток шар (для расчёта реального HR)
};

function realHashrate() {
  // Считаем реальный хэшрейт пула из временных меток шар
  const now   = Date.now();
  const window = poolStats.shareTimings.filter(t => now - t.ts < 60_000);
  if (window.length < 2) return 0;
  const elapsed = (window[window.length - 1].ts - window[0].ts) / 1000;
  if (elapsed <= 0) return 0;
  const totalHashes = window.reduce((s, t) => s + Math.pow(16, t.diff), 0);
  return Math.round(totalHashes / elapsed);
}

// Периодический статус-лог каждые 60 секунд
setInterval(() => {
  const w = [...workers.values()].filter(x => Date.now() - x.lastSeen < 60_000);
  const totalShares = w.reduce((s, x) => s + x.shares, 0);
  const hr = realHashrate();
  const diff = currentJob?.difficulty || '?';
  const expected = hr > 0 ? Math.round(Math.pow(16, diff) / hr) : '?';
  console.log([
    `\n📊 [СТАТУС] ${new Date().toLocaleTimeString()}`,
    `   Воркеры: ${w.length} | Шары: ${totalShares} | Блоков найдено: ${poolStats.blocksFound}`,
    `   Реальный HR: ${hr >= 1e6 ? (hr/1e6).toFixed(2)+' MH/s' : hr >= 1e3 ? (hr/1e3).toFixed(1)+' kH/s' : hr+' H/s'}`,
    `   Diff: ${diff} | Ожидаемое время блока: ${expected}с`,
    `   Последний блок: ${poolStats.lastBlockTime ? Math.round((Date.now()-poolStats.lastBlockTime)/1000)+'с назад' : 'не найден'}`,
    ``
  ].join('\n'));
}, 60_000);

// ─── Запрос к основной ноде ───────────────────────────────────────────────────
let nodeDown = false;
let _nodeDownLoggedAt = 0;
function markNode(down, reason) {
  if (down !== nodeDown) {
    nodeDown = down;
    if (down) { _nodeDownLoggedAt = Date.now(); console.log(`⚠️  Нода недоступна: ${reason || 'нет ответа'}`); }
    else console.log('✅ Нода снова на связи');
  } else if (down && Date.now() - _nodeDownLoggedAt > 60_000) {
    _nodeDownLoggedAt = Date.now();
    console.log(`⚠️  Нода всё ещё недоступна: ${reason || 'нет ответа'}`);
  }
}

function nodeRequest(path, method = 'GET', body = null) {
  return new Promise(resolve => {
    const opts = {
      hostname: 'localhost', port: API_PORT, path, method,
      headers: { 'Content-Type': 'application/json' }, timeout: 3000
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        markNode(false);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', e => { markNode(true, e.message); resolve(null); });
    req.on('timeout', () => { markNode(true, 'таймаут'); req.destroy(); resolve(null); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Очереди вместо «занято → выбросить» ──────────────────────────────────────
// Раньше найденный блок, попавший в момент отправки другого блока, терялся,
// а воркеру всё равно отвечали «блок найден». Теперь сабмиты идут по очереди.
let _jobLock = false;
let _blockChain = Promise.resolve();
let _payoutChain = Promise.resolve();

function withBlockLock(fn) {
  const run = _blockChain.then(fn, fn);
  _blockChain = run.then(() => {}, () => {});
  return run;
}
function runPayouts(payouts, blockIndex) {
  const run = _payoutChain.then(() => doPayouts(payouts, blockIndex));
  _payoutChain = run.then(() => {}, () => {});
  return run;
}

async function doPayouts(payouts, blockIndex) {
  if (!payouts.length) return;
  if (!POOL_ADDRESS || !POOL_PRIVATE_KEY) {
    console.log(`⚠️  Блок #${blockIndex}: выплаты отключены — не заданы QTR_POOL_ADDRESS/QTR_POOL_PRIVATE_KEY`);
    return;
  }
  let paid = 0, failed = 0;
  const paidAddrs = [];
  for (const p of payouts) {
    const sent = await submitPayoutTx(p.address, p.payout);
    if (sent.success) { paid++; paidAddrs.push(p.address); }
    else if (sent.skipped) console.log(`⚠️  ${p.address.slice(0,16)}… выплата пропущена: ${sent.reason}`);
    else { failed++; console.log(`❌ ${p.address.slice(0,16)}… выплата не прошла: ${sent.reason}`); }
  }
  // Обнуляем шары только у тех, кому реально заплатили: иначе офлайн-воркер
  // теряет заработанное, как только у него на минуту пропал интернет.
  for (const addr of paidAddrs) {
    const w = workers.get(addr);
    if (w) w.shares = 0;
  }
  console.log(`💸 Блок #${blockIndex}: выплачено ${paid}, ошибок ${failed}`);
}

// ─── Очистка старых воркеров (раз в 10 минут) ──────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60_000; // старше 24 часов
  for (const [addr, w] of workers) {
    if (w.lastSeen < cutoff && w.shares === 0) workers.delete(addr);
  }
}, 10 * 60_000);

function txSignature(txs) {
  return (txs || []).map(t => `${t.from}>${t.to}:${t.amount}:${t.fee}`).sort().join('|');
}

// ─── Генерация задания для воркеров ─────────────────────────────────────────
async function generateJob(force = false) {
  if (_jobLock) return currentJob; // уже генерируем — вернём текущее
  _jobLock = true;
  try {
    // Без адреса пула шаблон собирается на адрес ноды: награда не сгорает
    // в кошельке с ключом 'POOL', который никто не может подписать.
    const tplPath = POOL_ADDRESS
      ? `/pool/template?miner=${encodeURIComponent(POOL_ADDRESS)}`
      : '/pool/template';
    const tpl = await nodeRequest(tplPath);
    if (!tpl?.template) return currentJob;

    const t = tpl.template;
    const changed = force
      || !currentJob
      || t.index      !== currentJob.template.index
      || t.prevHash   !== currentJob.template.prevHash
      || t.difficulty !== currentJob.template.difficulty
      // Сравниваем состав транзакций без id и timestamp: id у reward-транзакции
      // случайный в каждом шаблоне, иначе задание менялось на каждом запросе.
      || txSignature(t.transactions) !== txSignature(currentJob.template.transactions);

    if (!changed) return currentJob;

    jobId++;
    previousJob = currentJob;
    currentJob = {
      jobId,
      template: t,
      index: t.index,
      prevHash: t.prevHash,
      difficulty: t.difficulty,
      shareDifficulty: Math.min(SHARE_DIFF, t.difficulty),
      target: '0'.repeat(Math.min(SHARE_DIFF, t.difficulty))
    };
    console.log(`📋 Новое задание #${jobId} — блок #${t.index}, diff ${t.difficulty}`);
    return currentJob;
  } finally {
    _jobLock = false;
  }
}

// ─── Проверка шары ────────────────────────────────────────────────────────────
function checkShare(share) {
  if (share.nonce === undefined || !share.jobId || !share.workerAddress) return { valid: false, reason: 'missing fields' };

  // Принимаем шары как от текущего, так и от предыдущего задания (grace period)
  const job = (share.jobId === currentJob?.jobId) ? currentJob
            : (share.jobId === previousJob?.jobId) ? previousJob
            : null;
  if (!job) return { valid: false, reason: 'stale job' };
  if (!Number.isInteger(job.template?.difficulty) || job.template.difficulty < 1) {
    return { valid: false, reason: 'bad job difficulty' };
  }

  const hashData = {
    index: job.template.index,
    prevHash: job.template.prevHash,
    timestamp: job.template.timestamp,
    transactions: job.template.transactions,
    nonce: share.nonce,
    difficulty: job.template.difficulty
  };
  const hash = bc.sha256(hashData);

  if (!hash.startsWith(job.target)) return { valid: false, reason: 'invalid hash' };

  // Проверяем достигнута ли реальная сложность (только для текущего задания)
  const isBlock = job.jobId === currentJob?.jobId &&
                  hash.startsWith('0'.repeat(job.template.difficulty));
  const block = { ...hashData, miner: job.template.miner, hash };
  return { valid: true, hash, isBlock, block };
}

// ─── Статистика воркеров ──────────────────────────────────────────────────────
function getWorkerStats() {
  const now = Date.now();
  const active = [...workers.values()].filter(w => now - w.lastSeen < 60_000);
  return active.map(w => ({
    address: w.address,
    shares: w.shares,
    lastSeen: w.lastSeen,
    hashrate: w.hashrate || 0
  }));
}

function calcPayouts(totalReward) {
  const now = Date.now();
  const active = [...workers.values()].filter(w => now - w.lastSeen < 300_000 && w.shares > 0);
  const totalShares = active.reduce((s, w) => s + w.shares, 0);
  if (totalShares === 0) return [];

  const poolCut = totalReward * POOL_FEE;
  const minerReward = totalReward - poolCut;

  return active.map(w => ({
    address: w.address,
    shares: w.shares,
    payout: parseFloat((minerReward * (w.shares / totalShares)).toFixed(6)),
    percent: ((w.shares / totalShares) * 100).toFixed(1)
  }));
}

async function submitPayoutTx(to, amount) {
  if (!POOL_PRIVATE_KEY || !POOL_ADDRESS) return { skipped: true, reason: 'pool key/address not configured' };
  if (!to || to === POOL_ADDRESS || amount <= 0) return { skipped: true, reason: 'invalid payout target' };
  const tx = {
    id: 'pool_tx_' + crypto.randomBytes(8).toString('hex'),
    from: POOL_ADDRESS,
    to,
    amount: parseFloat(amount.toFixed(6)),
    fee: parseFloat(bc.calcFee(amount).toFixed(6)),
    timestamp: Date.now(),
    nonce: crypto.randomBytes(4).readUInt32BE(0),
    publicKey: '',
    memo: 'Pool payout'
  };
  const derived = ecdsa.addressFromPrivate(POOL_PRIVATE_KEY);
  if (!derived || derived.address !== POOL_ADDRESS) return { skipped: true, reason: 'pool key mismatch' };
  tx.publicKey = derived.publicKey;
  tx.signature = ecdsa.sign(ecdsa.txSignData(tx), POOL_PRIVATE_KEY);
  if (!tx.signature) return { skipped: true, reason: 'tx sign error' };
  const res = await nodeRequest('/pool/add-tx', 'POST', { tx, apiKey: POOL_API_KEY });
  if (!res?.success) return { skipped: true, reason: res?.error || 'node rejected payout tx' };
  return { success: true, txId: tx.id };
}

// ─── HTTP сервер пула ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const CORS = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (process.env.QTR_CORS_ORIGIN) CORS['Access-Control-Allow-Origin'] = process.env.QTR_CORS_ORIGIN;
  if (req.method === 'OPTIONS') { res.writeHead(200, CORS); res.end(); return; }

  function ok(obj)         { res.writeHead(200, CORS); res.end(JSON.stringify(obj)); }
  function fail(code, msg) { res.writeHead(code, CORS); res.end(JSON.stringify({ error: msg })); }
  function body(cb) {
    const MAX_BODY = 256 * 1024; // задания и шары маленькие, больше не нужно
    let b = '';
    let tooBig = false;
    req.on('data', d => {
      if (tooBig) return;
      b += d;
      if (b.length > MAX_BODY) { tooBig = true; b = ''; fail(413, 'Тело запроса слишком большое'); }
    });
    req.on('end', () => {
      if (tooBig) return;
      let parsed;
      try { parsed = JSON.parse(b || '{}'); }
      catch { return fail(400, 'Invalid JSON'); }
      try {
        const r = cb(parsed);
        if (r && typeof r.catch === 'function') {
          r.catch(e => { console.error('pool handler failed:', e.message); try { fail(500, 'internal error'); } catch {} });
        }
      } catch (e) {
        console.error('pool handler failed:', e.message);
        fail(500, 'internal error');
      }
    });
  }

  const url = req.url.split('?')[0];

  // GET /pool/stats — статистика пула
  if (req.method === 'GET' && url === '/pool/stats') {
    const workerStats = getWorkerStats();
    const totalShares = workerStats.reduce((s, w) => s + w.shares, 0);
    const hr          = realHashrate();
    const diff        = currentJob?.difficulty || 0;
    const expectedSec = hr > 0 && diff > 0 ? Math.round(Math.pow(16, diff) / hr) : null;
    return ok({
      poolFee:          POOL_FEE * 100 + '%',
      shareDifficulty:  currentJob?.shareDifficulty || SHARE_DIFF,
      activeWorkers:    workerStats.length,
      totalWorkers:     workers.size,
      totalShares,
      workers:          workerStats,
      currentJob:       currentJob ? { jobId: currentJob.jobId, index: currentJob.index, difficulty: currentJob.difficulty } : null,
      recentShares:     shareLog.slice(-20),
      // Диагностика
      realHashrate:     hr,
      expectedBlockSec: expectedSec,
      blocksFound:      poolStats.blocksFound,
      blocksRejected:   poolStats.blocksRejected,
      sharesAccepted:   poolStats.sharesAccepted,
      sharesBad:        poolStats.sharesBad,
      lastBlockTime:    poolStats.lastBlockTime,
      lastBlockIndex:   poolStats.lastBlockIndex,
      uptimeSec:        Math.round((Date.now() - poolStats.sessionStart) / 1000),
    });
  }

  // GET /pool/debug — полная диагностика
  if (req.method === 'GET' && url === '/pool/debug') {
    const hr   = realHashrate();
    const diff = currentJob?.difficulty || 0;
    const expectedSec = hr > 0 && diff > 0 ? Math.round(Math.pow(16, diff) / hr) : null;
    const sinceBlock  = poolStats.lastBlockTime ? Math.round((Date.now() - poolStats.lastBlockTime) / 1000) : null;
    return ok({
      '--- ОБЩЕЕ ---':       '',
      uptimeSec:             Math.round((Date.now() - poolStats.sessionStart) / 1000),
      blocksFound:           poolStats.blocksFound,
      blocksRejected:        poolStats.blocksRejected,
      lastRejectReason:      poolStats.lastRejectReason,
      lastBlockIndex:        poolStats.lastBlockIndex,
      lastBlockHash:         poolStats.lastBlockHash,
      secSinceLastBlock:     sinceBlock,
      '--- ХЭШРЕЙТ ---':    '',
      realHashrateHS:        hr,
      realHashrateFormatted: hr >= 1e6 ? (hr/1e6).toFixed(2)+' MH/s' : hr >= 1e3 ? (hr/1e3).toFixed(1)+' kH/s' : hr+' H/s',
      reportedHashrateHS:    [...workers.values()].reduce((s,w) => s + (w.hashrate||0), 0),
      '--- ЗАДАНИЕ ---':     '',
      currentJobId:          currentJob?.jobId,
      currentDifficulty:     diff,
      shareDifficulty:       currentJob?.shareDifficulty || SHARE_DIFF,
      expectedSecPerBlock:   expectedSec,
      '--- ШАРЫ ---':        '',
      sharesAccepted:        poolStats.sharesAccepted,
      sharesBad:             poolStats.sharesBad,
      '--- ВОРКЕРЫ ---':     '',
      workers: [...workers.values()].map(w => ({
        addr:     w.address.slice(0,16)+'...',
        shares:   w.shares,
        reportedHR: w.hashrate,
        online:   Date.now() - w.lastSeen < 60_000,
        lastSeenSec: Math.round((Date.now() - w.lastSeen) / 1000),
      })),
    });
  }

  // POST /pool/job — воркер запрашивает задание
  if (req.method === 'POST' && url === '/pool/job') {
    if (nodeDown) return fail(503, 'Нода недоступна');
    return body(async ({ address }) => {
      if (typeof address !== 'string' || !/^K[0-9A-F]{39,40}$/.test(address)) return fail(400, 'Некорректный адрес');
      if (!workers.has(address)) {
        if (workers.size >= MAX_WORKERS) return fail(429, 'Пул переполнен');
        workers.set(address, { address, shares: 0, lastSeen: Date.now(), hashrate: 0, seen: new Set() });
        console.log(`⛏  Новый воркер: ${address.slice(0, 16)}...`);
      }
      const w = workers.get(address);
      w.lastSeen = Date.now();

      const job = await generateJob(false); // не форсируем — только если изменилось
      if (!job) return fail(503, 'Нода недоступна');
      return ok({ job });
    });
  }

  // POST /pool/submit — воркер отправляет шару
  if (req.method === 'POST' && url === '/pool/submit') {
    if (nodeDown) return fail(503, 'Нода недоступна');
    return body(async ({ address, nonce, jobId: jId, hashrate }) => {
      if (typeof address !== 'string' || !address || nonce === undefined) return fail(400, 'Нужны: address, nonce');
      if (!Number.isInteger(nonce) || nonce < 0) return fail(400, 'nonce должен быть целым числом');

      if (!workers.has(address)) return fail(400, 'Сначала запроси задание /pool/job');
      const w = workers.get(address);
      w.lastSeen = Date.now();
      if (hashrate) w.hashrate = hashrate;

      const shareResult = checkShare({ nonce, jobId: jId, workerAddress: address });

      if (!shareResult.valid) {
        poolStats.sharesBad++;
        console.log(`❌ Плохая шара от ${address.slice(0, 12)}...: ${shareResult.reason} | job=${jId} current=${currentJob?.jobId}`);
        return ok({ accepted: false, reason: shareResult.reason });
      }

      // Одна и та же шара (job+nonce) второй раз не считается: иначе один
      // найденный nonce можно переотправлять бесконечно и выкачать пул.
      const shareKey = `${jId}:${nonce}`;
      if (!w.seen) w.seen = new Set();
      if (w.seen.has(shareKey)) {
        poolStats.sharesBad++;
        return ok({ accepted: false, reason: 'duplicate share' });
      }
      w.seen.add(shareKey);
      if (w.seen.size > 10_000) w.seen.clear();

      // Принимаем шару
      w.shares++;
      poolStats.sharesAccepted++;
      const shareDiff = currentJob?.shareDifficulty || SHARE_DIFF;
      poolStats.shareTimings.push({ ts: Date.now(), diff: shareDiff });
      if (poolStats.shareTimings.length > 50) poolStats.shareTimings.shift();

      shareLog.push({ address, nonce, hash: shareResult.hash, time: Date.now(), isBlock: shareResult.isBlock });
      if (shareLog.length > 1000) shareLog.shift();

      console.log(`✅ Шара #${w.shares} от ${address.slice(0, 12)}... hash=${shareResult.hash.slice(0,14)}... | ${shareResult.isBlock ? '🎯 БЛОК!' : 'share'}`);

      // Если нашли реальный блок — отправляем на ноду (с блокировкой)
      if (shareResult.isBlock) {
        const blk = shareResult.block;
        const result = await withBlockLock(async () => {
          console.log(`\n🎯 БЛОК НАЙДЕН! index=${blk.index} diff=${blk.difficulty} nonce=${blk.nonce}`);
          console.log(`   hash=${blk.hash}`);
          console.log(`   prevHash=${blk.prevHash}`);

          const submit = await nodeRequest('/pool/submit-block', 'POST', { block: blk, apiKey: POOL_API_KEY });
          if (!submit?.success) {
            poolStats.blocksRejected++;
            poolStats.lastRejectReason = submit?.error || 'unknown';
            console.log(`❌ Нода отклонила блок: ${submit?.error || 'unknown error'}`);
            return { ok: false, error: submit?.error || 'block rejected by node' };
          }

          poolStats.blocksFound++;
          poolStats.lastBlockTime  = Date.now();
          poolStats.lastBlockIndex = blk.index;
          poolStats.lastBlockHash  = blk.hash;
          console.log(`🎉 БЛОК #${blk.index} ПРИНЯТ`);

          const payouts = calcPayouts(bc.BLOCK_REWARD);
          console.log(`   Выплаты (${payouts.length} воркеров): ` + payouts.map(p => `${p.address.slice(0,12)}… ${p.payout} QTR`).join(', '));
          runPayouts(payouts, blk.index); // очередь выплат, ответ воркеру не ждём
          return { ok: true };
        });

        if (!result.ok) return ok({ accepted: false, reason: result.error });
      }

      // Новое задание (один вызов)
      const newJob = await generateJob();
      return ok({ accepted: true, isBlock: shareResult.isBlock, newJob, shares: w.shares });
    });
  }

  // GET /pool/worker/:address
  if (req.method === 'GET' && url.startsWith('/pool/worker/')) {
    const address = url.split('/pool/worker/')[1];
    const w = workers.get(address);
    if (!w) return fail(404, 'Воркер не найден');
    const totalShares = [...workers.values()].reduce((s, ww) => s + ww.shares, 0);
    return ok({
      address: w.address,
      shares: w.shares,
      percent: totalShares > 0 ? ((w.shares / totalShares) * 100).toFixed(2) : '0',
      lastSeen: w.lastSeen,
      hashrate: w.hashrate
    });
  }

  // GET /pool/leaderboard — топ майнеров всех времён
  if (req.method === 'GET' && url === '/pool/leaderboard') {
    const all = [...workers.values()].sort((a, b) => b.shares - a.shares);
    const totalShares = all.reduce((s, w) => s + w.shares, 0);
    return ok({
      leaderboard: all.map((w, i) => ({
        rank: i + 1,
        address: w.address,
        shares: w.shares,
        percent: totalShares > 0 ? ((w.shares / totalShares) * 100).toFixed(1) : '0',
        hashrate: w.hashrate || 0,
        active: Date.now() - w.lastSeen < 60_000
      })),
      totalShares,
      totalWorkers: workers.size
    });
  }

  // GET /pool/balance — баланс пула
  if (req.method === 'GET' && url === '/pool/balance') {
    const balRes = await nodeRequest(`/balance/${encodeURIComponent(POOL_ADDRESS || '')}`);
    return ok({ address: POOL_ADDRESS, balance: balRes?.balance ?? 0, available: balRes?.available ?? 0 });
  }

  fail(404, 'Не найдено');
});

// ─── Авто-выплата: каждые 5 минут распределяем накопленный баланс ────────────
async function runAutoPayout() {
  if (!POOL_ADDRESS || !POOL_PRIVATE_KEY) return;
  try {
    const balRes = await nodeRequest(`/balance/${encodeURIComponent(POOL_ADDRESS)}`);
    const available = balRes?.available ?? 0;
    const MIN_PAYOUT_BALANCE = 1.0; // минимум 1 QTR на балансе для выплаты
    if (available < MIN_PAYOUT_BALANCE) return;

    const payouts = calcPayouts(available - 0.05); // 0.05 резерв на TX-комиссии
    if (!payouts.length) return;

    console.log(`\n💸 Авто-выплата: ${available.toFixed(4)} QTR → ${payouts.length} воркер(ов)`);
    let sent = 0;
    for (const p of payouts) {
      if (p.payout < 0.0001) continue;
      const res = await submitPayoutTx(p.address, p.payout);
      if (res.success) {
        console.log(`   ✅ ${p.address.slice(0,16)}... : ${p.payout} QTR (${p.percent}%)`);
        const w = workers.get(p.address);
        if (w) w.shares = 0; // сбрасываем только оплаченным
        sent++;
      } else {
        console.log(`   ${res.skipped ? '⚠️ ' : '❌'} ${p.address.slice(0,16)}...: ${res.reason}`);
      }
    }
    if (sent > 0) console.log(`   Выплачено ${sent} воркер(ам).\n`);
  } catch (e) {
    console.error('Авто-выплата ошибка:', e.message);
  }
}

server.listen(POOL_PORT, BIND_HOST, async () => {
  console.log('\n\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[33m║      ◆  QATROL COIN MINING POOL  ◆               ║\x1b[0m');
  console.log('\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  Пул:   http://${BIND_HOST}:${POOL_PORT}`);
  console.log(`  Нода:  http://localhost:${API_PORT}`);
  console.log(`  Комиссия пула: ${POOL_FEE * 100}%`);
  console.log(`  Сложность шары: ${SHARE_DIFF} (реальная: устанавливается нодой)\n`);
  await generateJob(true); // force=true при старте
  console.log(`  Задание #${jobId} создано\n`);
});

// Проверяем изменения каждые 5 сек, задание меняем только при реальных изменениях
setInterval(() => generateJob(false), 5_000);

// Принудительного обновления каждые 30 секунд больше нет: на сложности 6+
// блок ищется минутами, а смена задания каждые полминуты сбрасывала nonce
// у воркеров, и блок не находился никогда.

// Авто-выплата каждые 5 минут
setInterval(runAutoPayout, 5 * 60 * 1000);
