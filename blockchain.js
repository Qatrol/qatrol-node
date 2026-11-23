// blockchain.js — Qatrol Coin (QTR)
'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const ecdsa  = require('./crypto/ecdsa');

const path = require('path');
const { readJson, writeJsonAtomic } = require('./lib/storage');
const DB_FILE      = path.join(__dirname, 'blockchain.json');
const GENESIS_FILE = path.join(__dirname, 'genesis.json');

// ─── Параметры монеты ─────────────────────────────────────────────────────────
const COIN_NAME        = 'Qatrol Coin';
const COIN_TICKER      = 'QTR';
const TOTAL_SUPPLY     = 1_000_000_000;   // 1 млрд QTR, навсегда
const BLOCK_REWARD     = 16.7;            // 16.7 QTR за блок из genesis
const FEE_PERCENT      = 0.001;           // 0.1% комиссия
const MIN_FEE          = 0.0001;
const FIXED_DIFFICULTY = null;             // null = авто; число = зафиксировать
const BASE_DIFFICULTY  = 5;
const MIN_DIFFICULTY    = 6;
const MAX_DIFFICULTY    = 14;
const TARGET_BLOCK_TIME = 600_000;        // целевое среднее время блока (~10 мин)
const MAX_BLOCK_TIME_MS =  5 * 60 * 1000; // если дольше 5 мин — снижаем сложность
const ADJUST_INTERVAL  = 10;             // пересчёт по окну из N блоков

// ─── Хэши ────────────────────────────────────────────────────────────────────
function sha256(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function hashBlock({ index, prevHash, timestamp, transactions, nonce, difficulty }) {
  return sha256({ index, prevHash, timestamp, transactions, nonce, difficulty });
}

function calcFee(amount) {
  return parseFloat(Math.max(MIN_FEE, amount * FEE_PERCENT).toFixed(6));
}

// ─── Genesis ─────────────────────────────────────────────────────────────────
function loadGenesis() {
  if (!fs.existsSync(GENESIS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(GENESIS_FILE, 'utf8')); }
  catch { return null; }
}

function saveGenesis(data) {
  fs.writeFileSync(GENESIS_FILE, JSON.stringify(data, null, 2));
}

// Источник правды о genesis-кошельке — сама цепь, а не genesis.json.
// Иначе после клона репозитория в файле остаётся чужой адрес, и награда
// за блок (она платится из genesis-баланса) перестаёт начисляться.
function getGenesisAddress(chain) {
  const b = chain && chain[0];
  if (!b) return null;
  const sys = (b.transactions || []).find(t => t.from === 'SYSTEM');
  return sys?.to || b.miner || null;
}

// Приводит genesis.json в соответствие с цепью. Возвращает актуальный адрес.
function ensureGenesisFile(chain) {
  const addr = getGenesisAddress(chain);
  if (!addr) return null;
  const cur = loadGenesis();
  if (!cur || cur.address !== addr) {
    saveGenesis({ address: addr, createdAt: cur?.createdAt || Date.now() });
  }
  return addr;
}

function createGenesisBlock(genesisAddress) {
  const tx = {
    id: 'genesis_qtr_000',
    from: 'SYSTEM',
    to: genesisAddress,
    amount: TOTAL_SUPPLY,
    fee: 0,
    timestamp: Date.now(),
    nonce: 0,
    signature: 'GENESIS',
    memo: `${COIN_NAME} Genesis — ${TOTAL_SUPPLY.toLocaleString()} ${COIN_TICKER}`
  };
  const block = {
    index: 0,
    prevHash: '0'.repeat(64),
    timestamp: Date.now(),
    transactions: [tx],
    nonce: 0,
    difficulty: FIXED_DIFFICULTY != null ? FIXED_DIFFICULTY : BASE_DIFFICULTY,
    miner: genesisAddress,
    hash: ''
  };
  block.hash = hashBlock(block);
  return block;
}

// ─── Хранилище ────────────────────────────────────────────────────────────────
function load() {
  // Отсутствие файла — первый запуск. Битый JSON — исключение:
  // молча создавать новую цепь поверх повреждённой нельзя, это стирает все блоки.
  return readJson(DB_FILE).data;
}

function save(data) {
  writeJsonAtomic(DB_FILE, data);
}

function init(genesisAddress) {
  let data = load();
  if (!data || !data.chain || data.chain.length === 0) {
    if (!genesisAddress) throw new Error('Genesis address required');
    const genesis = createGenesisBlock(genesisAddress);
    data = { chain: [genesis], mempool: [], wallets: { [genesisAddress]: TOTAL_SUPPLY } };
    save(data);
    console.log(`\n🌱 ${COIN_NAME} Genesis создан`);
    console.log(`   Эмиссия: ${TOTAL_SUPPLY.toLocaleString()} ${COIN_TICKER}`);
    console.log(`   Genesis: ${genesisAddress}\n`);
  }
  // genesis.json всегда следует за цепью: на новой цепи там наш адрес,
  // на существующей — чиним файл, унаследованный от чужого деплоя.
  ensureGenesisFile(data.chain);
  return data;
}

// ─── Балансы ──────────────────────────────────────────────────────────────────
function getBalance(data, address) {
  return parseFloat(((data.wallets || {})[address] || 0).toFixed(6));
}

function getPendingOut(mempool, address) {
  return (mempool || []).filter(t => t.from === address)
    .reduce((s, t) => s + t.amount + t.fee, 0);
}

function applyBlock(data, block) {
  const genAddr = getGenesisAddress(data.chain);
  for (const tx of block.transactions) {
    if (tx.from === 'REWARD') {
      if (genAddr) {
        data.wallets[genAddr] = parseFloat(((data.wallets[genAddr] || 0) - tx.amount).toFixed(6));
      }
      data.wallets[tx.to] = parseFloat(((data.wallets[tx.to] || 0) + tx.amount).toFixed(6));
    } else if (tx.from === 'SYSTEM' || tx.from === 'SYSTEM_FEE') {
      data.wallets[tx.to] = parseFloat(((data.wallets[tx.to] || 0) + tx.amount).toFixed(6));
    } else {
      // Списываем у отправителя amount + fee. Fee сгорает здесь и затем
      // перечисляется майнеру через отдельную SYSTEM_FEE-транзакцию в блоке.
      // Двойного начисления нет: SYSTEM_FEE обрабатывается веткой выше.
      data.wallets[tx.from] = parseFloat(((data.wallets[tx.from] || 0) - tx.amount - tx.fee).toFixed(6));
      data.wallets[tx.to]   = parseFloat(((data.wallets[tx.to]   || 0) + tx.amount).toFixed(6));
    }
  }
}

// ─── Проверка транзакций блока ────────────────────────────────────────────────
// Без неё пир или пул мог прислать блок с «печатным станком»: REWARD не тому
// адресу, SYSTEM_FEE больше собранных комиссий, перевод без денег на счету.
function validateBlockTxs(data, block) {
  const wallets = { ...(data.wallets || {}) };
  const genAddr = getGenesisAddress(data.chain);
  const isSystem = f => f === 'SYSTEM' || f === 'SYSTEM_FEE' || f === 'REWARD';

  const userTxs = (block.transactions || []).filter(t => !isSystem(t.from));
  const totalFees = userTxs.reduce((s, t) => s + (t.fee || 0), 0);
  // nonce, уже попавшие в недавние блоки: защита от переотправки подписи с новым id
  const usedNonces = new Set();
  for (const b of (data.chain || []).slice(-200)) {
    for (const t of b.transactions || []) {
      if (!isSystem(t.from)) usedNonces.add(`${t.from}:${t.nonce}`);
    }
  }

  for (const tx of block.transactions || []) {
    if (tx.from === 'SYSTEM') {
      if (block.index !== 0) return 'SYSTEM tx outside genesis';
      continue;
    }
    if (tx.from === 'REWARD') {
      if (!genAddr) return 'no genesis address';
      if (tx.to !== block.miner) return 'reward to wrong address';
      if (tx.amount !== BLOCK_REWARD) return 'bad reward amount';
      if ((wallets[genAddr] || 0) < tx.amount) return 'genesis balance exhausted';
      wallets[genAddr] = (wallets[genAddr] || 0) - tx.amount;
      wallets[tx.to]   = (wallets[tx.to]   || 0) + tx.amount;
      continue;
    }
    if (tx.from === 'SYSTEM_FEE') {
      if (tx.to !== block.miner) return 'fee to wrong address';
      if (tx.amount > totalFees + 1e-9) return 'fee exceeds collected fees';
      wallets[tx.to] = (wallets[tx.to] || 0) + tx.amount;
      continue;
    }
    const err = validateTx(tx, wallets, []);
    if (err) return `tx ${tx.id}: ${err}`;
    if (usedNonces.has(`${tx.from}:${tx.nonce}`)) return `tx ${tx.id}: nonce reused`;
    usedNonces.add(`${tx.from}:${tx.nonce}`);
    wallets[tx.from] = (wallets[tx.from] || 0) - tx.amount - tx.fee;
    wallets[tx.to]   = (wallets[tx.to]   || 0) + tx.amount;
  }
  return null;
}

// Полная проверка чужой цепи: та же genesis-точка, структура, PoW и транзакции.
// Возвращает { data } с пересчитанными балансами или { error }.
function importChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return { error: 'empty chain' };
  const local = load();
  const localGenesis = local?.chain?.[0];
  if (localGenesis && chain[0]?.hash !== localGenesis.hash) return { error: 'genesis mismatch' };

  const structure = validateChain(chain);
  if (!structure.ok) return { error: `block ${structure.index}: ${structure.reason}` };

  const genTx   = (chain[0].transactions || []).find(t => t.from === 'SYSTEM');
  const genAddr = genTx?.to || chain[0].miner;
  if (!genAddr) return { error: 'genesis has no recipient' };

  const data = { chain: [chain[0]], mempool: [], wallets: { [genAddr]: TOTAL_SUPPLY } };
  for (let i = 1; i < chain.length; i++) {
    const err = validateBlock(chain[i], chain[i - 1]);
    if (err) return { error: `block ${i}: ${err}` };
    const txErr = validateBlockTxs(data, chain[i]);
    if (txErr) return { error: `block ${i}: ${txErr}` };
    data.chain.push(chain[i]);
    applyBlock(data, chain[i]);
  }
  return { data };
}

// ─── Награда за блок из genesis ───────────────────────────────────────────────
function createRewardTx(minerAddress, blockIndex, genesisAddress) {
  if (!genesisAddress) return null;
  return {
    id: `reward_${blockIndex}_${crypto.randomBytes(4).toString('hex')}`,
    from: 'REWARD',
    to: minerAddress,
    amount: BLOCK_REWARD,
    fee: 0,
    timestamp: Date.now(),
    nonce: 0,
    signature: 'BLOCK_REWARD',
    memo: `Block #${blockIndex} reward`
  };
}

// ─── Валидация транзакции ─────────────────────────────────────────────────────
function validateTx(tx, wallets, mempool) {
  if (!tx || typeof tx !== 'object') return 'not an object';
  if (!tx.id || !tx.from || !tx.to) return 'missing fields';
  if (typeof tx.from !== 'string' || typeof tx.to !== 'string') return 'bad address type';
  if (typeof tx.id !== 'string') return 'bad id type';
  // Системные транзакции (эмиссия, комиссии) принимаются только внутри блока,
  // который собрал локальный майнер или пул. Через мемпул и API — никогда:
  // иначе любой мог «напечатать» себе баланс через /pool/add-tx.
  if (tx.from === 'SYSTEM' || tx.from === 'SYSTEM_FEE' || tx.from === 'REWARD') return 'system tx not allowed';
  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount <= 0) return 'amount <= 0';
  if (typeof tx.fee !== 'number' || tx.fee < 0) return 'invalid fee';
  if (tx.from === tx.to) return 'self-transfer';
  if (!tx.publicKey || !tx.signature) return 'no signature';
  if (ecdsa.deriveAddress(tx.publicKey) !== tx.from) return 'address/key mismatch';
  if (!ecdsa.verify(ecdsa.txSignData(tx), tx.signature, tx.publicKey)) return 'invalid signature';
  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) return 'bad nonce';
  if (tx.memo !== undefined && typeof tx.memo !== 'string') return 'bad memo';
  if ((tx.memo || '').length > 200) return 'memo too long';
  // Повтор той же подписи с новым id — это replay: ловим по from+nonce.
  const replay = (mempool || []).find(t => t.from === tx.from && t.nonce === tx.nonce && t.id !== tx.id);
  if (replay) return 'duplicate nonce';
  const balance    = (wallets || {})[tx.from] || 0;
  const pendingOut = (mempool || []).filter(t => t.from === tx.from).reduce((s, t) => s + t.amount + t.fee, 0);
  if (balance - pendingOut < tx.amount + tx.fee) return 'insufficient funds';
  return null;
}

// nonce уже встречался в недавних блоках? Нужно, чтобы переотправленная
// с новым id подпись не оплатилась второй раз.
function isNonceUsed(chain, from, nonce, depth = 200) {
  for (const b of (chain || []).slice(-depth)) {
    for (const t of b.transactions || []) {
      if (t.from === from && t.nonce === nonce) return true;
    }
  }
  return false;
}

// ─── Сложность ───────────────────────────────────────────────────────────────
function calcDifficulty(chain) {
  if (FIXED_DIFFICULTY != null) return FIXED_DIFFICULTY;

  const lastBlock = chain[chain.length - 1];
  const current = lastBlock?.difficulty || BASE_DIFFICULTY;

  // Срочно смягчаем, если майнеры молчат дольше MAX_BLOCK_TIME_MS
  const sinceLast = Date.now() - (lastBlock?.timestamp || 0);
  if (chain.length > 1 && sinceLast > MAX_BLOCK_TIME_MS) {
    const drop = Math.min(3, Math.floor(sinceLast / MAX_BLOCK_TIME_MS));
    return Math.max(MIN_DIFFICULTY, current - drop);
  }

  if (chain.length < ADJUST_INTERVAL) return Math.max(MIN_DIFFICULTY, Math.min(current, MAX_DIFFICULTY));

  const window      = chain.slice(-ADJUST_INTERVAL);
  const elapsedSec  = (window[window.length - 1].timestamp - window[0].timestamp) / 1000;
  const avgSec      = elapsedSec / (ADJUST_INTERVAL - 1); // среднее время блока в секундах
  const targetSec   = TARGET_BLOCK_TIME / 1000;

  if (avgSec <= 0) return Math.max(MIN_DIFFICULTY, Math.min(current, MAX_DIFFICULTY));

  // Вычисляем хэшрейт из наблюдений: H = 16^diff / avgSec
  // Затем идеальную сложность: ideal = log16(H * targetSec)
  // Что сводится к: ideal = current + log16(targetSec / avgSec)
  const idealDiff = current + Math.log(targetSec / avgSec) / Math.log(16);

  // Округляем к ближайшему, но если разница < 0.35 — держим текущее
  // (убирает дрожание на границе двух целых)
  const delta = idealDiff - current;
  let next;
  if (Math.abs(delta) < 0.35) {
    next = current; // в зоне комфорта — не меняем
  } else {
    const MAX_STEP = 2;
    next = Math.max(current - MAX_STEP, Math.min(current + MAX_STEP, Math.round(idealDiff)));
  }

  return Math.max(MIN_DIFFICULTY, Math.min(next, MAX_DIFFICULTY));
}

// ─── Валидация цепи ───────────────────────────────────────────────────────────
function validateBlock(block, prevBlock) {
  if (!prevBlock)                         return 'no previous block';
  if (block.index !== prevBlock.index + 1) return 'bad index';
  if (block.prevHash !== prevBlock.hash)   return 'bad prevHash';
  if (!Array.isArray(block.transactions))  return 'bad transactions';
  if (hashBlock(block) !== block.hash)     return 'bad hash';
  const diff = block.difficulty || BASE_DIFFICULTY;
  if (!Number.isInteger(diff))             return 'difficulty not integer';
  if (diff < MIN_DIFFICULTY || diff > MAX_DIFFICULTY) return 'difficulty out of range';
  // Сложность не может прыгать больше чем на шаг пересчёта: иначе пир
  // объявляет diff 6 при сети на 14 и находит блок в тысячи раз быстрее.
  const prevDiff = prevBlock.difficulty || BASE_DIFFICULTY;
  if (diff < prevDiff - 3) return 'difficulty dropped too fast';
  if (diff > prevDiff + 2) return 'difficulty jumped too fast';
  if (!block.hash.startsWith('0'.repeat(diff))) return 'insufficient PoW';
  if (block.timestamp <= prevBlock.timestamp)   return 'timestamp not increasing';
  if (block.timestamp > Date.now() + 60_000)    return 'timestamp too far in future';
  return null;
}

function validateChain(chain) {
  // Structural-only check for existing chain — doesn't apply policy rules
  // (difficulty range, PoW strictness) that may have changed after blocks were mined
  for (let i = 1; i < chain.length; i++) {
    const b    = chain[i];
    const prev = chain[i - 1];
    if (b.index !== prev.index + 1)   return { ok: false, index: i, reason: 'bad index' };
    if (b.prevHash !== prev.hash)      return { ok: false, index: i, reason: 'bad prevHash' };
    if (hashBlock(b) !== b.hash)       return { ok: false, index: i, reason: 'bad hash' };
    if (b.timestamp < prev.timestamp)  return { ok: false, index: i, reason: 'timestamp went back' };
    const diff = b.difficulty || BASE_DIFFICULTY;
    if (!b.hash.startsWith('0'.repeat(diff))) return { ok: false, index: i, reason: 'insufficient PoW' };
  }
  return { ok: true };
}

// ─── История ──────────────────────────────────────────────────────────────────
function getHistory(chain, address, limit = 50) {
  const txs = [];
  for (let i = chain.length - 1; i >= 0 && txs.length < limit; i--) {
    for (const tx of chain[i].transactions) {
      if (tx.from === address || tx.to === address) {
        txs.push({ ...tx, blockIndex: chain[i].index, blockHash: chain[i].hash, confirmed: true, confirmations: chain.length - chain[i].index });
      }
    }
  }
  return txs;
}

// ─── Данные для графиков ──────────────────────────────────────────────────────
function getChartData(chain, limit = 60) {
  const blocks = chain.slice(-limit);
  return blocks.map((b, i) => ({
    index: b.index,
    timestamp: b.timestamp,
    txCount: b.transactions.length,
    difficulty: b.difficulty,
    blockTime: i > 0 ? (b.timestamp - blocks[i - 1].timestamp) / 1000 : 0,
    fees: b.transactions.reduce((s, t) => s + (t.fee || 0), 0)
  }));
}

module.exports = {
  load, save, init,
  loadGenesis, saveGenesis, getGenesisAddress, ensureGenesisFile,
  sha256, hashBlock, calcFee,
  getBalance, getPendingOut, applyBlock, validateBlockTxs, importChain, isNonceUsed,
  createRewardTx,
  validateTx, validateBlock, validateChain,
  calcDifficulty, getHistory, getChartData,
  COIN_NAME, COIN_TICKER, TOTAL_SUPPLY, BLOCK_REWARD,
  FEE_PERCENT, MIN_FEE, FIXED_DIFFICULTY, BASE_DIFFICULTY, TARGET_BLOCK_TIME,
  MIN_DIFFICULTY, MAX_DIFFICULTY, MAX_BLOCK_TIME_MS,
  DB_FILE
};
