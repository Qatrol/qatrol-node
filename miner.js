#!/usr/bin/env node
// miner.js — Qatrol Coin (QTR) Node & Miner
'use strict';

const http      = require('http');
const crypto    = require('crypto');
const readline  = require('readline');
const fs        = require('fs');
const path      = require('path');

// ─── Загрузка .env (как в bot/index.js) ──────────────────────────────────────
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (let line of fs.readFileSync(p, 'utf8').split('\n')) {
    line = line.replace(/\r$/, '');
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) process.env[key] = val; // .env всегда перезаписывает pm2-кэш
  }
})();

const bc        = require('./blockchain');
const auth      = require('./auth');
const ecdsa     = require('./crypto/ecdsa');
const mn        = require('./crypto/mnemonic');
const p2p       = require('./p2p/node');
const { Dashboard } = require('./tui/dashboard');
const { createLogger } = require('./logger');

const log = createLogger('miner', { printToConsole: false }); // файл-only, TUI занимает stdout

const API_PORT     = parseInt(process.env.QTR_PORT      || '3001');
const POOL_PORT    = parseInt(process.env.QTR_POOL_PORT || '3002');
const MINE_CHUNK   = 3_000;
const POOL_API_KEY = process.env.QTR_POOL_API_KEY || '';
const NO_MINE      = process.env.QTR_NO_MINE === 'true'; // чистая нода без майнинга

// Rate limiting: IP → { count, resetAt }
const _rateLimits = new Map();
function rateLimit(ip, max = 10, windowMs = 60_000) {
  const now = Date.now();
  let r = _rateLimits.get(ip);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + windowMs }; _rateLimits.set(ip, r); }
  r.count++;
  return r.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateLimits) if (now > v.resetAt) _rateLimits.delete(k);
}, 120_000);

// ─── Умное снижение нагрузки ──────────────────────────────────────────────────
// Когда пул активен — нода делает паузы между чанками хэширования.
// Когда майнеры ушли — нода разгоняется до 100%.
let nodeMinePause = 0; // ms между чанками (0 = полная скорость)

function checkPoolWorkers() {
  const req = http.request({
    hostname: 'localhost', port: POOL_PORT,
    path: '/pool/stats', method: 'GET', timeout: 2000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const stats = JSON.parse(d);
        const w = stats.activeWorkers || 0;
        if      (w >= 4) nodeMinePause = 200; // 4+ майнера  → нода почти в фоне
        else if (w >= 2) nodeMinePause = 100; // 2-3 майнера → нода вполсилы
        else if (w >= 1) nodeMinePause =  30; // 1 майнер    → нода чуть притормаживает
        else             nodeMinePause =   0; // нет майнеров → нода на полную
      } catch { nodeMinePause = 0; }
    });
  });
  req.on('error', () => { nodeMinePause = 0; });
  req.on('timeout', () => { req.destroy(); nodeMinePause = 0; });
  req.end();
}
// Проверяем каждые 30 секунд
setInterval(checkPoolWorkers, 30_000);
checkPoolWorkers(); // сразу при старте

let minerAddress        = null;
let minerPrivKey        = null;
let lastCreatedMnemonic = null;   // сохраняется при интерактивном создании
let mining              = true;
let currentDiff         = bc.FIXED_DIFFICULTY || bc.BASE_DIFFICULTY;

const ui    = new Dashboard();
const stats = { hashrate: 0, blocksFound: 0, startTime: Date.now(), lastBlock: null, nonce: 0 };

// ─── Prompt ───────────────────────────────────────────────────────────────────
function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

// ─── Setup ────────────────────────────────────────────────────────────────────
async function setup() {
  const envAddress  = process.env.QTR_MINER_ADDRESS;
  const envPriv     = process.env.QTR_MINER_PRIVATE_KEY;
  const envMnemonic = process.env.QTR_MINER_MNEMONIC;

  // QTR_MINER_ADDRESS имеет наивысший приоритет —
  // позволяет переопределить приватный ключ в pm2-кэше через .env
  if (envAddress) {
    minerAddress = envAddress;
    minerPrivKey = null;
    return;
  }
  if (envPriv) {
    const derived = ecdsa.addressFromPrivate(envPriv);
    if (!derived) throw new Error('QTR_MINER_PRIVATE_KEY is invalid');
    minerAddress = derived.address;
    minerPrivKey = envPriv;
    return;
  }
  if (envMnemonic) {
    if (!mn.validateMnemonic(envMnemonic)) throw new Error('QTR_MINER_MNEMONIC must contain 12 valid words');
    const seed = mn.mnemonicToSeed(envMnemonic.trim().toLowerCase().split(/\s+/).join(' '));
    const kp = ecdsa.deriveKeyPairFromSeed(seed);
    if (!kp) throw new Error('Cannot derive key from QTR_MINER_MNEMONIC');
    minerAddress = kp.address;
    minerPrivKey = kp.privateKey;
    return;
  }
  const firstRun = !fs.existsSync('blockchain.json');

  console.log('\n\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[33m║                                                  ║\x1b[0m');
  console.log('\x1b[33m║      ◆  QATROL COIN (QTR)  ◆  NODE v1.0         ║\x1b[0m');
  console.log('\x1b[33m║                                                  ║\x1b[0m');
  console.log('\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m\n');

  if (firstRun) {
    console.log('\x1b[93m  ◈ Первый запуск — инициализация Genesis блока\x1b[0m');
    console.log('\x1b[2m  Первый кошелёк получит все 1,000,000,000 QTR\x1b[0m\n');
  }

  console.log('  Выберите действие:\n');
  console.log('  \x1b[33m1)\x1b[0m Создать новый кошелёк');
  console.log('  \x1b[33m2)\x1b[0m Ввести адрес (только майнинг)');
  console.log('  \x1b[33m3)\x1b[0m Ввести приватный ключ');
  console.log('  \x1b[33m4)\x1b[0m Восстановить из мнемоника\n');

  const choice = await prompt('  Ваш выбор (1-4): ');

  if (choice === '1') {
    const kp     = ecdsa.generateKeyPair();
    const phrase = mn.generateMnemonic();
    minerAddress        = kp.address;
    minerPrivKey        = kp.privateKey;
    lastCreatedMnemonic = phrase;

    console.log('\n\x1b[33m  ╔══════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[33m  ║  ◆ НОВЫЙ КОШЕЛЁК QATROL СОЗДАН                  ║\x1b[0m');
    console.log('\x1b[33m  ╠══════════════════════════════════════════════════╣\x1b[0m');
    console.log('\x1b[97m  ║  Адрес:\x1b[0m');
    console.log(`  \x1b[97m  ${kp.address}\x1b[0m`);
    console.log('\x1b[33m  ╠══════════════════════════════════════════════════╣\x1b[0m');
    console.log('\x1b[97m  ║  Мнемоник (12 слов):\x1b[0m');
    const words = phrase.split(' ');
    for (let i = 0; i < 12; i += 3) {
      const row = words.slice(i, i + 3).map((w, j) => `  ${i+j+1}. ${w.padEnd(12)}`).join('');
      console.log('\x1b[95m  ' + row + '\x1b[0m');
    }
    console.log('\x1b[33m  ╠══════════════════════════════════════════════════╣\x1b[0m');
    console.log('\x1b[97m  ║  Приватный ключ:\x1b[0m');
    console.log(`  \x1b[93m  ${kp.privateKey}\x1b[0m`);
    console.log('\x1b[91m  ╠══════════════════════════════════════════════════╣\x1b[0m');
    console.log('\x1b[91m  ║  ⚠  СОХРАНИ — БЕЗ КЛЮЧА ДОСТУП ПОТЕРЯН НАВСЕГДА ║\x1b[0m');
    console.log('\x1b[91m  ╚══════════════════════════════════════════════════╝\x1b[0m\n');

    const fname = `qatrol_wallet_${Date.now()}.txt`;
    fs.writeFileSync(fname, [
      'QATROL COIN (QTR) WALLET',
      '========================',
      `Address:    ${kp.address}`,
      `PrivateKey: ${kp.privateKey}`,
      `Mnemonic:   ${phrase}`,
      '',
      'KEEP THIS FILE SAFE — NEVER SHARE YOUR PRIVATE KEY'
    ].join('\n'));
    console.log(`\x1b[2m  Сохранено в: ${fname}\x1b[0m\n`);
    await prompt('  Нажми Enter когда сохранил...');

  } else if (choice === '2') {
    const addr = await prompt('  Адрес кошелька (начинается с K): ');
    if (!addr.startsWith('K') || addr.length < 10) { console.log('\x1b[91m  ❌ Неверный адрес\x1b[0m'); process.exit(1); }
    minerAddress = addr;
    minerPrivKey = null;
    console.log(`\n\x1b[92m  ✓ Адрес установлен: ${addr}\x1b[0m\n`);

  } else if (choice === '3') {
    const pk = await prompt('  Приватный ключ: ');
    const derived = ecdsa.addressFromPrivate(pk);
    if (!derived) { console.log('\x1b[91m  ❌ Неверный ключ\x1b[0m'); process.exit(1); }
    minerAddress = derived.address;
    minerPrivKey = pk;
    console.log(`\n\x1b[92m  ✓ Кошелёк: ${derived.address}\x1b[0m\n`);

  } else if (choice === '4') {
    const phrase = await prompt('  12 слов через пробел:\n  > ');
    if (!mn.validateMnemonic(phrase)) { console.log('\x1b[91m  ❌ Неверный мнемоник\x1b[0m'); process.exit(1); }
    const seed = mn.mnemonicToSeed(phrase.trim().toLowerCase().split(/\s+/).join(' '));
    const kp = ecdsa.deriveKeyPairFromSeed(seed);
    if (!kp) { console.log('\x1b[91m  ❌ Не удалось восстановить ключ\x1b[0m'); process.exit(1); }
    minerAddress        = kp.address;
    minerPrivKey        = kp.privateKey;
    lastCreatedMnemonic = phrase.trim().toLowerCase().split(/\s+/).join(' ');
    console.log(`\n\x1b[92m  ✓ Кошелёк: ${minerAddress}\x1b[0m\n`);
  } else {
    console.log('\x1b[91m  ❌ Неверный выбор\x1b[0m'); process.exit(1);
  }
}

// ─── Async PoW ────────────────────────────────────────────────────────────────
function mineAsync(template, difficulty) {
  return new Promise(resolve => {
    let nonce    = 0;
    const prefix = '0'.repeat(difficulty);
    const start  = Date.now();

    function tick() {
      if (!mining) { resolve(null); return; }
      const end = nonce + MINE_CHUNK;
      while (nonce < end) {
        template.nonce = nonce;
        template.hash  = bc.hashBlock(template);
        if (template.hash.startsWith(prefix)) {
          stats.hashrate = Math.round(nonce / ((Date.now() - start) / 1000));
          resolve({ ...template });
          return;
        }
        nonce++;
      }
      stats.nonce = nonce;
      ui.update({ hashrate: stats.hashrate, nonce, mining: true, block: template.index });
      // Если пул активен — делаем паузу, отдавая CPU майнерам
      if (nodeMinePause > 0) {
        setTimeout(tick, nodeMinePause);
      } else {
        setImmediate(tick);
      }
    }
    setImmediate(tick);
  });
}

// ─── Mining loop ──────────────────────────────────────────────────────────────
async function runMiner() {
  ui.start();
  ui.update({ address: minerAddress, mining: false, coin: 'QTR' });
  ui.log(`\x1b[33m◆ Qatrol Coin майнер запущен\x1b[0m`);
  ui.log(`\x1b[2mАдрес: ${minerAddress.slice(0, 20)}...\x1b[0m`);

  while (true) {
    const data = loadData();
    if (!data) { await sleep(1000); continue; }

    currentDiff = bc.calcDifficulty(data.chain);
    const chain     = data.chain;
    const prevBlock = chain[chain.length - 1];
    const mempool   = data.mempool || [];

    // Валидные транзакции из mempool
    const pending = [...mempool]
      .filter(tx => !bc.validateTx(tx, data.wallets, []))
      .sort((a, b) => b.fee - a.fee)
      .slice(0, 50);

    const totalFees = parseFloat(pending.reduce((s, t) => s + (t.fee || 0), 0).toFixed(6));

    const transactions = [...pending];

    // Комиссии → майнеру
    if (totalFees > 0) {
      transactions.unshift({
        id: 'fee_' + crypto.randomBytes(6).toString('hex'),
        from: 'SYSTEM_FEE', to: minerAddress,
        amount: totalFees, fee: 0,
        timestamp: Date.now(), nonce: 0,
        signature: 'SYSTEM_FEE',
        memo: `Fees block #${chain.length}`
      });
    }

    // Награда 0.1 QTR из genesis-кошелька
    const gen = bc.loadGenesis();
    if (gen && gen.address) {
      const genesisBalance = bc.getBalance(data, gen.address);
      if (genesisBalance >= bc.BLOCK_REWARD) {
        const rewardTx = {
          id: 'reward_' + chain.length + '_' + crypto.randomBytes(4).toString('hex'),
          from: 'REWARD',
          to: minerAddress,
          amount: bc.BLOCK_REWARD,
          fee: 0,
          timestamp: Date.now(),
          nonce: 0,
          signature: 'BLOCK_REWARD',
          memo: `Block #${chain.length} reward`
        };
        transactions.unshift(rewardTx);
        // Спишем с genesis при применении блока
      }
    }

    const template = {
      index: chain.length,
      prevHash: prevBlock.hash,
      timestamp: Date.now(),
      transactions,
      nonce: 0,
      difficulty: currentDiff,
      miner: minerAddress,
      hash: ''
    };

    ui.update({ block: template.index, difficulty: currentDiff, pending: mempool.length, valid: true });

    const t0    = Date.now();
    const mined = await mineAsync(template, currentDiff);
    if (!mined) { await sleep(500); continue; }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    const fresh = loadData();
    if (!fresh || fresh.chain.length !== chain.length || fresh.chain[chain.length - 1]?.hash !== prevBlock.hash) {
      ui.log('\x1b[93m⚡ Orphan, повтор...\x1b[0m');
      continue;
    }

    fresh.chain.push(mined);
    const pids = new Set(pending.map(t => t.id));
    fresh.mempool = fresh.mempool.filter(t => !pids.has(t.id));

    // applyBlock сам обрабатывает REWARD — списывает с genesis и зачисляет майнеру
    bc.applyBlock(fresh, mined);

    debouncedSave(fresh);

    stats.blocksFound++;
    stats.lastBlock = Date.now();
    const balance = bc.getBalance(fresh, minerAddress);

    ui.update({ blocksFound: stats.blocksFound, balance, hashrate: stats.hashrate, mining: false });
    ui.log(`\x1b[92m✅ Блок #${mined.index} | ${elapsed}s | ${(stats.hashrate/1000).toFixed(1)}kH/s | +${bc.BLOCK_REWARD} QTR\x1b[0m`);
    if (totalFees > 0) ui.log(`\x1b[33m◆ Комиссии: +${totalFees} QTR\x1b[0m`);
    log.info(`Block #${mined.index} mined | hash=${mined.hash.slice(0,16)}… | ${elapsed}s | hashrate=${stats.hashrate} H/s | reward=${bc.BLOCK_REWARD} QTR | fees=${totalFees} QTR | balance=${balance}`);

    // Анонсируем новый блок всем пирам немедленно
    p2p.announceBlock(mined).catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Кэш загрузки блокчейна ───────────────────────────────────────────────────
// loadData() читает диск только при первом запуске.
// setDataCache(data) обновляет кэш из памяти — без чтения диска.
// debouncedSave(data) пишет на диск не чаще раза в 500мс —
//   при быстрой P2P-синхронизации блоков это снижает нагрузку в 10-20 раз.
let _dataCache    = null;
let _pendingSave  = null;
let _saveTimer    = null;

function loadData() {
  if (_dataCache) return _dataCache;
  _dataCache = bc.load();
  return _dataCache;
}

function setDataCache(data) { _dataCache = data; }

// Вызывается вместо bc.save() — дебаунс 500мс
function debouncedSave(data) {
  setDataCache(data);       // кэш обновляется мгновенно
  _pendingSave = data;      // запоминаем последнюю версию
  if (_saveTimer) return;   // уже запланировано
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (_pendingSave) { bc.save(_pendingSave); _pendingSave = null; }
  }, 500);
}

// Немедленное сохранение (для критичных случаев — транзакции, регистрация)
function immediateSave(data) {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; _pendingSave = null; }
  setDataCache(data);
  bc.save(data);
}

// ─── Кэш валидации цепи (инкрементальный — только новые блоки) ───────────────
// Полная валидация O(n) запускается только при старте или если цепь сломана.
// Каждый новый блок проверяется за O(1), event loop не блокируется.
let _validCache = { ok: true, blocks: 0, validatedUpTo: 0 };

function getCachedValidity(chain) {
  if (_validCache.blocks === chain.length) return _validCache;
  if (!_validCache.ok) {
    // Цепь была сломана — полная перепроверка
    const r = bc.validateChain(chain);
    _validCache = { ok: r.ok, blocks: chain.length, validatedUpTo: chain.length };
    return _validCache;
  }
  // Инкрементально: проверяем только блоки после последней проверки
  const from = Math.max(1, _validCache.validatedUpTo);
  for (let i = from; i < chain.length; i++) {
    const b = chain[i], prev = chain[i - 1];
    if (b.index !== prev.index + 1 || b.prevHash !== prev.hash ||
        bc.hashBlock(b) !== b.hash || b.timestamp < prev.timestamp) {
      _validCache = { ok: false, blocks: chain.length, validatedUpTo: i };
      return _validCache;
    }
    const diff = b.difficulty || bc.BASE_DIFFICULTY;
    if (!b.hash.startsWith('0'.repeat(diff))) {
      _validCache = { ok: false, blocks: chain.length, validatedUpTo: i };
      return _validCache;
    }
  }
  _validCache = { ok: true, blocks: chain.length, validatedUpTo: chain.length };
  return _validCache;
}

// ─── Оценка сетевого хэшрейта из последних блоков ────────────────────────────
function estimateNetworkHashrate(chain, n = 12) {
  if (!chain || chain.length < 2) return 0;
  const recent = chain.slice(-Math.min(n, chain.length));
  const elapsed = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000;
  if (elapsed <= 0) return 0;
  const avgBlockTime = elapsed / (recent.length - 1);
  const lastDiff = recent[recent.length - 1].difficulty || 1;
  return Math.round(Math.pow(16, lastDiff) / avgBlockTime);
}

// ─── API ──────────────────────────────────────────────────────────────────────
function startAPI() {
  const srv = http.createServer((req, res) => {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Session-Token',
      'Content-Type': 'application/json'
    };
    if (req.method === 'OPTIONS') { res.writeHead(200, CORS); res.end(); return; }

    function ok(obj)         { res.writeHead(200, CORS); res.end(JSON.stringify(obj)); }
    function fail(code, msg) { res.writeHead(code, CORS); res.end(JSON.stringify({ error: msg })); }
    function body(cb) {
      // Ограничение размера: без него один POST с гигабайтом JSON съедал всю память ноды.
      const MAX_BODY = 1024 * 1024;
      let b = '';
      let tooBig = false;
      req.on('data', d => {
        if (tooBig) return;
        b += d;
        if (b.length > MAX_BODY) { tooBig = true; b = ''; fail(413, 'Тело запроса больше 1 МБ'); }
      });
      req.on('end', () => {
        if (tooBig) return;
        try { cb(JSON.parse(b || '{}')); } catch { fail(400, 'Invalid JSON'); }
      });
    }

    const data   = loadData();
    const url    = req.url.split('?')[0];
    const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
    const sess   = auth.getSessionFromReq(req);

    // Блокчейн ещё не инициализирован (нода стартует)
    if (!data && url !== '/stats') return fail(503, 'Блокчейн загружается, повтори через секунду');
    if (!data) return ok({ coin: bc.COIN_NAME, ticker: bc.COIN_TICKER, blocks: 0, difficulty: bc.BASE_DIFFICULTY, pendingTx: 0, valid: false, totalSupply: bc.TOTAL_SUPPLY, blockReward: bc.BLOCK_REWARD, hashrate: 0, blocksFound: 0, uptime: Math.floor((Date.now() - stats.startTime) / 1000), minerAddress, loading: true });

    // ── Public ────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/stats') {
      const valid = getCachedValidity(data.chain);
      const gen   = bc.loadGenesis();
      const genesisBalance = gen ? bc.getBalance(data, gen.address) : 0;
      return ok({
        coin: bc.COIN_NAME, ticker: bc.COIN_TICKER,
        blocks: data.chain.length,
        difficulty: currentDiff,
        pendingTx: data.mempool.length,
        pendingFees: data.mempool.reduce((s, t) => s + (t.fee || 0), 0).toFixed(6),
        valid: valid.ok,
        totalSupply: bc.TOTAL_SUPPLY,
        blockReward: bc.BLOCK_REWARD,
        circulatingSupply: Object.values(data.wallets || {}).filter(v => v > 0).reduce((a, b) => a + b, 0).toFixed(2),
        genesisBalance: genesisBalance.toFixed(2),
        hashrate: estimateNetworkHashrate(data.chain),
        blocksFound: stats.blocksFound,
        uptime: Math.floor((Date.now() - stats.startTime) / 1000),
        lastBlockTime: stats.lastBlock,
        genesisAddress: gen?.address || null,
        feePercent: bc.FEE_PERCENT * 100,
        peers: p2p.loadPeers().length,
        mining: !NO_MINE
        // minerAddress не возвращаем в публичном API
      });
    }

    // ── P2P: принять блок от другой ноды ─────────────────────────────────────
    if (req.method === 'POST' && url === '/block/push') {
      return body(({ block }) => {
        if (!block || typeof block !== 'object') return fail(400, 'bad block');
        const fresh = loadData();
        if (!fresh || !fresh.chain || fresh.chain.length === 0) return fail(503, 'not ready');
        const prev = fresh.chain[fresh.chain.length - 1];
        if (!prev) return fail(503, 'not ready');
        // Быстрая проверка: блок должен продолжать нашу цепь
        if (block.index !== prev.index + 1) return ok({ accepted: false, reason: 'not next block' });
        if (block.prevHash !== prev.hash)    return ok({ accepted: false, reason: 'bad prevHash' });
        const err = bc.validateBlock(block, prev);
        if (err) return ok({ accepted: false, reason: err });
        // Проверяем что хэш корректен
        if (bc.hashBlock(block) !== block.hash) return ok({ accepted: false, reason: 'bad hash' });

        fresh.chain.push(block);
        // Убираем из mempool включённые транзакции
        const inBlock = new Set(block.transactions.map(t => t.id));
        fresh.mempool = fresh.mempool.filter(t => !inBlock.has(t.id));
        bc.applyBlock(fresh, block);
        debouncedSave(fresh);
        console.log(`📦 P2P: принят блок #${block.index} от пира`);
        return ok({ accepted: true });
      });
    }

    // P2P sync endpoint — возвращает цепь в правильном порядке (от генезиса), без лимита
    if (req.method === 'GET' && url === '/chain/p2p') {
      return ok({ chain: data.chain, total: data.chain.length });
    }

    if (req.method === 'GET' && url === '/chain') {
      const limit  = Math.min(parseInt(params.get('limit') || 20), 200);
      const offset = parseInt(params.get('offset') || 0);
      const chain  = [...data.chain].reverse();
      return ok({ chain: chain.slice(offset, offset + limit), total: data.chain.length, limit, offset });
    }

    if (req.method === 'GET' && url === '/chartdata') {
      return ok({ data: bc.getChartData(data.chain, 120) });
    }

    if (req.method === 'GET' && url === '/richlist') {
      const limit = Math.min(parseInt(params.get('limit') || '50'), 100);
      const wallets = data.wallets || {};
      const total = Object.values(wallets).filter(v => v > 0).reduce((a, b) => a + b, 0);
      const list = Object.entries(wallets)
        .filter(([, bal]) => bal > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, limit)
        .map(([address, balance], i) => ({
          rank: i + 1,
          address,
          balance: parseFloat(balance.toFixed(6)),
          percent: total > 0 ? parseFloat((balance / total * 100).toFixed(2)) : 0
        }));
      return ok({ list, total: parseFloat(total.toFixed(2)), count: Object.keys(wallets).length });
    }

    if (req.method === 'GET' && url.startsWith('/block/')) {
      const q = url.split('/block/')[1];
      let block = data.chain.find(b => b.hash === q);
      if (!block && /^\d+$/.test(q)) block = data.chain[parseInt(q)];
      if (!block) return fail(404, 'Блок не найден');
      return ok({ block, confirmations: data.chain.length - block.index });
    }

    if (req.method === 'GET' && url.startsWith('/tx/')) {
      const id = url.split('/tx/')[1];
      for (const b of [...data.chain].reverse()) {
        const tx = b.transactions.find(t => t.id === id);
        if (tx) return ok({ tx, block: b.index, blockHash: b.hash, confirmations: data.chain.length - b.index, confirmed: true });
      }
      const p = data.mempool.find(t => t.id === id);
      if (p) return ok({ tx: p, confirmed: false, confirmations: 0 });
      return fail(404, 'Не найдено');
    }

    if (req.method === 'GET' && url.startsWith('/balance/')) {
      const address    = url.split('/balance/')[1];
      const balance    = bc.getBalance(data, address);
      const pendingOut = bc.getPendingOut(data.mempool, address);
      return ok({ address, balance, pendingOut: parseFloat(pendingOut.toFixed(6)), available: parseFloat((balance - pendingOut).toFixed(6)) });
    }

    if (req.method === 'GET' && url.startsWith('/history/')) {
      const address = url.split('/history/')[1];
      const limit   = parseInt(params.get('limit') || 50);
      const history = bc.getHistory(data.chain, address, limit);
      const pending = data.mempool.filter(t => t.from === address || t.to === address).map(t => ({ ...t, confirmed: false, confirmations: 0 }));
      return ok({ history: [...pending, ...history], address });
    }

    if (req.method === 'GET' && url === '/mempool') {
      return ok({ mempool: data.mempool, count: data.mempool.length, totalFees: data.mempool.reduce((s, t) => s + (t.fee || 0), 0) });
    }

    if (req.method === 'GET' && url.startsWith('/search/')) {
      const q = decodeURIComponent(url.split('/search/')[1]);
      const block = data.chain.find(b => b.hash === q || String(b.index) === q);
      if (block) return ok({ type: 'block', data: block });
      for (const b of data.chain) {
        const tx = b.transactions.find(t => t.id === q);
        if (tx) return ok({ type: 'tx', data: tx, block: b.index, blockHash: b.hash });
      }
      const ptx = data.mempool.find(t => t.id === q);
      if (ptx) return ok({ type: 'tx', data: ptx, confirmed: false });
      if (data.wallets[q] !== undefined) return ok({ type: 'address', data: { address: q, balance: bc.getBalance(data, q) } });
      return fail(404, 'Не найдено');
    }

    if (req.method === 'GET' && url === '/peers') { return ok({ peers: p2p.loadPeers() }); }
    if (req.method === 'POST' && url === '/peers/add') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!rateLimit(ip, 5, 60_000)) return fail(429, 'Too many requests');
      return body(({ url: u }) => {
        if (!u) return fail(400, 'url required');
        if (!p2p.isValidPeerUrl(u)) return fail(400, 'invalid url');
        const added = p2p.addPeer(u);
        return ok({ peers: p2p.loadPeers(), added });
      });
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/auth/register') {
      return body(({ password, label }) => {
        const r = auth.register(password, label);
        if (r.error) return fail(400, r.error);
        if (!data.wallets[r.address]) { data.wallets[r.address] = 0; immediateSave(data); }
        return ok(r);
      });
    }

    if (req.method === 'POST' && url === '/auth/import') {
      return body(({ privateKey: pk, password, label }) => {
        const r = auth.importWallet(pk, password, label);
        if (r.error) return fail(400, r.error);
        if (!data.wallets[r.address]) { data.wallets[r.address] = 0; immediateSave(data); }
        return ok(r);
      });
    }

    if (req.method === 'POST' && url === '/auth/restore') {
      return body(({ phrase, password, label }) => {
        const r = auth.restoreFromMnemonic(phrase, password, label);
        if (r.error) return fail(400, r.error);
        return ok(r);
      });
    }

    if (req.method === 'POST' && url === '/auth/import-mnemonic') {
      return body(({ mnemonic, password, label }) => {
        const r = auth.restoreFromMnemonic(mnemonic, password, label);
        if (r.error) return fail(400, r.error);
        return ok(r);
      });
    }

    if (req.method === 'GET' && url === '/pool/template') {
      const poolMiner = params.get('miner') || minerAddress;
      const chain = data.chain;
      const prevBlock = chain[chain.length - 1];
      const mempool = data.mempool || [];
      const pending = [...mempool]
        .filter(tx => !bc.validateTx(tx, data.wallets, []))
        .sort((a, b) => b.fee - a.fee)
        .slice(0, 50);
      const totalFees = parseFloat(pending.reduce((s, t) => s + (t.fee || 0), 0).toFixed(6));
      const txs = [...pending];
      if (totalFees > 0) {
        txs.unshift({
          id: 'fee_' + crypto.randomBytes(6).toString('hex'),
          from: 'SYSTEM_FEE', to: poolMiner,
          amount: totalFees, fee: 0, timestamp: Date.now(), nonce: 0, signature: 'SYSTEM_FEE',
          memo: `Fees block #${chain.length}`
        });
      }
      const gen = bc.loadGenesis();
      if (gen && gen.address && bc.getBalance(data, gen.address) >= bc.BLOCK_REWARD) {
        txs.unshift({
          id: 'reward_' + chain.length + '_' + crypto.randomBytes(4).toString('hex'),
          from: 'REWARD', to: poolMiner,
          amount: bc.BLOCK_REWARD, fee: 0, timestamp: Date.now(), nonce: 0, signature: 'BLOCK_REWARD',
          memo: `Block #${chain.length} reward`
        });
      }
      const template = {
        index: chain.length,
        prevHash: prevBlock.hash,
        timestamp: Date.now(),
        transactions: txs,
        difficulty: bc.calcDifficulty(chain),
        miner: poolMiner
      };
      return ok({ template });
    }

    if (req.method === 'POST' && url === '/pool/submit-block') {
      return body(({ block, apiKey }) => {
        if (POOL_API_KEY && apiKey !== POOL_API_KEY) return fail(403, 'Invalid pool api key');
        if (!block || typeof block !== 'object') return fail(400, 'Нужен объект block');
        const fresh = loadData();
        if (!fresh || !fresh.chain) return fail(503, 'not ready');
        const prev = fresh.chain[fresh.chain.length - 1];
        const candidate = {
          index: block.index,
          prevHash: block.prevHash,
          timestamp: block.timestamp,
          transactions: block.transactions || [],
          nonce: block.nonce,
          difficulty: block.difficulty,
          miner: block.miner,
          hash: block.hash || ''
        };
        if (!candidate.hash) candidate.hash = bc.hashBlock(candidate);
        const err = bc.validateBlock(candidate, prev);
        if (err) return fail(400, `bad block: ${err}`);
        fresh.chain.push(candidate);
        const ids = new Set(candidate.transactions.map(t => t.id));
        fresh.mempool = fresh.mempool.filter(t => !ids.has(t.id));
        bc.applyBlock(fresh, candidate);
        debouncedSave(fresh);
        stats.blocksFound++;
        stats.lastBlock = Date.now();
        ui.log(`\x1b[92m✅ Блок #${candidate.index} принят от пула\x1b[0m`);
        log.info(`Pool block #${candidate.index} accepted | hash=${candidate.hash.slice(0,16)}… | miner=${candidate.miner}`);
        return ok({ success: true, block: candidate });
      });
    }

    if (req.method === 'POST' && url === '/pool/add-tx') {
      return body(({ tx, apiKey }) => {
        if (POOL_API_KEY && apiKey !== POOL_API_KEY) return fail(403, 'Invalid pool api key');
        if (!tx || typeof tx !== 'object') return fail(400, 'Нужен объект tx');
        const err = bc.validateTx(tx, data.wallets, data.mempool);
        if (err) return fail(400, `invalid tx: ${err}`);
        if (data.mempool.some(t => t.id === tx.id)) return fail(400, 'duplicate tx');
        data.mempool.push(tx);
        immediateSave(data);
        return ok({ success: true, txId: tx.id });
      });
    }

    if (req.method === 'POST' && url === '/auth/login') {
      return body(({ address, password }) => {
        if (!address || !password) return fail(400, 'Нужны address и password');
        const r = auth.login(address, password);
        if (r.error) return fail(401, r.error);
        return ok(r);
      });
    }

    if (req.method === 'POST' && url === '/auth/logout') {
      if (sess.token) auth.deleteSession(sess.token);
      return ok({ success: true });
    }

    if (req.method === 'GET' && url === '/auth/me') {
      if (!sess.address) return fail(401, 'Не авторизован');
      return ok({ ...auth.getWalletInfo(sess.address), address: sess.address });
    }

    if (req.method === 'POST' && url === '/auth/mnemonic') {
      if (!sess.address) return fail(401, 'Требуется авторизация');
      return body(({ password }) => {
        const phrase = auth.getMnemonic(sess.address, password);
        if (!phrase) return fail(400, 'Неверный пароль или нет мнемоника');
        return ok({ mnemonic: phrase });
      });
    }

    // ── Protected ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/send') {
      if (!sess.address) return fail(401, 'Требуется авторизация');
      return body(({ to, amount, memo, password }) => {
        const from = sess.address;
        if (!to || !amount) return fail(400, 'Нужны: to, amount');
        // Адрес: K и 39 hex-символов в текущей схеме, 40 у старых (genesis) адресов.
        if (typeof to !== 'string' || !/^K[0-9A-F]{39,40}$/.test(to)) return fail(400, 'Некорректный адрес получателя');
        amount = parseFloat(amount);
        if (isNaN(amount) || amount <= 0) return fail(400, 'Некорректная сумма');
        if (from === to) return fail(400, 'Нельзя отправить себе');

        const privKey = auth.getPrivateKey(from, password);
        if (!privKey) return fail(400, 'Неверный пароль');
        const derived = ecdsa.addressFromPrivate(privKey);
        if (!derived || derived.address !== from) return fail(400, 'Ключ не совпадает');

        const fee   = bc.calcFee(amount);
        const total = amount + fee;
        const bal   = bc.getBalance(data, from);
        const pout  = bc.getPendingOut(data.mempool, from);
        if (bal - pout < total) return fail(400, `Недостаточно. Доступно: ${(bal - pout).toFixed(6)}, нужно: ${total.toFixed(6)}`);

        const tx = {
          id: 'tx_' + crypto.randomBytes(8).toString('hex'),
          from, to,
          amount: parseFloat(amount.toFixed(6)),
          fee: parseFloat(fee.toFixed(6)),
          timestamp: Date.now(),
          nonce: crypto.randomBytes(4).readUInt32BE(0),
          publicKey: derived.publicKey,
          memo: memo || ''
        };
        tx.signature = ecdsa.sign(ecdsa.txSignData(tx), privKey);
        if (!tx.signature) return fail(500, 'Ошибка подписи');

        data.mempool.push(tx);
        immediateSave(data);
        ui.log(`\x1b[96m📨 ${from.slice(0, 10)}... → ${to.slice(0, 10)}... | ${amount} QTR\x1b[0m`);
        log.info(`TX submitted | id=${tx.id} | from=${from} | to=${to} | amount=${amount} QTR | fee=${fee} QTR`);
        return ok({ success: true, tx, fee, total: parseFloat(total.toFixed(6)) });
      });
    }

    fail(404, 'Не найдено');
  });

  // Прогреваем кэши до старта — полная валидация цепи один раз при запуске,
  // чтобы первый входящий запрос /stats не блокировал event loop
  { const d = loadData(); if (d && d.chain) getCachedValidity(d.chain); }

  srv.listen(API_PORT, () => ui.log(`\x1b[33m◆ API: http://localhost:${API_PORT}\x1b[0m`));
}

// ─── Сохранение кошелька в JSON ───────────────────────────────────────────────
function saveWalletBackup(role, isGenesis) {
  if (!minerPrivKey) return; // только адрес без ключа — нечего сохранять

  const walletData = {
    createdAt:  new Date().toISOString(),
    role,
    address:    minerAddress,
    privateKey: minerPrivKey,
    mnemonic:   lastCreatedMnemonic || null,
    note: isGenesis
      ? `Genesis wallet — holds initial ${bc.TOTAL_SUPPLY.toLocaleString()} QTR. KEEP THIS FILE SAFE AND NEVER SHARE.`
      : 'Mining node wallet.'
  };

  // Всегда сохраняем текущий wallet ноды (если файл уже есть — не перезаписываем,
  // чтобы случайно не затереть старый ключ при перезапуске с другими env-переменными)
  const nodeFile = 'node_wallet.json';
  if (!fs.existsSync(nodeFile)) {
    fs.writeFileSync(nodeFile, JSON.stringify(walletData, null, 2));
    log.info(`Wallet backup saved → ${nodeFile} (${minerAddress})`);
    console.log(`\x1b[92m  ✅ Кошелёк сохранён: ${nodeFile}\x1b[0m`);
  }

  // Genesis-кошелёк сохраняем отдельно и ВСЕГДА (он нужен как резерв)
  if (isGenesis) {
    const genesisFile = 'GENESIS_WALLET_BACKUP.json';
    fs.writeFileSync(genesisFile, JSON.stringify(walletData, null, 2));
    log.info(`Genesis wallet backup saved → ${genesisFile} (${minerAddress})`);
    console.log(`\x1b[93m  🔑 Genesis backup: ${genesisFile}  ← СОХРАНИ ЭТОТ ФАЙЛ!\x1b[0m`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await setup();

  // Проверяем ДО bc.init(), потому что bc.init() создаёт blockchain.json
  const isFirstRun = !fs.existsSync('blockchain.json');

  bc.init(minerAddress);

  const isGenesisWallet = isFirstRun; // первый запуск → этот кошелёк получил 1B QTR

  if (!bc.loadGenesis()) bc.saveGenesis({ address: minerAddress, createdAt: Date.now() });

  // ── Сохранение кошельков в JSON ───────────────────────────────────────────
  saveWalletBackup(isGenesisWallet ? 'genesis_and_miner' : 'miner', isGenesisWallet);

  log.info(`Node started. minerAddress=${minerAddress} firstRun=${isFirstRun}`);

  const data = loadData();
  if (!data.wallets[minerAddress]) { data.wallets[minerAddress] = 0; immediateSave(data); }
  const peerArg = process.argv.find((a, i) => process.argv[i - 1] === '--peer');
  if (peerArg) p2p.addPeer(peerArg);
  startAPI();
  // Передаём dataManager чтобы P2P использовал кэш, а не читал диск напрямую
  p2p.startSync(API_PORT, { load: loadData, save: debouncedSave });

  if (NO_MINE) {
    console.log('\x1b[93m⏸  QTR_NO_MINE=true — нода запущена без майнинга (только API + P2P)\x1b[0m');
    // Держим процесс живым, периодически логируя состояние
    setInterval(() => {
      const d = loadData();
      if (d) console.log(`📊 Нода: ${d.chain.length} блоков | mempool: ${d.mempool.length} тр.`);
    }, 60_000);
  } else {
    await runMiner();
  }
})();
