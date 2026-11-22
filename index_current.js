// bot/index.js — Qatrol Coin Telegram Bot
// npm install node-telegram-bot-api
'use strict';

const TelegramBot  = require('node-telegram-bot-api');
const http         = require('http');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('../logger');

const log = createLogger('bot', { printToConsole: true });

const PROJECT_ROOT = path.resolve(process.env.QTR_PROJECT_ROOT || path.join(__dirname, '..'));

function loadEnvFromProjectRoot() {
  const p = path.join(PROJECT_ROOT, '.env');
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
    if (!key) continue;
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
  }
}
loadEnvFromProjectRoot();

const TOKEN       = process.env.QTR_BOT_TOKEN  || '';
const API_HOST    = process.env.QTR_API_HOST   || 'localhost';
const API_PORT    = parseInt(process.env.QTR_PORT      || '3001');
const POOL_PORT   = parseInt(process.env.QTR_POOL_PORT || '3002');
const MINER_URL   = process.env.QTR_MINER_URL  || 'https://github.com/yourname/qatrol/releases';
const PUBLIC_URL  = (process.env.QTR_PUBLIC_URL  || '').trim();
const CHANNEL_URL = (process.env.QTR_CHANNEL_URL || '').trim(); // напр. https://t.me/qatrolcoin
const POOL_BUILD_HOST = (process.env.QTR_POOL_BUILD_HOST || '').trim();
const MINER_PUBLIC_EXE = path.join(PROJECT_ROOT, 'dist', 'qtr-pool-miner-public.exe');
const MINER_BUILD_COOLDOWN_MS = parseInt(process.env.QTR_MINER_BUILD_COOLDOWN_MS || '600000', 10);
const BOT_PROXY = process.env.QTR_BOT_PROXY || '';
const BOT_POLLING_INTERVAL_MS = parseInt(process.env.QTR_BOT_POLLING_INTERVAL_MS || '1200');
const BOT_UPLOAD_TIMEOUT_MS = parseInt(process.env.QTR_BOT_UPLOAD_TIMEOUT_MS || '600000', 10);

if (!TOKEN) { console.error('❌ Нужен QTR_BOT_TOKEN'); process.exit(1); }

// ─── Админ и конкурс ──────────────────────────────────────────────────────────
const ADMIN_ID     = 8387259474;
const CONTEST_FILE = path.join(PROJECT_ROOT, 'bot_contest.json');

function isAdmin(chatId) { return Number(chatId) === ADMIN_ID; }

function loadContest() {
  if (!fs.existsSync(CONTEST_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CONTEST_FILE, 'utf8')); }
  catch { return null; }
}
function saveContest(c) { fs.writeFileSync(CONTEST_FILE, JSON.stringify(c, null, 2)); }

const botOptions = {
  polling: {
    interval: BOT_POLLING_INTERVAL_MS,
    params: { timeout: 30 }
  },
  // Большие upload в Telegram через прокси — нужен длинный timeout (иначе socket hang up)
  request: {
    timeout: BOT_UPLOAD_TIMEOUT_MS,
    ...(BOT_PROXY ? { proxy: BOT_PROXY } : {})
  }
};

if (BOT_PROXY) console.log(`🌐 Telegram proxy: ${BOT_PROXY}`);
console.log(`⏱ Telegram HTTP timeout: ${BOT_UPLOAD_TIMEOUT_MS} ms`);

const bot = new TelegramBot(TOKEN, botOptions);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const _sendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = async (chatId, text, options = {}, retries = 2) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await _sendMessage(chatId, text, options);
    } catch (err) {
      const isLast = attempt === retries;
      const status = err?.response?.statusCode;
      // Если проблема в markdown-разметке, повторяем как plain text.
      if (status === 400 && options?.parse_mode) {
        try {
          const fallback = { ...options };
          delete fallback.parse_mode;
          return await _sendMessage(chatId, text, fallback);
        } catch {}
      }
      if (isLast) {
        console.error('❌ sendMessage failed:', err?.message || err);
        return null;
      }
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
};

bot.on('polling_error', (err) => {
  const msg = err?.message || String(err);
  console.error('⚠ polling_error:', msg);
  log.error(`Telegram polling error: ${msg}`);
});

function getOrBuildMinerExe() {
  const host = (process.env.QTR_POOL_BUILD_HOST || POOL_BUILD_HOST || '').trim();
  if (!host) throw new Error('Задай QTR_POOL_BUILD_HOST=IP:3002 в .env и перезапусти бота');
  if (fs.existsSync(MINER_PUBLIC_EXE)) {
    const age = Date.now() - fs.statSync(MINER_PUBLIC_EXE).mtimeMs;
    if (age < MINER_BUILD_COOLDOWN_MS) return MINER_PUBLIC_EXE;
  }
  const script = path.join(PROJECT_ROOT, 'scripts', 'build-miner-win-embed.js');
  if (!fs.existsSync(script)) throw new Error(`Нет scripts/build-miner-win-embed.js в ${PROJECT_ROOT}`);
  const cmd = `node "${script}"`;
  try {
    execSync(cmd, {
      cwd: PROJECT_ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, QTR_POOL_BUILD_HOST: host },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    const tail = ((e.stderr && e.stderr.toString()) || e.stdout || e.message || '').slice(0, 900);
    throw new Error(`Сборка pkg не удалась. Установи зависимости: cd ${PROJECT_ROOT} && npm install. Лог: ${tail}`);
  }
  if (!fs.existsSync(MINER_PUBLIC_EXE)) throw new Error(`Файл не создан: ${MINER_PUBLIC_EXE}`);
  return MINER_PUBLIC_EXE;
}

const TG_DOC_LIMIT = 48 * 1024 * 1024;

function minerDownloadUrl() {
  const base = (process.env.QTR_PUBLIC_URL || PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) return '';
  return `${base}/download/qtr-pool-miner.exe`;
}

/** @returns {Promise<{ sent: boolean }>} */
async function sendMinerDocument(chatId) {
  const exePath = getOrBuildMinerExe();
  const st = fs.statSync(exePath);
  const sizeMb = (st.size / 1024 / 1024).toFixed(1);
  log.info(`Sending miner exe to chatId=${chatId}: ${exePath} (${sizeMb} MB)`);

  if (st.size > TG_DOC_LIMIT) {
    const url = minerDownloadUrl();
    log.warn(`Exe too large (${sizeMb} MB > ${TG_DOC_LIMIT / 1024 / 1024} MB limit). Sending download link.`);
    await bot.sendMessage(chatId, url
      ? `📦 Файл слишком большой для Telegram (${sizeMb} MB). Скачай напрямую:\n${url}`
      : `📦 Файл слишком большой (${sizeMb} MB). Задай QTR_PUBLIC_URL в .env для ссылки на скачивание.`);
    return { sent: false };
  }

  const docOpts = {
    caption: `⛏ Qatrol Coin пул-майнер v1.0 (${sizeMb} MB)\nЗапуск: введи адрес K… Пул уже зашит внутрь.`,
    filename: 'qtr-pool-miner.exe',
    contentType: 'application/octet-stream'
  };

  const retriable = (err) => {
    const m = String(err?.message || err?.code || err || '');
    return /hang up|ECONNRESET|ETIMEDOUT|socket|aborted|timeout|EFATAL/i.test(m);
  };

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const delay = 6000 * attempt;
      log.warn(`Retry sendDocument (${attempt + 1}/5) in ${delay / 1000}s…`);
      await sleep(delay);
    }
    try {
      // Каждую попытку создаём НОВЫЙ ReadStream — буфер не читаем целиком в память,
      // это решает проблему socket hang up на больших файлах через прокси.
      const stream = fs.createReadStream(exePath);
      await bot.sendDocument(chatId, stream, docOpts);
      log.info(`Miner exe sent successfully to chatId=${chatId} (attempt ${attempt + 1})`);
      return { sent: true };
    } catch (e) {
      lastErr = e;
      log.error(`sendDocument attempt ${attempt + 1} failed: ${e.message || e}`);
      if (!retriable(e) || attempt === 4) break;
    }
  }

  // Все попытки провалились
  const url = minerDownloadUrl();
  log.error(`All sendDocument attempts failed for chatId=${chatId}. Last error: ${lastErr?.message || lastErr}`);
  await bot.sendMessage(chatId, [
    `❌ Не удалось отправить файл через Telegram (${sizeMb} MB).`,
    `Причина: ${lastErr?.message || lastErr}`,
    url
      ? `\n📥 Скачай напрямую с сервера:\n${url}`
      : `\nЗадай QTR_PUBLIC_URL=http://ТВОЙ_IP:3000 в .env — тогда дам прямую ссылку.`
  ].join('\n'));
  return { sent: false };
}

// ─── Переводы бота ────────────────────────────────────────────────────────────
const BOT_TRANSLATIONS = {
  'start.welcome': {
    ru: [
      '👋 *Добро пожаловать в Qatrol Coin!*',
      '',
      '◆ QTR — криптовалюта для всех',
      '◆ Майни прямо с компьютера — без оборудования',
      '◆ *16.7 QTR* за каждый найденный блок',
      '◆ Фиксированная эмиссия: 1,000,000,000 QTR',
      '',
      'Создай кошелёк за 30 секунд 👇'
    ].join('\n'),
    en: [
      '👋 *Welcome to Qatrol Coin!*',
      '',
      '◆ QTR — crypto for everyone',
      '◆ Mine directly from your PC — no equipment needed',
      '◆ *16.7 QTR* for every block found',
      '◆ Fixed supply: 1,000,000,000 QTR',
      '',
      'Create a wallet in 30 seconds 👇'
    ].join('\n')
  },
  'start.returning': {
    ru: [
      '👋 *С возвращением!*',
      '',
      '◆ *Qatrol Coin (QTR)*',
      '',
      'Твой кошелёк: `{address}`',
      '',
      'Используй кнопки меню ниже 👇'
    ].join('\n'),
    en: [
      '👋 *Welcome back!*',
      '',
      '◆ *Qatrol Coin (QTR)*',
      '',
      'Your wallet: `{address}`',
      '',
      'Use the menu buttons below 👇'
    ].join('\n')
  },
  'wallet.created': {
    ru: [
      '🎉 *Кошелёк создан!*',
      '',
      '📍 Адрес:',
      '`{address}`',
      '',
      '🔑 Приватный ключ:',
      '`{privateKey}`',
      '',
      '🌱 Мнемоник (12 слов):',
      '`{mnemonic}`',
      '',
      '⚠️ *СОХРАНИ ЭТИ ДАННЫЕ* — без них доступ потерян навсегда!',
      '❗ Удали это сообщение после сохранения'
    ].join('\n'),
    en: [
      '🎉 *Wallet created!*',
      '',
      '📍 Address:',
      '`{address}`',
      '',
      '🔑 Private key:',
      '`{privateKey}`',
      '',
      '🌱 Mnemonic (12 words):',
      '`{mnemonic}`',
      '',
      '⚠️ *SAVE THIS DATA* — without it access is lost forever!',
      '❗ Delete this message after saving'
    ].join('\n')
  },
  'balance.title': {
    ru: [
      '💰 *Баланс кошелька*',
      '',
      '📍 `{address}`',
      '',
      'Доступно:    *{available} QTR*',
      'В обработке: {pendingOut} QTR',
      'Всего:       {balance} QTR'
    ].join('\n'),
    en: [
      '💰 *Wallet Balance*',
      '',
      '📍 `{address}`',
      '',
      'Available:  *{available} QTR*',
      'Pending:    {pendingOut} QTR',
      'Total:      {balance} QTR'
    ].join('\n')
  },
  'stats.title': {
    ru: [
      '📊 *Qatrol Coin — Статистика*',
      '',
      '⛓ Блоков: *{blocks}*',
      '🎯 Сложность: {difficulty}',
      '⚡ Hashrate: {hashrate}',
      '⏳ В очереди: {pendingTx} тр.',
      '',
      '💎 Эмиссия: {totalSupply} QTR',
      '💰 В обращении: {circulatingSupply} QTR',
      '🏆 Награда за блок: {blockReward} QTR',
      '💸 Комиссия: {feePercent}%',
      '',
      '✅ Цепочка {validStr}'
    ].join('\n'),
    en: [
      '📊 *Qatrol Coin — Network Stats*',
      '',
      '⛓ Blocks: *{blocks}*',
      '🎯 Difficulty: {difficulty}',
      '⚡ Hashrate: {hashrate}',
      '⏳ Pending: {pendingTx} tx',
      '',
      '💎 Total supply: {totalSupply} QTR',
      '💰 Circulating: {circulatingSupply} QTR',
      '🏆 Block reward: {blockReward} QTR',
      '💸 Fee: {feePercent}%',
      '',
      '✅ Chain {validStr}'
    ].join('\n')
  },
  'stats.valid': { ru: 'валидна', en: 'is valid' },
  'stats.invalid': { ru: '❌ НАРУШЕНА', en: '❌ INVALID' },
  'settings.title': {
    ru: [
      '⚙️ *Настройки*',
      '',
      '📍 Адрес: `{address}`',
      ''
    ].join('\n'),
    en: [
      '⚙️ *Settings*',
      '',
      '📍 Address: `{address}`',
      ''
    ].join('\n')
  },
  'settings.notif_on':  { ru: '🔔 Уведомления: ВКЛ', en: '🔔 Notifications: ON' },
  'settings.notif_off': { ru: '🔕 Уведомления: ВЫКЛ', en: '🔕 Notifications: OFF' },
  'settings.my_addr':   { ru: '📍 Мой адрес + QR', en: '📍 My address + QR' },
  'settings.ref':       { ru: '🎁 Реферальная ссылка', en: '🎁 Referral link' },
  'settings.open_site': { ru: '🌐 Открыть сайт', en: '🌐 Open website' },
  'settings.logout':    { ru: '🚪 Выйти из кошелька', en: '🚪 Logout' },
  'notif.toggled_on': {
    ru: '🔔 *Уведомления включены!*\n\nТы будешь получать уведомление каждый раз, когда твой майнер найдёт блок.',
    en: '🔔 *Notifications enabled!*\n\nYou will receive a notification each time your miner finds a block.'
  },
  'notif.toggled_off': {
    ru: '🔕 Уведомления отключены.',
    en: '🔕 Notifications disabled.'
  },
  'btn.create_wallet':  { ru: '🆕 Создать кошелёк', en: '🆕 Create Wallet' },
  'btn.login_wallet':   { ru: '🔑 Войти (есть аккаунт)', en: '🔑 Login (have account)' },
  'btn.open_site':      { ru: '🌐 Открыть сайт', en: '🌐 Open website' },
  'btn.tg_channel':     { ru: '📢 Наш Telegram-канал', en: '📢 Our Telegram channel' },
  'lang.switched_ru': { ru: '🇷🇺 Язык изменён на русский', en: '🇷🇺 Language changed to Russian' },
  'lang.switched_en': { ru: '🇷🇺 Язык изменён на русский', en: '🇬🇧 Language switched to English' },
  'menu.balance':    { ru: '💰 Баланс',       en: '💰 Balance'    },
  'menu.send':       { ru: '📤 Отправить',    en: '📤 Send'       },
  'menu.mining':     { ru: '⛏ Майнинг',      en: '⛏ Mining'     },
  'menu.top_miners': { ru: '🏆 Топ майнеров', en: '🏆 Top Miners' },
  'menu.stats':      { ru: '📊 Статистика',   en: '📊 Stats'      },
  'menu.pool':       { ru: '🏊 Пул',          en: '🏊 Pool'       },
  'menu.price':      { ru: '📈 Курс',         en: '📈 Price'      },
  'menu.referral':   { ru: '🎁 Реферал',      en: '🎁 Referral'   },
  'menu.history':    { ru: '📜 История',      en: '📜 History'    },
  'menu.settings':   { ru: '⚙️ Настройки',    en: '⚙️ Settings'   },
  'menu.channel':    { ru: '📢 Наш канал',    en: '📢 Channel'    },
  'menu.contest':    { ru: '🏆 Конкурс',      en: '🏆 Contest'    },
};

/**
 * Returns translated string with variable substitution.
 * @param {string} key
 * @param {string} lang  'ru' | 'en'
 * @param {Object} vars  { varName: value }
 */
function tBot(key, lang, vars = {}) {
  const entry = BOT_TRANSLATIONS[key];
  if (!entry) return key;
  let str = entry[lang] || entry['ru'] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return str;
}

// ─── Хранилище пользователей (простое JSON) ───────────────────────────────────
const USERS_FILE = 'bot_users.json';

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

function getUser(chatId) { return loadUsers()[chatId]; }

function setUser(chatId, data) {
  const users = loadUsers();
  const existing = users[chatId] || {};
  // Default lang to 'ru' for new users
  if (!existing.lang && !data.lang) data.lang = 'ru';
  users[chatId] = { ...existing, ...data };
  saveUsers(users);
}

function getUserLang(chatId) {
  const u = getUser(chatId);
  return (u && u.lang) || 'ru';
}

function hasChosenLang(chatId) {
  const u = getUser(chatId);
  return !!(u && u.lang);
}

const LANG_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[
      { text: '\u{1F1F7}\u{1F1FA} \u0420\u0443\u0441\u0441\u043a\u0438\u0439', callback_data: 'set_lang_ru' },
      { text: '\u{1F1EC}\u{1F1E7} English', callback_data: 'set_lang_en' }
    ]]
  }
};

function getMainMenu(lang) {
  const l = lang || 'ru';
  return {
    reply_markup: {
      keyboard: [
        [tBot('menu.balance', l),    tBot('menu.send', l)       ],
        [tBot('menu.mining', l),     tBot('menu.top_miners', l) ],
        [tBot('menu.stats', l),      tBot('menu.pool', l)       ],
        [tBot('menu.price', l),      tBot('menu.referral', l)   ],
        [tBot('menu.history', l),    tBot('menu.settings', l)   ],
        [tBot('menu.channel', l),    tBot('menu.contest', l)    ],
      ],
      resize_keyboard: true
    }
  };
}

function isMenu(text, key) {
  return text === tBot(key, 'ru') || text === tBot(key, 'en');
}

// ─── Рассылка всем зарегистрированным пользователям ──────────────────────────
async function broadcastAll(text, options = {}, excludeId = null) {
  const users = loadUsers();
  let sent = 0, failed = 0, skipped = 0;
  for (const [cid, u] of Object.entries(users)) {
    if (!u.address) { skipped++; continue; } // только с кошельком
    if (excludeId && String(cid) === String(excludeId)) continue;
    try {
      await bot.sendMessage(Number(cid), text, options);
      sent++;
      await sleep(65); // ~15 msg/sec, не превышаем лимит Telegram
    } catch { failed++; }
  }
  return { sent, failed, skipped };
}

// ─── Получить участников конкурса из блокчейна ────────────────────────────────
async function getContestEntries(contestAddress) {
  const res = await apiRequest('/history/' + contestAddress + '?limit=1000');
  if (res.error || !res.history) return [];
  const users = loadUsers();
  // address -> chatId маппинг
  const addrToChat = {};
  for (const [cid, u] of Object.entries(users)) {
    if (u.address) addrToChat[u.address] = cid;
  }
  const entries = {};
  for (const tx of res.history) {
    if (tx.to !== contestAddress) continue;
    if (tx.from === 'REWARD' || tx.from === 'SYSTEM') continue;
    if (!entries[tx.from]) entries[tx.from] = { address: tx.from, total: 0, chatId: addrToChat[tx.from] || null };
    entries[tx.from].total += tx.amount;
  }
  return Object.values(entries).sort((a, b) => b.total - a.total);
}

// ─── Взвешенная лотерея (чем больше QTR — тем выше шанс) ─────────────────────
function pickLotteryWinner(entries) {
  if (!entries.length) return null;
  const total = entries.reduce((s, e) => s + e.total, 0);
  let r = Math.random() * total;
  for (const e of entries) {
    r -= e.total;
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

// ─── API ──────────────────────────────────────────────────────────────────────
function apiRequest(path, method = 'GET', body = null, token = null) {
  return new Promise(resolve => {
    const opts = {
      hostname: API_HOST, port: API_PORT, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Session-Token': token } : {})
      },
      timeout: 5000
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ error: 'parse' }); } });
    });
    req.on('error', () => resolve({ error: 'network' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Pool API (порт 3002) ─────────────────────────────────────────────────────
function poolRequest(path, method = 'GET', body = null) {
  return new Promise(resolve => {
    const opts = {
      hostname: API_HOST, port: POOL_PORT, path, method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ error: 'parse' }); } });
    });
    req.on('error', () => resolve({ error: 'network' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Форматирование ───────────────────────────────────────────────────────────
function short(addr, n = 8) {
  if (!addr) return '—';
  return addr.slice(0, n) + '...' + addr.slice(-n);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return s + 'с назад';
  if (s < 3600)  return Math.floor(s / 60) + 'м назад';
  return Math.floor(s / 3600) + 'ч назад';
}

function fmtHashrate(h = 0) {
  if (h >= 1_000_000) return (h / 1_000_000).toFixed(2) + ' MH/s';
  if (h >= 1_000) return (h / 1_000).toFixed(1) + ' kH/s';
  return h + ' H/s';
}

async function sendNetworkStats(chatId) {
  const res = await apiRequest('/stats');
  const lang = getUserLang(chatId);
  if (res.error) {
    bot.sendMessage(chatId, lang === 'en' ? '❌ Node unavailable' : '❌ Нода недоступна');
    return;
  }
  const validStr = res.valid ? tBot('stats.valid', lang) : tBot('stats.invalid', lang);
  bot.sendMessage(chatId,
    tBot('stats.title', lang, {
      blocks:            res.blocks,
      difficulty:        res.difficulty,
      hashrate:          fmtHashrate(res.hashrate || 0),
      pendingTx:         res.pendingTx,
      totalSupply:       Number(res.totalSupply).toLocaleString(),
      circulatingSupply: Number(res.circulatingSupply).toLocaleString(),
      blockReward:       res.blockReward,
      feePercent:        res.feePercent,
      validStr
    }),
    { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') }
  );
}

async function sendPoolStats(chatId, address = null) {
  const res = await poolRequest('/pool/stats');
  if (res.error) {
    log.warn(`Pool stats unavailable for chatId=${chatId}: ${res.error}`);
    bot.sendMessage(chatId, `❌ Пул недоступен (${API_HOST}:${POOL_PORT})`);
    return;
  }
  const workers = res.workers || [];
  const top = workers
    .sort((a, b) => (b.shares || 0) - (a.shares || 0))
    .slice(0, 5)
    .map((w, i) => `${i + 1}) \`${short(w.address, 6)}\` • ${w.shares} shares • ${fmtHashrate(w.hashrate || 0)}`);
  const me = address ? workers.find(w => w.address === address) : null;
  bot.sendMessage(chatId, [
    `🏊 *Статистика пула*`,
    ``,
    `Активных воркеров: *${res.activeWorkers || 0}*`,
    `Всего воркеров: ${res.totalWorkers || 0}`,
    `Всего shares: ${res.totalShares || 0}`,
    `Сложность share: ${res.shareDifficulty}`,
    ``,
    me ? `👤 Ты: ${me.shares} shares • ${fmtHashrate(me.hashrate || 0)}` : `👤 Твой адрес не найден в активных воркерах`,
    ``,
    top.length ? `🏅 Топ воркеров:\n${top.join('\n')}` : 'Пока нет данных по воркерам'
  ].join('\n'), { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
}

async function sendTopMiners(chatId) {
  const res = await poolRequest('/pool/leaderboard');
  if (res.error || !res.leaderboard) {
    bot.sendMessage(chatId, `❌ Пул недоступен или данных нет`);
    return;
  }
  const lb = res.leaderboard.slice(0, 10);
  if (!lb.length) {
    bot.sendMessage(chatId, `🏆 *Топ майнеров*\n\nПока нет активных майнеров.`, { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const rows = lb.map((w, i) => {
    const icon = medals[i] || `${i + 1}.`;
    const active = w.active ? '🟢' : '⚫';
    return `${icon} ${active} \`${short(w.address, 6)}\`  ${w.shares} шар  ${fmtHashrate(w.hashrate)}  ${w.percent}%`;
  });
  bot.sendMessage(chatId, [
    `🏆 *Топ майнеров QTR*`,
    ``,
    `Всего воркеров: ${res.totalWorkers}  |  Шар: ${res.totalShares}`,
    ``,
    rows.join('\n')
  ].join('\n'), { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
}

async function sendRefInfo(chatId, user) {
  const botInfo = await bot.getMe().catch(() => null);
  const botUsername = botInfo?.username || '';
  const refs = user?.referrals || [];
  const link = botUsername ? `https://t.me/${botUsername}?start=ref_${chatId}` : '(бот не настроен)';
  bot.sendMessage(chatId, [
    `🎁 *Реферальная программа*`,
    ``,
    `Поделись ссылкой — когда по ней зарегистрируются, ты увидишь уведомление.`,
    ``,
    `👥 Твоих рефералов: *${refs.length}*`,
    ``,
    `🔗 Твоя ссылка:`,
    `\`${link}\``
  ].join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: botUsername
        ? [[{ text: '📤 Поделиться ссылкой', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Попробуй Qatrol Coin — бесплатный майнинг прямо с ПК!')}` }]]
        : []
    }
  });
}

// MAIN_MENU replaced by getMainMenu(lang)

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const param   = (match?.[1] || '').trim();
  const user    = getUser(chatId);

  // Обработка реферальной ссылки: /start ref_<chatId>
  if (param.startsWith('ref_')) {
    const refId = param.replace('ref_', '');
    if (refId && String(refId) !== String(chatId) && !user?.referredBy) {
      setUser(chatId, { referredBy: refId });
      // Кредитуем реферера
      const refUser = getUser(refId);
      if (refUser) {
        const refs = refUser.referrals || [];
        if (!refs.includes(String(chatId))) {
          refs.push(String(chatId));
          setUser(refId, { referrals: refs });
          bot.sendMessage(refId, `🎁 *Новый реферал!*\n\nПо твоей ссылке зарегистрировался новый пользователь.\nВсего рефералов: *${refs.length}*`, { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
    }
  }

  const lang = getUserLang(chatId);

  // New user without language choice --- ask first
  if (!hasChosenLang(chatId)) {
    setUser(chatId, { state: 'awaiting_lang' });
    await bot.sendMessage(chatId, '\u{1F30D} \u{0412}\u{044B}\u{0431}\u{0435}\u{0440}\u{0438} \u{044F}\u{0437}\u{044B}\u{043A} / Choose your language:', LANG_KEYBOARD);
    return;
  }

  if (user?.address) {
    bot.sendMessage(chatId,
      tBot('start.returning', lang, { address: user.address }),
      { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') }
    );
    return;
  }

  const welcomeKb = [
    [{ text: tBot('btn.create_wallet', lang), callback_data: 'create_wallet' }],
    [{ text: tBot('btn.login_wallet', lang),  callback_data: 'login_wallet' }]
  ];
  if (PUBLIC_URL)  welcomeKb.push([{ text: tBot('btn.open_site', lang), url: PUBLIC_URL }]);
  if (CHANNEL_URL) welcomeKb.push([{ text: tBot('btn.tg_channel', lang), url: CHANNEL_URL }]);

  bot.sendMessage(chatId, tBot('start.welcome', lang), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: welcomeKb }
  });
});

// ─── Создание кошелька ────────────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const data   = q.data;
  const lang   = getUserLang(chatId) || 'ru';
  if (data === 'miner_download') {
    await bot.answerCallbackQuery(q.id, { text: 'Готовлю .exe…' });
  } else {
    bot.answerCallbackQuery(q.id);
  }

  if (data === 'create_wallet') {
    bot.sendMessage(chatId, '🔐 Придумай пароль для кошелька (минимум 6 символов):\n\n⚠️ Пароль нельзя восстановить — запомни его!');
    setUser(chatId, { state: 'awaiting_new_password' });
  }

  if (data === 'login_wallet') {
    bot.sendMessage(chatId, '📝 Введи адрес своего кошелька (начинается с K):');
    setUser(chatId, { state: 'awaiting_login_address' });
  }

  if (data === 'confirm_send') {
    const user = getUser(chatId);
    if (!user?.pendingSend) return;
    const { to, amount, password } = user.pendingSend;
    const res = await apiRequest('/send', 'POST', { to, amount: parseFloat(amount), password }, user.token);
    if (res.error) {
      log.error(`Send TX failed: chatId=${chatId} from=${user.address} to=${to} amount=${amount}: ${res.error}`);
      bot.sendMessage(chatId, `❌ Ошибка: ${res.error}`, getMainMenu(lang || 'ru'));
    } else {
      log.info(`TX sent: id=${res.tx?.id} from=${user.address} to=${to} amount=${amount} QTR fee=${res.fee}`);
      bot.sendMessage(chatId, [
        `✅ *Транзакция отправлена!*`,
        ``,
        `Кому: \`${short(to)}\``,
        `Сумма: *${amount} QTR*`,
        `Комиссия: ${res.fee} QTR`,
        `ID: \`${res.tx.id}\``,
        ``,
        `⏳ Ожидает подтверждения майнером`
      ].join('\n'), { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
    }
    setUser(chatId, { pendingSend: null, state: null });
  }

  if (data === 'cancel_send') {
    setUser(chatId, { pendingSend: null, state: null });
    bot.sendMessage(chatId, '❌ Отменено', getMainMenu(lang || 'ru'));
  }

  if (data === 'miner_download') {
    log.info(`User chatId=${chatId} requested miner download`);
    await bot.sendMessage(chatId, '⏳ Собираю Windows-майнер (1–3 мин). Не закрывай чат…');
    try {
      const { sent } = await sendMinerDocument(chatId);
      if (sent) await bot.sendMessage(chatId, '✅ Файл отправлен.', getMainMenu(lang || 'ru'));
    } catch (e) {
      log.error(`miner_download callback failed for chatId=${chatId}: ${e.message || e}`);
      console.error(e);
      await bot.sendMessage(chatId, `❌ ${e.message || e}`);
    }
  }

  if (data === 'toggle_notifications') {
    const u = getUser(chatId) || {};
    const newVal = !(u.notifications === true);
    setUser(chatId, { notifications: newVal });
    // lang already declared above
    await bot.sendMessage(chatId,
      tBot(newVal ? 'notif.toggled_on' : 'notif.toggled_off', lang),
      { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') }
    );
  }

  if (data === 'set_lang_en' || data === 'set_lang_ru') {
    const nelang = data === 'set_lang_en' ? 'en' : 'ru';
    setUser(chatId, { lang: nelang, state: null });
    const switchKey = nelang === 'en' ? 'lang.switched_en' : 'lang.switched_ru';
    await bot.sendMessage(chatId, tBot(switchKey, nelang), getMainMenu(nelang));
    const u2 = getUser(chatId);
    if (!u2?.address) {
      const wKb = [
        [{ text: tBot('btn.create_wallet', nelang), callback_data: 'create_wallet' }],
        [{ text: tBot('btn.login_wallet',  nelang), callback_data: 'login_wallet'  }]
      ];
      if (PUBLIC_URL)  wKb.push([{ text: tBot('btn.open_site',  nelang), url: PUBLIC_URL  }]);
      if (CHANNEL_URL) wKb.push([{ text: tBot('btn.tg_channel', nelang), url: CHANNEL_URL }]);
      await bot.sendMessage(chatId, tBot('start.welcome', nelang), {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: wKb }
      });
    }
    return;
  }

  if (data === 'show_address') {
    const u = getUser(chatId) || {};
    if (!u.address) { bot.sendMessage(chatId, '❌ Войди сначала. /start'); return; }
    const addr = u.address;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(addr)}&margin=10`;
    try {
      await bot.sendPhoto(chatId, qrUrl, {
        caption: `📍 *Твой адрес QTR:*\n\`${addr}\``,
        parse_mode: 'Markdown'
      });
    } catch {
      bot.sendMessage(chatId, `📍 *Твой адрес:*\n\`${addr}\``, { parse_mode: 'Markdown' });
    }
  }

  if (data === 'show_ref') {
    const u = getUser(chatId) || {};
    await sendRefInfo(chatId, u);
  }

  if (data === 'do_logout') {
    setUser(chatId, { address: null, token: null, state: null });
    bot.sendMessage(chatId, '👋 Выход выполнен. /start чтобы войти снова.');
  }

  if (data === 'contest_join') {
    const contest = loadContest();
    if (!contest || !contest.active) { bot.sendMessage(chatId, '❌ Конкурс не активен'); return; }
    const u = getUser(chatId) || {};
    if (!u.address) { bot.sendMessage(chatId, '❌ Сначала создай кошелёк. /start'); return; }
    setUser(chatId, { state: 'awaiting_send_to', pendingSend: { to: contest.address } });
    bot.sendMessage(chatId, [
      `📤 *Участие в конкурсе*`,
      ``,
      `Конкурсный адрес уже заполнен.`,
      `Введи сумму QTR для участия (минимум ${contest.minAmount || 10} QTR):`,
      ``,
      `💡 Каждый QTR = 1 билет. Больше = выше шанс!`
    ].join('\n'), { parse_mode: 'Markdown' });
    setUser(chatId, { state: 'awaiting_send_amount', pendingSend: { to: contest.address } });
  }

  if (data === 'no_site') {
    bot.sendMessage(chatId, '⚙️ Сайт не настроен. Администратор должен задать QTR_PUBLIC_URL в .env');
  }
});

// ─── Обработка текста ─────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  const user = getUser(chatId) || {};
  const lang = getUserLang(chatId) || 'ru';

  // ── Состояния ──────────────────────────────────────────────────────────────
  if (user.state === 'awaiting_lang') {
    // Handled by callback_query (inline keyboard), ignore text
    return;
  }

  if (user.state === 'awaiting_new_password') {
    if (text.length < 6) { bot.sendMessage(chatId, '❌ Минимум 6 символов, попробуй ещё:'); return; }
    bot.sendMessage(chatId, '⏳ Создаю кошелёк...');
    const res = await apiRequest('/auth/register', 'POST', { password: text, label: `Telegram ${chatId}` });
    if (res.error) {
      log.error(`Wallet creation failed for chatId=${chatId}: ${res.error}`);
      bot.sendMessage(chatId, `❌ Ошибка: ${res.error}`);
      return;
    }
    log.info(`New wallet created via bot: address=${res.address} chatId=${chatId}`);
    setUser(chatId, { address: res.address, token: res.token, state: null });
    // lang already declared above
    bot.sendMessage(chatId,
      tBot('wallet.created', lang, { address: res.address, privateKey: res.privateKey, mnemonic: res.mnemonic }),
      { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') }
    );
    return;
  }

  if (user.state === 'awaiting_login_address') {
    if (!text.startsWith('K') || text.length < 10) { bot.sendMessage(chatId, '❌ Неверный адрес, попробуй ещё:'); return; }
    setUser(chatId, { loginAddress: text, state: 'awaiting_login_password' });
    bot.sendMessage(chatId, '🔐 Введи пароль:');
    return;
  }

  if (user.state === 'awaiting_login_password') {
    const res = await apiRequest('/auth/login', 'POST', { address: user.loginAddress, password: text });
    if (res.error) {
      log.warn(`Login failed for chatId=${chatId} address=${user.loginAddress}: ${res.error}`);
      bot.sendMessage(chatId, `❌ ${res.error}`);
      return;
    }
    log.info(`User logged in: chatId=${chatId} address=${res.address}`);
    setUser(chatId, { address: res.address, token: res.token, loginAddress: null, state: null });
    bot.sendMessage(chatId, `✅ *Вход выполнен!*\n\nКошелёк: \`${res.address}\``, { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
    return;
  }

  if (user.state === 'awaiting_send_to') {
    if (!text.startsWith('K')) { bot.sendMessage(chatId, '❌ Неверный адрес (должен начинаться с K):'); return; }
    setUser(chatId, { pendingSend: { to: text }, state: 'awaiting_send_amount' });
    bot.sendMessage(chatId, `📍 Получатель: \`${short(text)}\`\n\nВведи сумму в QTR:`, { parse_mode: 'Markdown' });
    return;
  }

  if (user.state === 'awaiting_send_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, '❌ Неверная сумма:'); return; }
    setUser(chatId, { pendingSend: { ...user.pendingSend, amount }, state: 'awaiting_send_password' });
    bot.sendMessage(chatId, `💰 Сумма: *${amount} QTR*\n\nВведи пароль для подписи:`, { parse_mode: 'Markdown' });
    return;
  }

  if (user.state === 'awaiting_send_password') {
    const { to, amount } = user.pendingSend;
    const fee = Math.max(0.0001, parseFloat((amount * 0.001).toFixed(6)));
    setUser(chatId, { pendingSend: { ...user.pendingSend, password: text }, state: null });
    bot.sendMessage(chatId, [
      `📋 *Подтвердить транзакцию:*`,
      ``,
      `Кому: \`${short(to)}\``,
      `Сумма: *${amount} QTR*`,
      `Комиссия: ${fee} QTR`,
      `Итого: ${(amount + fee).toFixed(6)} QTR`
    ].join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Подтвердить', callback_data: 'confirm_send' }, { text: '❌ Отмена', callback_data: 'cancel_send' }]
        ]
      }
    });
    return;
  }

  // ── Кнопки меню ────────────────────────────────────────────────────────────
  if (isMenu(text, 'menu.balance')) {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди или создай кошелёк. /start'); return; }
    const res = await apiRequest('/balance/' + user.address);
    // lang already declared above
    if (res.error) {
      bot.sendMessage(chatId, lang === 'en' ? '❌ Node unavailable' : '❌ Нода недоступна');
      return;
    }
    bot.sendMessage(chatId,
      tBot('balance.title', lang, {
        address:    user.address,
        available:  (res.available || 0).toFixed(6),
        pendingOut: (res.pendingOut || 0).toFixed(6),
        balance:    (res.balance || 0).toFixed(6)
      }),
      { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') }
    );
    return;
  }

  if (isMenu(text, 'menu.send')) {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди. /start'); return; }
    setUser(chatId, { state: 'awaiting_send_to' });
    bot.sendMessage(chatId, '📤 *Отправить QTR*\n\nВведи адрес получателя (начинается с K):', { parse_mode: 'Markdown' });
    return;
  }

  if (isMenu(text, 'menu.stats')) {
    await sendNetworkStats(chatId);
    return;
  }

  if (isMenu(text, 'menu.pool')) {
    await sendPoolStats(chatId, user.address || null);
    return;
  }

  if (isMenu(text, 'menu.top_miners')) {
    await sendTopMiners(chatId);
    return;
  }

  if (isMenu(text, 'menu.price')) {
    bot.sendMessage(chatId, [
      `📈 *Qatrol Coin (QTR) — Курс*`,
      ``,
      `На данный момент QTR не торгуется на биржах.`,
      ``,
      `🚀 Листинг на бирже запланирован — следи за новостями в канале.`,
      ``,
      `📊 Текущая ценность определяется сообществом.`,
      `Чем больше майнеров — тем ценнее монета.`,
      ``,
      `🔔 Включи уведомления в ⚙️ *Настройки*, чтобы не пропустить листинг.`
    ].join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...(PUBLIC_URL   ? [[{ text: '🌐 Открыть сайт', url: PUBLIC_URL }]] : []),
          ...(CHANNEL_URL  ? [[{ text: '📢 Подписаться на канал', url: CHANNEL_URL }]] : []),
          [{ text: '🔔 Включить уведомления', callback_data: 'toggle_notifications' }]
        ]
      }
    });
    return;
  }

  if (isMenu(text, 'menu.channel')) {
    if (!CHANNEL_URL) {
      bot.sendMessage(chatId, 'Канал скоро появится! Следи за обновлениями.', getMainMenu(lang || 'ru'));
      return;
    }
    bot.sendMessage(chatId, [
      `📢 *Qatrol Coin — официальный канал*`,
      ``,
      `Там публикуем:`,
      `• новости о проекте`,
      `• обновления и релизы майнера`,
      `• анонсы листинга`,
      `• статистику сети`,
      ``,
      `Подписывайся чтобы не пропустить!`
    ].join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Открыть канал', url: CHANNEL_URL }],
          ...(PUBLIC_URL ? [[{ text: '🌐 Сайт проекта', url: PUBLIC_URL }]] : [])
        ]
      }
    });
    return;
  }

  if (isMenu(text, 'menu.referral')) {
    await sendRefInfo(chatId, user);
    return;
  }

  if (isMenu(text, 'menu.contest')) {
    const contest = loadContest();
    if (!contest || !contest.active) {
      bot.sendMessage(chatId, [
        `🏆 *Конкурс Qatrol Coin*`,
        ``,
        `Сейчас активных конкурсов нет.`,
        ``,
        `Следи за новостями — скоро будет!`,
        CHANNEL_URL ? `\n📢 ${CHANNEL_URL}` : ''
      ].join('\n'), { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
      return;
    }
    const entries = await getContestEntries(contest.address);
    const myEntry = user.address ? entries.find(e => e.address === user.address) : null;
    const totalSent = entries.reduce((s, e) => s + e.total, 0);
    const myChance = (myEntry && totalSent > 0) ? ((myEntry.total / totalSent) * 100).toFixed(1) : '0';
    bot.sendMessage(chatId, [
      `🏆 *Конкурс Qatrol Coin*`,
      ``,
      `🎁 Приз: *${contest.prize.toLocaleString()} QTR*`,
      `📅 До: *${contest.endDate}*`,
      ``,
      `📋 Правила:`,
      `• Отправь QTR на конкурсный адрес`,
      `• Каждый QTR = 1 лотерейный билет`,
      `• Чем больше отправишь — тем выше шанс`,
      `• Победитель выбирается случайно`,
      `• Приз приходит прямо на кошелёк`,
      ``,
      `📍 Конкурсный адрес:`,
      `\`${contest.address}\``,
      ``,
      `👥 Участников: *${entries.length}*  |  Всего QTR: *${totalSent.toFixed(1)}*`,
      myEntry
        ? `\n👤 Твои билеты: *${myEntry.total.toFixed(2)} QTR* (шанс ~${myChance}%)`
        : `\n👤 Ты ещё не участвуешь — отправь QTR на адрес выше!`
    ].join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📤 Участвовать (Отправить QTR)', callback_data: 'contest_join' }]
        ]
      }
    });
    return;
  }

  if (text === '🔎 Поиск') {
    setUser(chatId, { state: 'awaiting_search_query' });
    bot.sendMessage(chatId, '🔎 Введи запрос: hash блока / index / tx id / адрес K...');
    return;
  }

  if (text === '🌐 Сайт') {
    if (!PUBLIC_URL) {
      bot.sendMessage(chatId, 'Сайт не настроен. Админу: задать QTR_PUBLIC_URL в .env');
      return;
    }
    bot.sendMessage(chatId, '🌐 Веб-кошелёк и обозреватель:', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть сайт', url: PUBLIC_URL }]]
      }
    });
    return;
  }

  if (isMenu(text, 'menu.mining')) {
    const releaseUrl = process.env.QTR_MINER_RELEASE_URL || MINER_URL;
    const lines = [
      `⛏ *Майнинг Qatrol Coin*`,
      ``,
      `Майни в пуле — получай *16.7 QTR* за каждый блок.`,
      `Пул уже вшит в майнер, просто запусти и укажи свой адрес.`,
      ``,
      `📍 Твой адрес: ${user.address ? `\`${user.address}\`` : '_(создай или войди в кошелёк)_'}`,
      ``,
      `📥 Скачай майнер по кнопке ниже — это Windows .exe, никаких настроек.`
    ];
    const kb = [];
    if (releaseUrl && !releaseUrl.includes('yourname')) {
      kb.push([{ text: '📥 Скачать майнер (.exe)', url: releaseUrl }]);
    }
    if (PUBLIC_URL) kb.push([{ text: '🌐 Веб-кошелёк', url: PUBLIC_URL }]);
    bot.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: kb.length ? kb : undefined }
    });
    return;
  }

  if (isMenu(text, 'menu.history')) {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди. /start'); return; }
    const res = await apiRequest('/history/' + user.address + '?limit=10');
    if (res.error || !res.history?.length) {
      bot.sendMessage(chatId, '📜 *История транзакций*\n\nПока нет транзакций', { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
      return;
    }
    const lines = res.history.slice(0, 10).map(tx => {
      const isIn  = tx.to === user.address;
      const isSys = tx.from === 'REWARD' || tx.from === 'SYSTEM';
      const peer  = isIn ? (isSys ? '⛏ Майнинг' : short(tx.from, 6)) : short(tx.to, 6);
      const sign  = isIn ? '+' : '-';
      const conf  = tx.confirmed ? '✅' : '⏳';
      return `${conf} ${sign}${tx.amount} QTR ${isIn ? '←' : '→'} ${peer}`;
    });
    bot.sendMessage(chatId, `📜 *Последние транзакции:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
    return;
  }

  if (isMenu(text, 'menu.settings')) {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди. /start'); return; }
    // lang already declared above
    const notifOn = user.notifications === true;
    bot.sendMessage(chatId,
      tBot('settings.title', lang, { address: user.address }),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: tBot('settings.my_addr', lang), callback_data: 'show_address' }],
            [{ text: notifOn ? tBot('settings.notif_on', lang) : tBot('settings.notif_off', lang), callback_data: 'toggle_notifications' }],
            [{ text: tBot('settings.ref', lang), callback_data: 'show_ref' }],
            [{ text: lang === 'ru' ? '🇬🇧 Switch to English' : '🇷🇺 Переключить на русский', callback_data: lang === 'ru' ? 'set_lang_en' : 'set_lang_ru' }],
            [{ text: tBot('settings.open_site', lang), ...(PUBLIC_URL ? { url: PUBLIC_URL } : { callback_data: 'no_site' }) }],
            [{ text: tBot('settings.logout', lang), callback_data: 'do_logout' }]
          ]
        }
      }
    );
    return;
  }

  if (user.state === 'awaiting_search_query') {
    setUser(chatId, { state: null });
    const q = encodeURIComponent(text);
    const res = await apiRequest('/search/' + q);
    if (res.error) { bot.sendMessage(chatId, '❌ Ничего не найдено или нода недоступна', getMainMenu(lang || 'ru')); return; }
    if (res.type === 'block') {
      bot.sendMessage(chatId, `🧱 Найден блок #${res.data.index}\nHash: \`${res.data.hash}\``, { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
      return;
    }
    if (res.type === 'tx') {
      bot.sendMessage(chatId, `💸 Найдена tx\nID: \`${res.data.id}\`\nСумма: ${res.data.amount} QTR`, { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
      return;
    }
    if (res.type === 'address') {
      bot.sendMessage(chatId, `👛 Адрес: \`${res.data.address}\`\nБаланс: *${Number(res.data.balance || 0).toFixed(6)} QTR*`, { parse_mode: 'Markdown', ...getMainMenu(lang || 'ru') });
      return;
    }
    bot.sendMessage(chatId, 'ℹ️ Найдено, но формат не распознан', getMainMenu(lang || 'ru'));
    return;
  }
});

// ─── Команды ──────────────────────────────────────────────────────────────────
bot.onText(/\/logout/, (msg) => {
  setUser(msg.chat.id, { address: null, token: null, state: null });
  bot.sendMessage(msg.chat.id, '👋 Выход выполнен. /start чтобы войти снова.');
});

bot.onText(/\/address/, async (msg) => {
  const chatId = msg.chat.id;
  const user = getUser(chatId);
  if (!user?.address) { bot.sendMessage(chatId, '❌ Войди сначала. /start'); return; }
  const addr = user.address;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(addr)}&margin=10`;
  try {
    await bot.sendPhoto(chatId, qrUrl, {
      caption: `📍 *Твой адрес QTR:*\n\`${addr}\`\n\nОтправь его другому пользователю, чтобы получить монеты.`,
      parse_mode: 'Markdown'
    });
  } catch {
    bot.sendMessage(chatId, `📍 *Твой адрес:*\n\`${addr}\``, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, [
    `◆ *Qatrol Coin (QTR)* — криптовалюта нового поколения`,
    ``,
    `QTR создана с одной целью: сделать крипту *простой и доступной каждому*. Никаких бирж — просто скачай майнер, укажи свой адрес и начни получать монеты прямо сейчас.`,
    ``,
    `⛏ *Майнинг:* 16.7 QTR за каждый блок`,
    `🔒 *Фиксированная эмиссия:* 1,000,000,000 QTR навсегда`,
    `💸 *Переводы:* мгновенно, комиссия всего 0.1%`,
    `🌐 *Открытый блокчейн:* каждый может проверить любую транзакцию`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*Команды:*`,
    `/start — главное меню`,
    `/address — твой адрес + QR`,
    `/miner — скачать майнер`,
    `/stats — статистика сети`,
    `/pool — статистика пула`,
    `/top — топ майнеров`,
    `/ref — реферальная ссылка`,
    `/notify — вкл/выкл уведомления о блоках`,
    `/block <index|hash> — информация о блоке`,
    `/tx <id> — транзакция`,
    `/search <q> — поиск`,
    `/logout — сменить кошелёк`,
    ``,
    `*Кнопки меню:*`,
    `💰 Баланс · 📤 Отправить · 📜 История`,
    `⛏ Майнинг · 🏆 Топ майнеров · 🏊 Пул`,
    `📊 Статистика · 📈 Курс · 🎁 Реферал · ⚙️ Настройки`
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/miner/, async (msg) => {
  const chatId = msg.chat.id;
  const releaseUrl = process.env.QTR_MINER_RELEASE_URL || MINER_URL;
  log.info(`/miner command from chatId=${chatId}`);
  if (releaseUrl && !releaseUrl.includes('yourname')) {
    await bot.sendMessage(chatId, [
      `⛏ *Qatrol Coin Pool Miner*`,
      ``,
      `Скачай .exe и запусти — пул уже вшит.`,
      `Введи свой адрес кошелька (начинается с K) и начни майнить.`,
      ``,
      `💰 Награда: *16.7 QTR* за блок`
    ].join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📥 Скачать майнер', url: releaseUrl }]] }
    });
  } else {
    await bot.sendMessage(chatId, '⚙️ Задай QTR_MINER_RELEASE_URL в .env — ссылку на GitHub Releases.');
  }
});

bot.onText(/\/stats/, async (msg) => {
  await sendNetworkStats(msg.chat.id);
});

bot.onText(/\/pool/, async (msg) => {
  const user = getUser(msg.chat.id) || {};
  await sendPoolStats(msg.chat.id, user.address || null);
});

bot.onText(/\/top/, async (msg) => {
  await sendTopMiners(msg.chat.id);
});

bot.onText(/\/ref/, async (msg) => {
  const user = getUser(msg.chat.id) || {};
  await sendRefInfo(msg.chat.id, user);
});

bot.onText(/\/notify/, async (msg) => {
  const chatId = msg.chat.id;
  const u = getUser(chatId) || {};
  const newVal = !(u.notifications === true);
  setUser(chatId, { notifications: newVal });
  bot.sendMessage(chatId, newVal ? '🔔 Уведомления о блоках включены.' : '🔕 Уведомления отключены.');
});

bot.onText(/\/mempool/, async (msg) => {
  const res = await apiRequest('/mempool');
  if (res.error) { bot.sendMessage(msg.chat.id, '❌ Нода недоступна'); return; }
  bot.sendMessage(msg.chat.id, `📦 Mempool: ${res.count || 0} tx, fees ${Number(res.totalFees || 0).toFixed(6)} QTR`);
});

bot.onText(/\/block (.+)/, async (msg, match) => {
  const q = (match?.[1] || '').trim();
  const res = await apiRequest('/block/' + encodeURIComponent(q));
  if (res.error || !res.block) { bot.sendMessage(msg.chat.id, '❌ Блок не найден'); return; }
  bot.sendMessage(msg.chat.id, [
    `🧱 *Блок #${res.block.index}*`,
    `Hash: \`${res.block.hash}\``,
    `Tx: ${res.block.transactions?.length || 0}`,
    `Подтверждений: ${res.confirmations}`
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/tx (.+)/, async (msg, match) => {
  const q = (match?.[1] || '').trim();
  const res = await apiRequest('/tx/' + encodeURIComponent(q));
  if (res.error || !res.tx) { bot.sendMessage(msg.chat.id, '❌ Транзакция не найдена'); return; }
  bot.sendMessage(msg.chat.id, [
    `💸 *Транзакция*`,
    `ID: \`${res.tx.id}\``,
    `${res.tx.from} → ${res.tx.to}`,
    `Сумма: ${res.tx.amount} QTR`,
    `Fee: ${res.tx.fee || 0} QTR`,
    `Статус: ${res.confirmed ? '✅ confirmed' : '⏳ pending'}`
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const q = encodeURIComponent((match?.[1] || '').trim());
  const res = await apiRequest('/search/' + q);
  if (res.error) { bot.sendMessage(msg.chat.id, '❌ Не найдено'); return; }
  bot.sendMessage(msg.chat.id, `🔎 Найден тип: ${res.type}`);
});

// ─── Уведомления о новых блоках ───────────────────────────────────────────────
let lastKnownBlockIndex = -1;

async function checkNewBlocks() {
  try {
    const res = await apiRequest('/stats');
    if (res.error || typeof res.blocks !== 'number') return;
    const latest = res.blocks - 1; // index последнего блока
    if (lastKnownBlockIndex < 0) { lastKnownBlockIndex = latest; return; }
    if (latest <= lastKnownBlockIndex) return;

    // Новые блоки появились — проверяем каждый
    for (let idx = lastKnownBlockIndex + 1; idx <= latest; idx++) {
      const blockRes = await apiRequest('/block/' + idx);
      if (blockRes.error || !blockRes.block) continue;
      const block = blockRes.block;
      const miner = block.miner || block.transactions?.find(t => t.from === 'REWARD')?.to;

      // Уведомляем всех подписчиков
      const users = loadUsers();
      for (const [cid, u] of Object.entries(users)) {
        if (!u.notifications) continue;
        // Всегда уведомляем — или только своего майнера?
        const isMyBlock = miner && u.address && miner === u.address;
        const emoji = isMyBlock ? '🎯' : '🧱';
        const uLang = (u.lang) || 'ru';
        const notifMsg = isMyBlock
          ? (uLang === 'en'
              ? `🎯 *You found a block!*\n\nBlock #${block.index}\nReward: *16.7 QTR* credited to your wallet!`
              : `🎯 *Ты нашёл блок!*\n\nБлок #${block.index}\nНаграда: *16.7 QTR* зачислена на твой кошелёк!`)
          : (uLang === 'en'
              ? `🧱 *New block #${block.index}*\n\nMiner: \`${short(miner || '?', 8)}\`\nTransactions: ${block.transactions?.length || 0}`
              : `🧱 *Новый блок #${block.index}*\n\nМайнер: \`${short(miner || '?', 8)}\`\nТранзакций: ${block.transactions?.length || 0}`);
        bot.sendMessage(cid, notifMsg, { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
    lastKnownBlockIndex = latest;
  } catch {}
}

setInterval(checkNewBlocks, 20_000); // каждые 20 секунд

// ─── Админ-команды ────────────────────────────────────────────────────────────

// /broadcast <текст> — рассылка всем зарегистрированным пользователям
bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Нет доступа'); return; }
  const text = (match?.[1] || '').trim();
  if (!text) {
    bot.sendMessage(chatId, [
      `📤 *Рассылка*`,
      ``,
      `Использование: /broadcast <текст>`,
      ``,
      `Пример:`,
      `/broadcast Привет! Завтра запускаем конкурс. Следите за новостями!`
    ].join('\n'), { parse_mode: 'Markdown' });
    return;
  }
  const users = loadUsers();
  const total = Object.values(users).filter(u => u.address).length;
  await bot.sendMessage(chatId, `📤 Рассылаю *${total}* пользователям...`, { parse_mode: 'Markdown' });
  const result = await broadcastAll(
    `📢 *Сообщение от команды Qatrol Coin:*\n\n${text}`,
    { parse_mode: 'Markdown' },
    chatId
  );
  bot.sendMessage(chatId, [
    `✅ *Рассылка завершена*`,
    ``,
    `📨 Отправлено: ${result.sent}`,
    `❌ Ошибок: ${result.failed}`,
    `⏭ Без кошелька: ${result.skipped}`
  ].join('\n'), { parse_mode: 'Markdown' });
});

// /startcontest <адрес> <приз> <дата> — запустить конкурс
// Пример: /startcontest K123... 10000 30.04.2026
bot.onText(/\/startcontest(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Нет доступа'); return; }
  const parts = (match?.[1] || '').trim().split(/\s+/);
  if (parts.length < 3 || !parts[0].startsWith('K')) {
    bot.sendMessage(chatId, [
      `🏆 *Запуск конкурса*`,
      ``,
      `Использование:`,
      `/startcontest <адрес> <приз_QTR> <дата>`,
      ``,
      `Пример:`,
      `/startcontest K814F1CF9... 10000 30.04.2026`
    ].join('\n'), { parse_mode: 'Markdown' });
    return;
  }
  const [address, prizeStr, ...dateParts] = parts;
  const prize = parseFloat(prizeStr);
  const endDate = dateParts.join(' ');
  if (isNaN(prize) || prize <= 0) { bot.sendMessage(chatId, '❌ Неверный приз'); return; }

  const contest = { active: true, address, prize, endDate, minAmount: 10, startedAt: Date.now() };
  saveContest(contest);

  const announceText = [
    `🏆 *Конкурс Qatrol Coin — ${prize.toLocaleString()} QTR!*`,
    ``,
    `Разыгрываем *${prize.toLocaleString()} QTR* — прямо на твой кошелёк!`,
    ``,
    `📋 *Правила:*`,
    `• Отправь QTR на конкурсный адрес`,
    `• Каждый QTR = 1 лотерейный билет`,
    `• Чем больше отправишь — тем выше шанс на победу`,
    `• Победитель выбирается случайно, но честно`,
    ``,
    `📍 *Конкурсный адрес:*`,
    `\`${address}\``,
    ``,
    `📅 Конкурс до: *${endDate}*`,
    `💰 Минимальный взнос: *${contest.minAmount} QTR*`,
    ``,
    `👇 Нажми кнопку *🏆 Конкурс* в меню, чтобы участвовать!`
  ].join('\n');

  await bot.sendMessage(chatId, `📤 Рассылаю анонс конкурса...`);
  // Сначала отправляем себе
  await bot.sendMessage(chatId, announceText, { parse_mode: 'Markdown' });
  const result = await broadcastAll(announceText, { parse_mode: 'Markdown' }, chatId);
  bot.sendMessage(chatId, [
    `✅ *Конкурс запущен!*`,
    ``,
    `📨 Анонс разослан: ${result.sent} пользователям`,
    `❌ Ошибок: ${result.failed}`
  ].join('\n'), { parse_mode: 'Markdown' });
});

// /checkcontest — текущие участники и шансы
bot.onText(/\/checkcontest/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Нет доступа'); return; }
  const contest = loadContest();
  if (!contest || !contest.active) { bot.sendMessage(chatId, '❌ Нет активного конкурса'); return; }

  await bot.sendMessage(chatId, '⏳ Загружаю данные...');
  const entries = await getContestEntries(contest.address);
  const totalSent = entries.reduce((s, e) => s + e.total, 0);

  if (!entries.length) {
    bot.sendMessage(chatId, '📭 Пока нет участников');
    return;
  }
  const lines = entries.slice(0, 15).map((e, i) => {
    const chance = totalSent > 0 ? ((e.total / totalSent) * 100).toFixed(1) : '0';
    const cid = e.chatId ? `tg:${e.chatId}` : 'незарег.';
    return `${i + 1}. \`${e.address.slice(0, 10)}...\` — ${e.total.toFixed(2)} QTR (${chance}%) [${cid}]`;
  });
  bot.sendMessage(chatId, [
    `🏆 *Статус конкурса*`,
    ``,
    `Участников: *${entries.length}*`,
    `Всего QTR: *${totalSent.toFixed(2)}*`,
    `Призовой фонд: *${contest.prize.toLocaleString()} QTR*`,
    ``,
    `*Таблица участников:*`,
    lines.join('\n')
  ].join('\n'), { parse_mode: 'Markdown' });
});

// /endcontest — завершить конкурс и выбрать победителя
bot.onText(/\/endcontest/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Нет доступа'); return; }
  const contest = loadContest();
  if (!contest || !contest.active) { bot.sendMessage(chatId, '❌ Нет активного конкурса'); return; }

  await bot.sendMessage(chatId, '⏳ Подсчитываю результаты...');
  const entries = await getContestEntries(contest.address);
  if (!entries.length) { bot.sendMessage(chatId, '❌ Нет участников, конкурс не завершён'); return; }

  const winner = pickLotteryWinner(entries);
  const totalSent = entries.reduce((s, e) => s + e.total, 0);
  const winnerChance = ((winner.total / totalSent) * 100).toFixed(1);

  // Сохраняем результат, деактивируем конкурс
  saveContest({ ...contest, active: false, winner: winner.address, endedAt: Date.now() });

  const resultText = [
    `🎉 *Конкурс Qatrol Coin завершён!*`,
    ``,
    `🏆 *Победитель:*`,
    `\`${winner.address}\``,
    ``,
    `🎁 Приз: *${contest.prize.toLocaleString()} QTR*`,
    `🎟 Билетов победителя: *${winner.total.toFixed(2)} QTR* (шанс был ${winnerChance}%)`,
    `👥 Всего участников: *${entries.length}*`,
    ``,
    `Поздравляем победителя! Приз будет отправлен в ближайшее время.`,
    ``,
    `Следи за новостями в канале: ${CHANNEL_URL || 'скоро'}`
  ].join('\n');

  // Уведомление победителю если он в боте
  if (winner.chatId) {
    bot.sendMessage(Number(winner.chatId), [
      `🎉 *Ты победил в конкурсе Qatrol Coin!*`,
      ``,
      `🏆 Приз: *${contest.prize.toLocaleString()} QTR*`,
      ``,
      `Твои билеты: *${winner.total.toFixed(2)} QTR*`,
      ``,
      `Приз придёт на твой кошелёк \`${winner.address}\` в ближайшее время!`
    ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
  }

  // Рассылка результатов
  await bot.sendMessage(chatId, resultText, { parse_mode: 'Markdown' });
  await bot.sendMessage(chatId, `📤 Рассылаю результаты...`);
  const result = await broadcastAll(resultText, { parse_mode: 'Markdown' }, chatId);
  bot.sendMessage(chatId, `✅ Результаты разосланы: ${result.sent} пользователям`);
});

// /cancelcontest — отменить конкурс без выбора победителя
bot.onText(/\/cancelcontest/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Нет доступа'); return; }
  const contest = loadContest();
  if (!contest || !contest.active) { bot.sendMessage(chatId, '❌ Нет активного конкурса'); return; }
  saveContest({ ...contest, active: false, cancelled: true });
  bot.sendMessage(chatId, '✅ Конкурс отменён');
});

// /admin — список доступных команд
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Нет доступа'); return; }
  const contest = loadContest();
  bot.sendMessage(chatId, [
    `⚙️ *Панель администратора*`,
    ``,
    `📤 *Рассылка:*`,
    `/broadcast <текст> — отправить всем`,
    ``,
    `🏆 *Управление конкурсом:*`,
    `/startcontest <адрес> <приз> <дата>`,
    `/checkcontest — статус и участники`,
    `/endcontest — завершить и выбрать победителя`,
    `/cancelcontest — отменить без победителя`,
    ``,
    `📊 *Статус конкурса:* ${contest?.active ? `✅ Активен (до ${contest.endDate})` : '❌ Нет активного'}`,
    ``,
    `👥 *Пользователей в боте:* ${Object.values(loadUsers()).filter(u => u.address).length}`
  ].join('\n'), { parse_mode: 'Markdown' });
});

console.log('\n\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[33m║      ◆  QATROL COIN TELEGRAM BOT  ◆              ║\x1b[0m');
console.log('\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m\n');
console.log('  Бот запущен. Открой @твой_бот в Telegram\n');
log.info(`Bot started. API=${API_HOST}:${API_PORT} POOL_BUILD_HOST=${POOL_BUILD_HOST || '(not set)'} PUBLIC_URL=${PUBLIC_URL || '(not set)'} EXE_CACHE_TTL=${MINER_BUILD_COOLDOWN_MS}ms`);
