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
const CHANNEL_URL = (process.env.QTR_CHANNEL_URL || '').trim();
const POOL_BUILD_HOST = (process.env.QTR_POOL_BUILD_HOST || '').trim();
const MINER_PUBLIC_EXE = path.join(PROJECT_ROOT, 'dist', 'qtr-pool-miner-public.exe');
const MINER_BUILD_COOLDOWN_MS = parseInt(process.env.QTR_MINER_BUILD_COOLDOWN_MS || '600000', 10);
const BOT_PROXY = process.env.QTR_BOT_PROXY || '';
const BOT_POLLING_INTERVAL_MS = parseInt(process.env.QTR_BOT_POLLING_INTERVAL_MS || '1200');
const BOT_UPLOAD_TIMEOUT_MS = parseInt(process.env.QTR_BOT_UPLOAD_TIMEOUT_MS || '600000', 10);

if (!TOKEN) { console.error('❌ Need QTR_BOT_TOKEN'); process.exit(1); }

// ─── Admin & contest ──────────────────────────────────────────────────────────
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
  if (!host) throw new Error('Set QTR_POOL_BUILD_HOST=IP:3002 in .env and restart bot');
  if (fs.existsSync(MINER_PUBLIC_EXE)) {
    const age = Date.now() - fs.statSync(MINER_PUBLIC_EXE).mtimeMs;
    if (age < MINER_BUILD_COOLDOWN_MS) return MINER_PUBLIC_EXE;
  }
  const script = path.join(PROJECT_ROOT, 'scripts', 'build-miner-win-embed.js');
  if (!fs.existsSync(script)) throw new Error(`Missing scripts/build-miner-win-embed.js in ${PROJECT_ROOT}`);
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
    throw new Error(`pkg build failed. Run: cd ${PROJECT_ROOT} && npm install. Log: ${tail}`);
  }
  if (!fs.existsSync(MINER_PUBLIC_EXE)) throw new Error(`File not created: ${MINER_PUBLIC_EXE}`);
  return MINER_PUBLIC_EXE;
}

const TG_DOC_LIMIT = 48 * 1024 * 1024;

function minerDownloadUrl() {
  const base = (process.env.QTR_PUBLIC_URL || PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) return '';
  return `${base}/download/qtr-pool-miner.exe`;
}

/** @returns {Promise<{ sent: boolean }>} */
async function sendMinerDocument(chatId, lang = 'ru') {
  const exePath = getOrBuildMinerExe();
  const st = fs.statSync(exePath);
  const sizeMb = (st.size / 1024 / 1024).toFixed(1);
  log.info(`Sending miner exe to chatId=${chatId}: ${exePath} (${sizeMb} MB)`);

  if (st.size > TG_DOC_LIMIT) {
    const url = minerDownloadUrl();
    log.warn(`Exe too large (${sizeMb} MB > ${TG_DOC_LIMIT / 1024 / 1024} MB limit). Sending download link.`);
    await bot.sendMessage(chatId, url
      ? tBot('miner.too_large', lang, { sizeMb, url })
      : tBot('miner.too_large_no_url', lang, { sizeMb }));
    return { sent: false };
  }

  const docOpts = {
    caption: tBot('miner.caption', lang, { sizeMb }),
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

  const url = minerDownloadUrl();
  log.error(`All sendDocument attempts failed for chatId=${chatId}. Last error: ${lastErr?.message || lastErr}`);
  await bot.sendMessage(chatId, tBot('miner.send_failed', lang, {
    sizeMb,
    error: lastErr?.message || lastErr,
    url: url || ''
  }));
  return { sent: false };
}

// ─── Translations ─────────────────────────────────────────────────────────────
const T = {
  // ── Onboarding ──────────────────────────────────────────────────────────────
  'lang.choose': {
    ru: '🌍 Выбери язык / Choose language:',
    en: '🌍 Выбери язык / Choose language:'
  },
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
    ru: '👋 *С возвращением!*\n\n◆ *Qatrol Coin (QTR)*\n\nТвой кошелёк: `{address}`\n\nИспользуй кнопки меню ниже 👇',
    en: '👋 *Welcome back!*\n\n◆ *Qatrol Coin (QTR)*\n\nYour wallet: `{address}`\n\nUse the menu buttons below 👇'
  },

  // ── Wallet ───────────────────────────────────────────────────────────────────
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
  'wallet.ask_password_new': {
    ru: '🔐 Придумай пароль для кошелька (минимум 6 символов):\n\n⚠️ Пароль нельзя восстановить — запомни его!',
    en: '🔐 Create a wallet password (minimum 6 characters):\n\n⚠️ The password cannot be recovered — remember it!'
  },
  'wallet.password_too_short': {
    ru: '❌ Минимум 6 символов, попробуй ещё:',
    en: '❌ Minimum 6 characters, try again:'
  },
  'wallet.creating': {
    ru: '⏳ Создаю кошелёк...',
    en: '⏳ Creating wallet...'
  },
  'wallet.ask_address': {
    ru: '📝 Введи адрес своего кошелька (начинается с K):',
    en: '📝 Enter your wallet address (starts with K):'
  },
  'wallet.invalid_address': {
    ru: '❌ Неверный адрес, попробуй ещё:',
    en: '❌ Invalid address, try again:'
  },
  'wallet.ask_password_login': {
    ru: '🔐 Введи пароль:',
    en: '🔐 Enter your password:'
  },
  'wallet.login_success': {
    ru: '✅ *Вход выполнен!*\n\nКошелёк: `{address}`',
    en: '✅ *Logged in!*\n\nWallet: `{address}`'
  },
  'wallet.error': {
    ru: '❌ Ошибка: {error}',
    en: '❌ Error: {error}'
  },

  // ── Balance ──────────────────────────────────────────────────────────────────
  'balance.title': {
    ru: '💰 *Баланс кошелька*\n\n📍 `{address}`\n\nДоступно:    *{available} QTR*\nВ обработке: {pendingOut} QTR\nВсего:       {balance} QTR',
    en: '💰 *Wallet Balance*\n\n📍 `{address}`\n\nAvailable:  *{available} QTR*\nPending:    {pendingOut} QTR\nTotal:      {balance} QTR'
  },

  // ── Network stats ─────────────────────────────────────────────────────────────
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
  'stats.valid':   { ru: 'валидна',     en: 'is valid'  },
  'stats.invalid': { ru: '❌ НАРУШЕНА', en: '❌ INVALID' },
  'stats.node_unavailable': { ru: '❌ Нода недоступна', en: '❌ Node unavailable' },

  // ── Pool stats ────────────────────────────────────────────────────────────────
  'pool.title': {
    ru: '🏊 *Статистика пула*',
    en: '🏊 *Pool Stats*'
  },
  'pool.active_workers': { ru: 'Активных воркеров: *{n}*', en: 'Active workers: *{n}*' },
  'pool.total_workers':  { ru: 'Всего воркеров: {n}',      en: 'Total workers: {n}'    },
  'pool.total_shares':   { ru: 'Всего shares: {n}',        en: 'Total shares: {n}'     },
  'pool.share_diff':     { ru: 'Сложность share: {n}',     en: 'Share difficulty: {n}' },
  'pool.my_stats':       { ru: '👤 Ты: {shares} shares • {hashrate}',       en: '👤 You: {shares} shares • {hashrate}'     },
  'pool.my_not_found':   { ru: '👤 Твой адрес не найден в активных воркерах', en: '👤 Your address not found in active workers' },
  'pool.top_workers':    { ru: '🏅 Топ воркеров:',    en: '🏅 Top workers:'   },
  'pool.no_data':        { ru: 'Пока нет данных по воркерам', en: 'No worker data yet' },
  'pool.unavailable':    { ru: '❌ Пул недоступен',    en: '❌ Pool unavailable' },

  // ── Top miners ────────────────────────────────────────────────────────────────
  'top.title':       { ru: '🏆 *Топ майнеров QTR*',  en: '🏆 *Top QTR Miners*'   },
  'top.total':       { ru: 'Всего воркеров: {w}  |  Шар: {s}', en: 'Total workers: {w}  |  Shares: {s}' },
  'top.share_unit':  { ru: 'шар',   en: 'shares' },
  'top.no_miners':   { ru: 'Пока нет активных майнеров.', en: 'No active miners yet.' },
  'top.unavailable': { ru: '❌ Пул недоступен или данных нет', en: '❌ Pool unavailable or no data' },
  'top.active':      { ru: 'активен', en: 'active' },

  // ── Send ──────────────────────────────────────────────────────────────────────
  'send.ask_address': {
    ru: '📤 *Отправить QTR*\n\nВведи адрес получателя (начинается с K):',
    en: '📤 *Send QTR*\n\nEnter recipient address (starts with K):'
  },
  'send.invalid_address': { ru: '❌ Неверный адрес (должен начинаться с K):', en: '❌ Invalid address (must start with K):' },
  'send.ask_amount': {
    ru: '📍 Получатель: `{to}`\n\nВведи сумму в QTR:',
    en: '📍 Recipient: `{to}`\n\nEnter amount in QTR:'
  },
  'send.invalid_amount': { ru: '❌ Неверная сумма:', en: '❌ Invalid amount:' },
  'send.ask_password': {
    ru: '💰 Сумма: *{amount} QTR*\n\nВведи пароль для подписи:',
    en: '💰 Amount: *{amount} QTR*\n\nEnter password to sign:'
  },
  'send.confirm': {
    ru: '📋 *Подтвердить транзакцию:*\n\nКому: `{to}`\nСумма: *{amount} QTR*\nКомиссия: {fee} QTR\nИтого: {total} QTR',
    en: '📋 *Confirm transaction:*\n\nTo: `{to}`\nAmount: *{amount} QTR*\nFee: {fee} QTR\nTotal: {total} QTR'
  },
  'send.btn_confirm': { ru: '✅ Подтвердить', en: '✅ Confirm' },
  'send.btn_cancel':  { ru: '❌ Отмена',      en: '❌ Cancel'  },
  'send.success': {
    ru: '✅ *Транзакция отправлена!*\n\nКому: `{to}`\nСумма: *{amount} QTR*\nКомиссия: {fee} QTR\nID: `{txId}`\n\n⏳ Ожидает подтверждения майнером',
    en: '✅ *Transaction sent!*\n\nTo: `{to}`\nAmount: *{amount} QTR*\nFee: {fee} QTR\nID: `{txId}`\n\n⏳ Awaiting miner confirmation'
  },
  'send.cancelled': { ru: '❌ Отменено', en: '❌ Cancelled' },

  // ── History ───────────────────────────────────────────────────────────────────
  'history.title':   { ru: '📜 *Последние транзакции:*', en: '📜 *Recent transactions:*' },
  'history.empty':   { ru: '📜 *История транзакций*\n\nПока нет транзакций', en: '📜 *Transaction history*\n\nNo transactions yet' },
  'history.mining':  { ru: '⛏ Майнинг', en: '⛏ Mining' },

  // ── Settings ──────────────────────────────────────────────────────────────────
  'settings.title': {
    ru: '⚙️ *Настройки*\n\n📍 Адрес: `{address}`\n',
    en: '⚙️ *Settings*\n\n📍 Address: `{address}`\n'
  },
  'settings.notif_on':  { ru: '🔔 Уведомления: ВКЛ',  en: '🔔 Notifications: ON'  },
  'settings.notif_off': { ru: '🔕 Уведомления: ВЫКЛ', en: '🔕 Notifications: OFF' },
  'settings.my_addr':   { ru: '📍 Мой адрес + QR',     en: '📍 My address + QR'    },
  'settings.ref':       { ru: '🎁 Реферальная ссылка', en: '🎁 Referral link'      },
  'settings.open_site': { ru: '🌐 Открыть сайт',       en: '🌐 Open website'       },
  'settings.logout':    { ru: '🚪 Выйти из кошелька',  en: '🚪 Logout'             },
  'settings.switch_to_en': { ru: '🇬🇧 Switch to English',      en: '🇬🇧 Switch to English'      },
  'settings.switch_to_ru': { ru: '🇷🇺 Переключить на русский', en: '🇷🇺 Switch to Russian'       },

  // ── Notifications ─────────────────────────────────────────────────────────────
  'notif.toggled_on': {
    ru: '🔔 *Уведомления включены!*\n\nТы будешь получать уведомление каждый раз, когда твой майнер найдёт блок.',
    en: '🔔 *Notifications enabled!*\n\nYou will receive a notification each time your miner finds a block.'
  },
  'notif.toggled_off': {
    ru: '🔕 Уведомления отключены.',
    en: '🔕 Notifications disabled.'
  },

  // ── Language switch ───────────────────────────────────────────────────────────
  'lang.switched_ru': { ru: '🇷🇺 Язык изменён на русский', en: '🇷🇺 Language changed to Russian' },
  'lang.switched_en': { ru: '🇬🇧 Language switched to English', en: '🇬🇧 Language switched to English' },

  // ── Mining ────────────────────────────────────────────────────────────────────
  'mining.title': {
    ru: [
      '⛏ *Майнинг Qatrol Coin*',
      '',
      'Майни в пуле — получай *16.7 QTR* за каждый блок.',
      'Пул уже вшит в майнер, просто запусти и укажи свой адрес.',
      '',
      '📍 Твой адрес: {address}',
      '',
      '📥 Скачай майнер по кнопке ниже — это Windows .exe, никаких настроек.'
    ].join('\n'),
    en: [
      '⛏ *Qatrol Coin Mining*',
      '',
      'Mine in the pool — earn *16.7 QTR* per block.',
      'Pool is pre-configured in the miner, just run it and enter your address.',
      '',
      '📍 Your address: {address}',
      '',
      '📥 Download the miner below — Windows .exe, no setup needed.'
    ].join('\n')
  },
  'mining.no_address': { ru: '_(создай или войди в кошелёк)_', en: '_(create or login to wallet)_' },
  'mining.btn_download': { ru: '📥 Скачать майнер (.exe)', en: '📥 Download miner (.exe)' },
  'mining.btn_wallet': { ru: '🌐 Веб-кошелёк', en: '🌐 Web wallet' },

  // ── Miner file send ───────────────────────────────────────────────────────────
  'miner.building': { ru: '⏳ Собираю Windows-майнер (1–3 мин). Не закрывай чат…', en: '⏳ Building Windows miner (1–3 min). Keep the chat open…' },
  'miner.sent_ok':  { ru: '✅ Файл отправлен.', en: '✅ File sent.' },
  'miner.caption':  { ru: '⛏ Qatrol Coin пул-майнер v1.0 ({sizeMb} MB)\nЗапуск: введи адрес K… Пул уже зашит внутрь.', en: '⛏ Qatrol Coin pool miner v1.0 ({sizeMb} MB)\nRun it and enter your K… address. Pool is pre-configured.' },
  'miner.too_large': { ru: '📦 Файл слишком большой для Telegram ({sizeMb} MB). Скачай напрямую:\n{url}', en: '📦 File too large for Telegram ({sizeMb} MB). Download directly:\n{url}' },
  'miner.too_large_no_url': { ru: '📦 Файл слишком большой ({sizeMb} MB). Задай QTR_PUBLIC_URL в .env для ссылки на скачивание.', en: '📦 File too large ({sizeMb} MB). Set QTR_PUBLIC_URL in .env to provide a download link.' },
  'miner.send_failed': { ru: '❌ Не удалось отправить файл через Telegram ({sizeMb} MB).\nПричина: {error}{urlLine}', en: '❌ Failed to send file via Telegram ({sizeMb} MB).\nReason: {error}{urlLine}' },

  // ── Price ─────────────────────────────────────────────────────────────────────
  'price.title': {
    ru: [
      '📈 *Qatrol Coin (QTR) — Курс*',
      '',
      'На данный момент QTR не торгуется на биржах.',
      '',
      '🚀 Листинг на бирже запланирован — следи за новостями в канале.',
      '',
      '📊 Текущая ценность определяется сообществом.',
      'Чем больше майнеров — тем ценнее монета.',
      '',
      '🔔 Включи уведомления в ⚙️ *Настройки*, чтобы не пропустить листинг.'
    ].join('\n'),
    en: [
      '📈 *Qatrol Coin (QTR) — Price*',
      '',
      'QTR is not yet listed on any exchange.',
      '',
      '🚀 Exchange listing is planned — follow the channel for news.',
      '',
      '📊 Current value is determined by the community.',
      'More miners = more valuable coin.',
      '',
      '🔔 Enable notifications in ⚙️ *Settings* to be the first to know.'
    ].join('\n')
  },
  'price.btn_notif': { ru: '🔔 Включить уведомления', en: '🔔 Enable notifications' },

  // ── Referral ──────────────────────────────────────────────────────────────────
  'ref.title': {
    ru: [
      '🎁 *Реферальная программа*',
      '',
      'Поделись ссылкой — когда по ней зарегистрируются, ты увидишь уведомление.',
      '',
      '👥 Твоих рефералов: *{count}*',
      '',
      '🔗 Твоя ссылка:',
      '`{link}`'
    ].join('\n'),
    en: [
      '🎁 *Referral Program*',
      '',
      'Share your link — you\'ll be notified when someone registers through it.',
      '',
      '👥 Your referrals: *{count}*',
      '',
      '🔗 Your link:',
      '`{link}`'
    ].join('\n')
  },
  'ref.btn_share': { ru: '📤 Поделиться ссылкой', en: '📤 Share link' },
  'ref.not_configured': { ru: '(бот не настроен)', en: '(bot not configured)' },
  'ref.share_text': { ru: 'Попробуй Qatrol Coin — бесплатный майнинг прямо с ПК!', en: 'Try Qatrol Coin — free mining right from your PC!' },
  'ref.new_referral': { ru: '🎁 *Новый реферал!*\n\nПо твоей ссылке зарегистрировался новый пользователь.\nВсего рефералов: *{count}*', en: '🎁 *New referral!*\n\nA new user registered via your link.\nTotal referrals: *{count}*' },

  // ── Channel ───────────────────────────────────────────────────────────────────
  'channel.text': {
    ru: [
      '📢 *Qatrol Coin — официальный канал*',
      '',
      'Там публикуем:',
      '• новости о проекте',
      '• обновления и релизы майнера',
      '• анонсы листинга',
      '• статистику сети',
      '',
      'Подписывайся чтобы не пропустить!'
    ].join('\n'),
    en: [
      '📢 *Qatrol Coin — Official Channel*',
      '',
      'We post:',
      '• project news',
      '• miner updates and releases',
      '• listing announcements',
      '• network stats',
      '',
      'Subscribe so you don\'t miss anything!'
    ].join('\n')
  },
  'channel.btn_open':    { ru: '📢 Открыть канал',    en: '📢 Open channel'   },
  'channel.btn_site':    { ru: '🌐 Сайт проекта',     en: '🌐 Project website' },
  'channel.coming_soon': { ru: 'Канал скоро появится! Следи за обновлениями.', en: 'Channel coming soon! Stay tuned.' },

  // ── Contest ───────────────────────────────────────────────────────────────────
  'contest.none': {
    ru: '🏆 *Конкурс Qatrol Coin*\n\nСейчас активных конкурсов нет.\n\nСледи за новостями — скоро будет!',
    en: '🏆 *Qatrol Coin Contest*\n\nNo active contests right now.\n\nStay tuned — one is coming soon!'
  },
  'contest.active': {
    ru: [
      '🏆 *Конкурс Qatrol Coin*',
      '',
      '🎁 Приз: *{prize} QTR*',
      '📅 До: *{endDate}*',
      '',
      '📋 Правила:',
      '• Отправь QTR на конкурсный адрес',
      '• Каждый QTR = 1 лотерейный билет',
      '• Чем больше отправишь — тем выше шанс',
      '• Победитель выбирается случайно',
      '• Приз приходит прямо на кошелёк',
      '',
      '📍 Конкурсный адрес:',
      '`{address}`',
      '',
      '👥 Участников: *{count}*  |  Всего QTR: *{total}*',
    ].join('\n'),
    en: [
      '🏆 *Qatrol Coin Contest*',
      '',
      '🎁 Prize: *{prize} QTR*',
      '📅 Until: *{endDate}*',
      '',
      '📋 Rules:',
      '• Send QTR to the contest address',
      '• Each QTR = 1 lottery ticket',
      '• More you send — higher the chance',
      '• Winner is chosen randomly',
      '• Prize goes directly to your wallet',
      '',
      '📍 Contest address:',
      '`{address}`',
      '',
      '👥 Participants: *{count}*  |  Total QTR: *{total}*',
    ].join('\n')
  },
  'contest.my_tickets': { ru: '\n👤 Твои билеты: *{total} QTR* (шанс ~{chance}%)', en: '\n👤 Your tickets: *{total} QTR* (~{chance}% chance)' },
  'contest.no_tickets': { ru: '\n👤 Ты ещё не участвуешь — отправь QTR на адрес выше!', en: '\n👤 You\'re not participating yet — send QTR to the address above!' },
  'contest.btn_join': { ru: '📤 Участвовать (Отправить QTR)', en: '📤 Join (Send QTR)' },
  'contest.join_prompt': {
    ru: '📤 *Участие в конкурсе*\n\nКонкурсный адрес уже заполнен.\nВведи сумму QTR для участия (минимум {min} QTR):\n\n💡 Каждый QTR = 1 билет. Больше = выше шанс!',
    en: '📤 *Join Contest*\n\nContest address is pre-filled.\nEnter the amount of QTR to participate (minimum {min} QTR):\n\n💡 Each QTR = 1 ticket. More = higher chance!'
  },
  'contest.not_active': { ru: '❌ Конкурс не активен', en: '❌ Contest not active' },
  'contest.need_wallet': { ru: '❌ Сначала создай кошелёк. /start', en: '❌ Create a wallet first. /start' },

  // ── Notifications: new block ──────────────────────────────────────────────────
  'block.found_by_me': {
    ru: '🎯 *Ты нашёл блок!*\n\nБлок #{index}\nНаграда: *16.7 QTR* зачислена на твой кошелёк!',
    en: '🎯 *You found a block!*\n\nBlock #{index}\nReward: *16.7 QTR* credited to your wallet!'
  },
  'block.found_other': {
    ru: '🧱 *Новый блок #{index}*\n\nМайнер: `{miner}`\nТранзакций: {txCount}',
    en: '🧱 *New block #{index}*\n\nMiner: `{miner}`\nTransactions: {txCount}'
  },

  // ── Address / QR ─────────────────────────────────────────────────────────────
  'address.caption': { ru: '📍 *Твой адрес QTR:*\n`{address}`\n\nОтправь его другому пользователю, чтобы получить монеты.', en: '📍 *Your QTR address:*\n`{address}`\n\nShare it with others to receive coins.' },
  'address.text':    { ru: '📍 *Твой адрес:*\n`{address}`', en: '📍 *Your address:*\n`{address}`' },
  'address.qr_caption': { ru: '📍 *Твой адрес QTR:*\n`{address}`', en: '📍 *Your QTR address:*\n`{address}`' },

  // ── Generic errors / auth guards ─────────────────────────────────────────────
  'err.login_first':  { ru: '❌ Сначала войди или создай кошелёк. /start', en: '❌ Please login or create a wallet first. /start' },
  'err.login_only':   { ru: '❌ Сначала войди. /start', en: '❌ Login first. /start' },
  'err.no_access':    { ru: '❌ Нет доступа', en: '❌ Access denied' },
  'err.not_found':    { ru: '❌ Ничего не найдено или нода недоступна', en: '❌ Not found or node unavailable' },
  'err.no_site':      { ru: '⚙️ Сайт не настроен. Администратор должен задать QTR_PUBLIC_URL в .env', en: '⚙️ Website not configured. Admin must set QTR_PUBLIC_URL in .env' },

  // ── Logout ────────────────────────────────────────────────────────────────────
  'logout.done': { ru: '👋 Выход выполнен. /start чтобы войти снова.', en: '👋 Logged out. /start to login again.' },

  // ── Help ──────────────────────────────────────────────────────────────────────
  'help.text': {
    ru: [
      '◆ *Qatrol Coin (QTR)* — криптовалюта нового поколения',
      '',
      'QTR создана с одной целью: сделать крипту *простой и доступной каждому*.',
      '',
      '⛏ *Майнинг:* 16.7 QTR за каждый блок',
      '🔒 *Фиксированная эмиссия:* 1,000,000,000 QTR навсегда',
      '💸 *Переводы:* мгновенно, комиссия 0.1%',
      '🌐 *Открытый блокчейн:* каждый может проверить любую транзакцию',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '*Команды:*',
      '/start — главное меню',
      '/address — твой адрес + QR',
      '/miner — скачать майнер',
      '/stats — статистика сети',
      '/pool — статистика пула',
      '/top — топ майнеров',
      '/ref — реферальная ссылка',
      '/notify — вкл/выкл уведомления о блоках',
      '/block <index|hash> — информация о блоке',
      '/tx <id> — транзакция',
      '/search <q> — поиск',
      '/logout — сменить кошелёк'
    ].join('\n'),
    en: [
      '◆ *Qatrol Coin (QTR)* — next-generation cryptocurrency',
      '',
      'QTR was built for one purpose: make crypto *simple and accessible for everyone*.',
      '',
      '⛏ *Mining:* 16.7 QTR per block',
      '🔒 *Fixed supply:* 1,000,000,000 QTR forever',
      '💸 *Transfers:* instant, 0.1% fee',
      '🌐 *Open blockchain:* anyone can verify any transaction',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '*Commands:*',
      '/start — main menu',
      '/address — your address + QR',
      '/miner — download miner',
      '/stats — network stats',
      '/pool — pool stats',
      '/top — top miners',
      '/ref — referral link',
      '/notify — toggle block notifications',
      '/block <index|hash> — block info',
      '/tx <id> — transaction info',
      '/search <q> — search',
      '/logout — switch wallet'
    ].join('\n')
  },

  // ── Block / TX info ───────────────────────────────────────────────────────────
  'block.info': {
    ru: '🧱 *Блок #{index}*\nHash: `{hash}`\nТранзакций: {txCount}\nПодтверждений: {confirmations}',
    en: '🧱 *Block #{index}*\nHash: `{hash}`\nTransactions: {txCount}\nConfirmations: {confirmations}'
  },
  'block.not_found': { ru: '❌ Блок не найден', en: '❌ Block not found' },
  'tx.info': {
    ru: '💸 *Транзакция*\nID: `{id}`\n{from} → {to}\nСумма: {amount} QTR\nFee: {fee} QTR\nСтатус: {status}',
    en: '💸 *Transaction*\nID: `{id}`\n{from} → {to}\nAmount: {amount} QTR\nFee: {fee} QTR\nStatus: {status}'
  },
  'tx.not_found': { ru: '❌ Транзакция не найдена', en: '❌ Transaction not found' },
  'tx.status_confirmed': { ru: '✅ confirmed', en: '✅ confirmed' },
  'tx.status_pending':   { ru: '⏳ pending',    en: '⏳ pending'    },

  // ── Search ────────────────────────────────────────────────────────────────────
  'search.ask': { ru: '🔎 Введи запрос: hash блока / index / tx id / адрес K...', en: '🔎 Enter query: block hash / index / tx id / K... address' },
  'search.found': { ru: 'ℹ️ Найдено, но формат не распознан', en: 'ℹ️ Found but format not recognized' },
  'search.not_found': { ru: '❌ Ничего не найдено', en: '❌ Nothing found' },

  // ── Mempool ───────────────────────────────────────────────────────────────────
  'mempool.info': { ru: '📦 Mempool: {count} tx, fees {fees} QTR', en: '📦 Mempool: {count} tx, fees {fees} QTR' },
  'mempool.unavailable': { ru: '❌ Нода недоступна', en: '❌ Node unavailable' },

  // ── Buttons at start screen ───────────────────────────────────────────────────
  'btn.create_wallet': { ru: '🆕 Создать кошелёк',    en: '🆕 Create Wallet'   },
  'btn.login_wallet':  { ru: '🔑 Войти (есть аккаунт)', en: '🔑 Login (have account)' },
  'btn.open_site':     { ru: '🌐 Открыть сайт',        en: '🌐 Open website'   },
  'btn.tg_channel':    { ru: '📢 Наш Telegram-канал',  en: '📢 Our Telegram channel' },

  // ── Main menu button labels ───────────────────────────────────────────────────
  'menu.balance':     { ru: '💰 Баланс',      en: '💰 Balance'    },
  'menu.send':        { ru: '📤 Отправить',   en: '📤 Send'       },
  'menu.mining':      { ru: '⛏ Майнинг',     en: '⛏ Mining'     },
  'menu.top_miners':  { ru: '🏆 Топ майнеров', en: '🏆 Top Miners' },
  'menu.stats':       { ru: '📊 Статистика',  en: '📊 Stats'      },
  'menu.pool':        { ru: '🏊 Пул',         en: '🏊 Pool'       },
  'menu.price':       { ru: '📈 Курс',        en: '📈 Price'      },
  'menu.referral':    { ru: '🎁 Реферал',     en: '🎁 Referral'   },
  'menu.history':     { ru: '📜 История',     en: '📜 History'    },
  'menu.settings':    { ru: '⚙️ Настройки',   en: '⚙️ Settings'   },
  'menu.channel':     { ru: '📢 Наш канал',   en: '📢 Channel'    },
  'menu.contest':     { ru: '🏆 Конкурс',     en: '🏆 Contest'    },
};

/**
 * Returns translated string with variable substitution.
 */
function tBot(key, lang, vars = {}) {
  const entry = T[key];
  if (!entry) return key;
  let str = entry[lang] || entry['ru'] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return str;
}

// ─── Users storage ────────────────────────────────────────────────────────────
const USERS_FILE = path.join(PROJECT_ROOT, 'bot_users.json');

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

function getUser(chatId) { return loadUsers()[String(chatId)]; }

function setUser(chatId, data) {
  const users = loadUsers();
  const existing = users[String(chatId)] || {};
  users[String(chatId)] = { ...existing, ...data };
  saveUsers(users);
}

function getUserLang(chatId) {
  const u = getUser(chatId);
  return (u && u.lang) || null; // null = language not chosen yet
}

// ─── Dynamic main menu ────────────────────────────────────────────────────────
function getMainMenu(lang) {
  return {
    reply_markup: {
      keyboard: [
        [tBot('menu.balance', lang),    tBot('menu.send', lang)      ],
        [tBot('menu.mining', lang),     tBot('menu.top_miners', lang) ],
        [tBot('menu.stats', lang),      tBot('menu.pool', lang)       ],
        [tBot('menu.price', lang),      tBot('menu.referral', lang)   ],
        [tBot('menu.history', lang),    tBot('menu.settings', lang)   ],
        [tBot('menu.channel', lang),    tBot('menu.contest', lang)    ],
      ],
      resize_keyboard: true
    }
  };
}

/** Check if a text message matches a menu button (either lang) */
function isMenu(text, key) {
  return text === tBot(key, 'ru') || text === tBot(key, 'en');
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
async function broadcastAll(text, options = {}, excludeId = null) {
  const users = loadUsers();
  let sent = 0, failed = 0, skipped = 0;
  for (const [cid, u] of Object.entries(users)) {
    if (!u.address) { skipped++; continue; }
    if (excludeId && String(cid) === String(excludeId)) continue;
    try {
      await bot.sendMessage(Number(cid), text, options);
      sent++;
      await sleep(65);
    } catch { failed++; }
  }
  return { sent, failed, skipped };
}

// ─── Contest entries ──────────────────────────────────────────────────────────
async function getContestEntries(contestAddress) {
  const res = await apiRequest('/history/' + contestAddress + '?limit=1000');
  if (res.error || !res.history) return [];
  const users = loadUsers();
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function short(addr, n = 8) {
  if (!addr) return '—';
  return addr.slice(0, n) + '...' + addr.slice(-n);
}

function timeAgo(ts, lang = 'ru') {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (lang === 'en') {
    if (s < 60)   return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  if (s < 60)   return s + 'с назад';
  if (s < 3600) return Math.floor(s / 60) + 'м назад';
  return Math.floor(s / 3600) + 'ч назад';
}

function fmtHashrate(h = 0) {
  if (h >= 1_000_000) return (h / 1_000_000).toFixed(2) + ' MH/s';
  if (h >= 1_000) return (h / 1_000).toFixed(1) + ' kH/s';
  return h + ' H/s';
}

// ─── Shared send functions ────────────────────────────────────────────────────
async function sendNetworkStats(chatId) {
  const res = await apiRequest('/stats');
  const lang = getUserLang(chatId) || 'ru';
  if (res.error) {
    bot.sendMessage(chatId, tBot('stats.node_unavailable', lang));
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
    { parse_mode: 'Markdown', ...getMainMenu(lang) }
  );
}

async function sendPoolStats(chatId, address = null) {
  const lang = getUserLang(chatId) || 'ru';
  const res = await poolRequest('/pool/stats');
  if (res.error) {
    log.warn(`Pool stats unavailable for chatId=${chatId}: ${res.error}`);
    bot.sendMessage(chatId, tBot('pool.unavailable', lang));
    return;
  }
  const workers = res.workers || [];
  const top = workers
    .sort((a, b) => (b.shares || 0) - (a.shares || 0))
    .slice(0, 5)
    .map((w, i) => `${i + 1}) \`${short(w.address, 6)}\` • ${w.shares} shares • ${fmtHashrate(w.hashrate || 0)}`);
  const me = address ? workers.find(w => w.address === address) : null;
  const lines = [
    tBot('pool.title', lang),
    '',
    tBot('pool.active_workers', lang, { n: res.activeWorkers || 0 }),
    tBot('pool.total_workers',  lang, { n: res.totalWorkers  || 0 }),
    tBot('pool.total_shares',   lang, { n: res.totalShares   || 0 }),
    tBot('pool.share_diff',     lang, { n: res.shareDifficulty }),
    '',
    me
      ? tBot('pool.my_stats', lang, { shares: me.shares, hashrate: fmtHashrate(me.hashrate || 0) })
      : tBot('pool.my_not_found', lang),
    '',
    top.length
      ? tBot('pool.top_workers', lang) + '\n' + top.join('\n')
      : tBot('pool.no_data', lang)
  ];
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown', ...getMainMenu(lang) });
}

async function sendTopMiners(chatId) {
  const lang = getUserLang(chatId) || 'ru';
  const res = await poolRequest('/pool/leaderboard');
  if (res.error || !res.leaderboard) {
    bot.sendMessage(chatId, tBot('top.unavailable', lang));
    return;
  }
  const lb = res.leaderboard.slice(0, 10);
  if (!lb.length) {
    bot.sendMessage(chatId,
      tBot('top.title', lang) + '\n\n' + tBot('top.no_miners', lang),
      { parse_mode: 'Markdown', ...getMainMenu(lang) }
    );
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const shareUnit = tBot('top.share_unit', lang);
  const rows = lb.map((w, i) => {
    const icon = medals[i] || `${i + 1}.`;
    const active = w.active ? '🟢' : '⚫';
    return `${icon} ${active} \`${short(w.address, 6)}\`  ${w.shares} ${shareUnit}  ${fmtHashrate(w.hashrate)}  ${w.percent}%`;
  });
  bot.sendMessage(chatId, [
    tBot('top.title', lang),
    '',
    tBot('top.total', lang, { w: res.totalWorkers, s: res.totalShares }),
    '',
    rows.join('\n')
  ].join('\n'), { parse_mode: 'Markdown', ...getMainMenu(lang) });
}

async function sendRefInfo(chatId, user) {
  const lang = getUserLang(chatId) || 'ru';
  const botInfo = await bot.getMe().catch(() => null);
  const botUsername = botInfo?.username || '';
  const refs = user?.referrals || [];
  const link = botUsername
    ? `https://t.me/${botUsername}?start=ref_${chatId}`
    : tBot('ref.not_configured', lang);
  bot.sendMessage(chatId,
    tBot('ref.title', lang, { count: refs.length, link }),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: botUsername
          ? [[{ text: tBot('ref.btn_share', lang), url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(tBot('ref.share_text', lang))}` }]]
          : []
      }
    }
  );
}

// ─── Language selection keyboard ──────────────────────────────────────────────
const LANG_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🇷🇺 Русский', callback_data: 'set_lang_ru' },
        { text: '🇬🇧 English', callback_data: 'set_lang_en' }
      ]
    ]
  }
};

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param  = (match?.[1] || '').trim();
  const user   = getUser(chatId);

  // Handle referral link
  if (param.startsWith('ref_')) {
    const refId = param.replace('ref_', '');
    if (refId && String(refId) !== String(chatId) && !user?.referredBy) {
      setUser(chatId, { referredBy: refId });
      const refUser = getUser(refId);
      if (refUser) {
        const refs = refUser.referrals || [];
        if (!refs.includes(String(chatId))) {
          refs.push(String(chatId));
          setUser(refId, { referrals: refs });
          const refLang = getUserLang(refId) || 'ru';
          bot.sendMessage(refId,
            tBot('ref.new_referral', refLang, { count: refs.length }),
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }
    }
  }

  const lang = getUserLang(chatId);

  // New user — ask language first
  if (!lang) {
    setUser(chatId, { state: 'awaiting_lang' });
    await bot.sendMessage(chatId, tBot('lang.choose', 'ru'), LANG_KEYBOARD);
    return;
  }

  // Returning user with wallet
  if (user?.address) {
    bot.sendMessage(chatId,
      tBot('start.returning', lang, { address: user.address }),
      { parse_mode: 'Markdown', ...getMainMenu(lang) }
    );
    return;
  }

  // Known lang, no wallet yet
  const welcomeKb = [
    [{ text: tBot('btn.create_wallet', lang), callback_data: 'create_wallet' }],
    [{ text: tBot('btn.login_wallet',  lang), callback_data: 'login_wallet'  }]
  ];
  if (PUBLIC_URL)  welcomeKb.push([{ text: tBot('btn.open_site',  lang), url: PUBLIC_URL  }]);
  if (CHANNEL_URL) welcomeKb.push([{ text: tBot('btn.tg_channel', lang), url: CHANNEL_URL }]);

  bot.sendMessage(chatId, tBot('start.welcome', lang), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: welcomeKb }
  });
});

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const data   = q.data;
  const lang   = getUserLang(chatId) || 'ru';

  if (data === 'miner_download') {
    await bot.answerCallbackQuery(q.id, { text: lang === 'en' ? 'Building .exe…' : 'Готовлю .exe…' });
  } else {
    bot.answerCallbackQuery(q.id);
  }

  // ── Language selection ───────────────────────────────────────────────────────
  if (data === 'set_lang_en') {
    setUser(chatId, { lang: 'en', state: null });
    const u = getUser(chatId);
    await bot.sendMessage(chatId, tBot('lang.switched_en', 'en'), getMainMenu('en'));
    // If user was in onboarding, show welcome
    if (!u?.address) {
      const welcomeKb = [
        [{ text: tBot('btn.create_wallet', 'en'), callback_data: 'create_wallet' }],
        [{ text: tBot('btn.login_wallet',  'en'), callback_data: 'login_wallet'  }]
      ];
      if (PUBLIC_URL)  welcomeKb.push([{ text: tBot('btn.open_site',  'en'), url: PUBLIC_URL  }]);
      if (CHANNEL_URL) welcomeKb.push([{ text: tBot('btn.tg_channel', 'en'), url: CHANNEL_URL }]);
      bot.sendMessage(chatId, tBot('start.welcome', 'en'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: welcomeKb }
      });
    }
    return;
  }

  if (data === 'set_lang_ru') {
    setUser(chatId, { lang: 'ru', state: null });
    const u = getUser(chatId);
    await bot.sendMessage(chatId, tBot('lang.switched_ru', 'ru'), getMainMenu('ru'));
    if (!u?.address) {
      const welcomeKb = [
        [{ text: tBot('btn.create_wallet', 'ru'), callback_data: 'create_wallet' }],
        [{ text: tBot('btn.login_wallet',  'ru'), callback_data: 'login_wallet'  }]
      ];
      if (PUBLIC_URL)  welcomeKb.push([{ text: tBot('btn.open_site',  'ru'), url: PUBLIC_URL  }]);
      if (CHANNEL_URL) welcomeKb.push([{ text: tBot('btn.tg_channel', 'ru'), url: CHANNEL_URL }]);
      bot.sendMessage(chatId, tBot('start.welcome', 'ru'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: welcomeKb }
      });
    }
    return;
  }

  // ── Create / Login wallet ────────────────────────────────────────────────────
  if (data === 'create_wallet') {
    bot.sendMessage(chatId, tBot('wallet.ask_password_new', lang));
    setUser(chatId, { state: 'awaiting_new_password' });
    return;
  }

  if (data === 'login_wallet') {
    bot.sendMessage(chatId, tBot('wallet.ask_address', lang));
    setUser(chatId, { state: 'awaiting_login_address' });
    return;
  }

  // ── Confirm / cancel send ────────────────────────────────────────────────────
  if (data === 'confirm_send') {
    const user = getUser(chatId);
    if (!user?.pendingSend) return;
    const { to, amount, password } = user.pendingSend;
    const res = await apiRequest('/send', 'POST', { to, amount: parseFloat(amount), password }, user.token);
    if (res.error) {
      log.error(`Send TX failed: chatId=${chatId} from=${user.address} to=${to} amount=${amount}: ${res.error}`);
      bot.sendMessage(chatId, tBot('wallet.error', lang, { error: res.error }), getMainMenu(lang));
    } else {
      log.info(`TX sent: id=${res.tx?.id} from=${user.address} to=${to} amount=${amount} QTR fee=${res.fee}`);
      bot.sendMessage(chatId,
        tBot('send.success', lang, {
          to:   short(to),
          amount,
          fee:  res.fee,
          txId: res.tx.id
        }),
        { parse_mode: 'Markdown', ...getMainMenu(lang) }
      );
    }
    setUser(chatId, { pendingSend: null, state: null });
    return;
  }

  if (data === 'cancel_send') {
    setUser(chatId, { pendingSend: null, state: null });
    bot.sendMessage(chatId, tBot('send.cancelled', lang), getMainMenu(lang));
    return;
  }

  // ── Miner download ───────────────────────────────────────────────────────────
  if (data === 'miner_download') {
    log.info(`User chatId=${chatId} requested miner download`);
    await bot.sendMessage(chatId, tBot('miner.building', lang));
    try {
      const { sent } = await sendMinerDocument(chatId, lang);
      if (sent) await bot.sendMessage(chatId, tBot('miner.sent_ok', lang), getMainMenu(lang));
    } catch (e) {
      log.error(`miner_download callback failed for chatId=${chatId}: ${e.message || e}`);
      await bot.sendMessage(chatId, `❌ ${e.message || e}`);
    }
    return;
  }

  // ── Toggle notifications ─────────────────────────────────────────────────────
  if (data === 'toggle_notifications') {
    const u = getUser(chatId) || {};
    const newVal = !(u.notifications === true);
    setUser(chatId, { notifications: newVal });
    await bot.sendMessage(chatId,
      tBot(newVal ? 'notif.toggled_on' : 'notif.toggled_off', lang),
      { parse_mode: 'Markdown', ...getMainMenu(lang) }
    );
    return;
  }

  // ── Show address + QR ────────────────────────────────────────────────────────
  if (data === 'show_address') {
    const u = getUser(chatId) || {};
    if (!u.address) { bot.sendMessage(chatId, tBot('err.login_first', lang)); return; }
    const addr = u.address;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(addr)}&margin=10`;
    try {
      await bot.sendPhoto(chatId, qrUrl, {
        caption: tBot('address.qr_caption', lang, { address: addr }),
        parse_mode: 'Markdown'
      });
    } catch {
      bot.sendMessage(chatId, tBot('address.text', lang, { address: addr }), { parse_mode: 'Markdown' });
    }
    return;
  }

  // ── Referral ─────────────────────────────────────────────────────────────────
  if (data === 'show_ref') {
    const u = getUser(chatId) || {};
    await sendRefInfo(chatId, u);
    return;
  }

  // ── Logout ───────────────────────────────────────────────────────────────────
  if (data === 'do_logout') {
    setUser(chatId, { address: null, token: null, state: null });
    bot.sendMessage(chatId, tBot('logout.done', lang));
    return;
  }

  // ── Contest join ─────────────────────────────────────────────────────────────
  if (data === 'contest_join') {
    const contest = loadContest();
    if (!contest || !contest.active) { bot.sendMessage(chatId, tBot('contest.not_active', lang)); return; }
    const u = getUser(chatId) || {};
    if (!u.address) { bot.sendMessage(chatId, tBot('contest.need_wallet', lang)); return; }
    bot.sendMessage(chatId,
      tBot('contest.join_prompt', lang, { min: contest.minAmount || 10 }),
      { parse_mode: 'Markdown' }
    );
    setUser(chatId, { state: 'awaiting_send_amount', pendingSend: { to: contest.address } });
    return;
  }

  // ── No site ──────────────────────────────────────────────────────────────────
  if (data === 'no_site') {
    bot.sendMessage(chatId, tBot('err.no_site', lang));
    return;
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  const user = getUser(chatId) || {};
  const lang = user.lang || 'ru';

  // ── State machine ────────────────────────────────────────────────────────────

  if (user.state === 'awaiting_lang') {
    // Already handled by callback_query, ignore text
    return;
  }

  if (user.state === 'awaiting_new_password') {
    if (text.length < 6) { bot.sendMessage(chatId, tBot('wallet.password_too_short', lang)); return; }
    bot.sendMessage(chatId, tBot('wallet.creating', lang));
    const res = await apiRequest('/auth/register', 'POST', { password: text, label: `Telegram ${chatId}` });
    if (res.error) {
      log.error(`Wallet creation failed for chatId=${chatId}: ${res.error}`);
      bot.sendMessage(chatId, tBot('wallet.error', lang, { error: res.error }));
      return;
    }
    log.info(`New wallet created via bot: address=${res.address} chatId=${chatId}`);
    setUser(chatId, { address: res.address, token: res.token, state: null });
    bot.sendMessage(chatId,
      tBot('wallet.created', lang, { address: res.address, privateKey: res.privateKey, mnemonic: res.mnemonic }),
      { parse_mode: 'Markdown', ...getMainMenu(lang) }
    );
    return;
  }

  if (user.state === 'awaiting_login_address') {
    if (!text.startsWith('K') || text.length < 10) { bot.sendMessage(chatId, tBot('wallet.invalid_address', lang)); return; }
    setUser(chatId, { loginAddress: text, state: 'awaiting_login_password' });
    bot.sendMessage(chatId, tBot('wallet.ask_password_login', lang));
    return;
  }

  if (user.state === 'awaiting_login_password') {
    const res = await apiRequest('/auth/login', 'POST', { address: user.loginAddress, password: text });
    if (res.error) {
      log.warn(`Login failed for chatId=${chatId} address=${user.loginAddress}: ${res.error}`);
      bot.sendMessage(chatId, tBot('wallet.error', lang, { error: res.error }));
      return;
    }
    log.info(`User logged in: chatId=${chatId} address=${res.address}`);
    setUser(chatId, { address: res.address, token: res.token, loginAddress: null, state: null });
    bot.sendMessage(chatId,
      tBot('wallet.login_success', lang, { address: res.address }),
      { parse_mode: 'Markdown', ...getMainMenu(lang) }
    );
    return;
  }

  if (user.state === 'awaiting_send_to') {
    if (!text.startsWith('K')) { bot.sendMessage(chatId, tBot('send.invalid_address', lang)); return; }
    setUser(chatId, { pendingSend: { to: text }, state: 'awaiting_send_amount' });
    bot.sendMessage(chatId, tBot('send.ask_amount', lang, { to: short(text) }), { parse_mode: 'Markdown' });
    return;
  }

  if (user.state === 'awaiting_send_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, tBot('send.invalid_amount', lang)); return; }
    setUser(chatId, { pendingSend: { ...user.pendingSend, amount }, state: 'awaiting_send_password' });
    bot.sendMessage(chatId, tBot('send.ask_password', lang, { amount }), { parse_mode: 'Markdown' });
    return;
  }

  if (user.state === 'awaiting_send_password') {
    const { to, amount } = user.pendingSend;
    const fee = Math.max(0.0001, parseFloat((amount * 0.001).toFixed(6)));
    setUser(chatId, { pendingSend: { ...user.pendingSend, password: text }, state: null });
    bot.sendMessage(chatId,
      tBot('send.confirm', lang, {
        to:    short(to),
        amount,
        fee,
        total: (amount + fee).toFixed(6)
      }),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: tBot('send.btn_confirm', lang), callback_data: 'confirm_send' },
            { text: tBot('send.btn_cancel',  lang), callback_data: 'cancel_send'  }
          ]]
        }
      }
    );
    return;
  }

  if (user.state === 'awaiting_search_query') {
    setUser(chatId, { state: null });
    const q = encodeURIComponent(text);
    const res = await apiRequest('/search/' + q);
    if (res.error) { bot.sendMessage(chatId, tBot('err.not_found', lang), getMainMenu(lang)); return; }
    if (res.type === 'block') {
      bot.sendMessage(chatId,
        tBot('block.info', lang, { index: res.data.index, hash: res.data.hash, txCount: res.data.transactions?.length || 0, confirmations: res.confirmations }),
        { parse_mode: 'Markdown', ...getMainMenu(lang) }
      );
      return;
    }
    if (res.type === 'tx') {
      bot.sendMessage(chatId,
        `💸 ${lang === 'en' ? 'Found tx' : 'Найдена tx'}\nID: \`${res.data.id}\`\n${lang === 'en' ? 'Amount' : 'Сумма'}: ${res.data.amount} QTR`,
        { parse_mode: 'Markdown', ...getMainMenu(lang) }
      );
      return;
    }
    if (res.type === 'address') {
      bot.sendMessage(chatId,
        `👛 ${lang === 'en' ? 'Address' : 'Адрес'}: \`${res.data.address}\`\n${lang === 'en' ? 'Balance' : 'Баланс'}: *${Number(res.data.balance || 0).toFixed(6)} QTR*`,
        { parse_mode: 'Markdown', ...getMainMenu(lang) }
      );
      return;
    }
    bot.sendMessage(chatId, tBot('search.found', lang), getMainMenu(lang));
    return;
  }

  // ── Menu buttons ─────────────────────────────────────────────────────────────

  if (isMenu(text, 'menu.balance')) {
    if (!user.address) { bot.sendMessage(chatId, tBot('err.login_first', lang)); return; }
    const res = await apiRequest('/balance/' + user.address);
    if (res.error) { bot.sendMessage(chatId, tBot('stats.node_unavailable', lang)); return; }
    bot.sendMessage(chatId,
      tBot('balance.title', lang, {
        address:    user.address,
        available:  (res.available || 0).toFixed(6),
        pendingOut: (res.pendingOut || 0).toFixed(6),
        balance:    (res.balance || 0).toFixed(6)
      }),
      { parse_mode: 'Markdown', ...getMainMenu(lang) }
    );
    return;
  }

  if (isMenu(text, 'menu.send')) {
    if (!user.address) { bot.sendMessage(chatId, tBot('err.login_only', lang)); return; }
    setUser(chatId, { state: 'awaiting_send_to' });
    bot.sendMessage(chatId, tBot('send.ask_address', lang), { parse_mode: 'Markdown' });
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
    bot.sendMessage(chatId, tBot('price.title', lang), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...(PUBLIC_URL   ? [[{ text: tBot('btn.open_site', lang), url: PUBLIC_URL }]] : []),
          ...(CHANNEL_URL  ? [[{ text: tBot('btn.tg_channel', lang), url: CHANNEL_URL }]] : []),
          [{ text: tBot('price.btn_notif', lang), callback_data: 'toggle_notifications' }]
        ]
      }
    });
    return;
  }

  if (isMenu(text, 'menu.channel')) {
    if (!CHANNEL_URL) {
      bot.sendMessage(chatId, tBot('channel.coming_soon', lang), getMainMenu(lang));
      return;
    }
    bot.sendMessage(chatId, tBot('channel.text', lang), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: tBot('channel.btn_open', lang), url: CHANNEL_URL }],
          ...(PUBLIC_URL ? [[{ text: tBot('channel.btn_site', lang), url: PUBLIC_URL }]] : [])
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
      const lines = [tBot('contest.none', lang)];
      if (CHANNEL_URL) lines.push(`\n📢 ${CHANNEL_URL}`);
      bot.sendMessage(chatId, lines.join(''), { parse_mode: 'Markdown', ...getMainMenu(lang) });
      return;
    }
    const entries = await getContestEntries(contest.address);
    const myEntry = user.address ? entries.find(e => e.address === user.address) : null;
    const totalSent = entries.reduce((s, e) => s + e.total, 0);
    const myChance = (myEntry && totalSent > 0) ? ((myEntry.total / totalSent) * 100).toFixed(1) : '0';
    const myLine = myEntry
      ? tBot('contest.my_tickets', lang, { total: myEntry.total.toFixed(2), chance: myChance })
      : tBot('contest.no_tickets', lang);
    bot.sendMessage(chatId,
      tBot('contest.active', lang, {
        prize:   contest.prize.toLocaleString(),
        endDate: contest.endDate,
        address: contest.address,
        count:   entries.length,
        total:   totalSent.toFixed(1)
      }) + myLine,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: tBot('contest.btn_join', lang), callback_data: 'contest_join' }]]
        }
      }
    );
    return;
  }

  if (isMenu(text, 'menu.history')) {
    if (!user.address) { bot.sendMessage(chatId, tBot('err.login_only', lang)); return; }
    const res = await apiRequest('/history/' + user.address + '?limit=10');
    if (res.error || !res.history?.length) {
      bot.sendMessage(chatId, tBot('history.empty', lang), { parse_mode: 'Markdown', ...getMainMenu(lang) });
      return;
    }
    const miningLabel = tBot('history.mining', lang);
    const lines = res.history.slice(0, 10).map(tx => {
      const isIn  = tx.to === user.address;
      const isSys = tx.from === 'REWARD' || tx.from === 'SYSTEM';
      const peer  = isIn ? (isSys ? miningLabel : short(tx.from, 6)) : short(tx.to, 6);
      const sign  = isIn ? '+' : '-';
      const conf  = tx.confirmed ? '✅' : '⏳';
      return `${conf} ${sign}${tx.amount} QTR ${isIn ? '←' : '→'} ${peer}`;
    });
    bot.sendMessage(chatId,
      tBot('history.title', lang) + '\n\n' + lines.join('\n'),
      { parse_mode: 'Markdown', ...getMainMenu(lang) }
    );
    return;
  }

  if (isMenu(text, 'menu.settings')) {
    if (!user.address) { bot.sendMessage(chatId, tBot('err.login_only', lang)); return; }
    const notifOn = user.notifications === true;
    bot.sendMessage(chatId,
      tBot('settings.title', lang, { address: user.address }),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: tBot('settings.my_addr',  lang), callback_data: 'show_address'         }],
            [{ text: tBot(notifOn ? 'settings.notif_on' : 'settings.notif_off', lang), callback_data: 'toggle_notifications' }],
            [{ text: tBot('settings.ref',      lang), callback_data: 'show_ref'             }],
            [{ text: lang === 'ru' ? tBot('settings.switch_to_en', lang) : tBot('settings.switch_to_ru', lang), callback_data: lang === 'ru' ? 'set_lang_en' : 'set_lang_ru' }],
            [{ text: tBot('settings.open_site', lang), ...(PUBLIC_URL ? { url: PUBLIC_URL } : { callback_data: 'no_site' }) }],
            [{ text: tBot('settings.logout',   lang), callback_data: 'do_logout'            }]
          ]
        }
      }
    );
    return;
  }

  if (isMenu(text, 'menu.mining')) {
    const releaseUrl = process.env.QTR_MINER_RELEASE_URL || MINER_URL;
    const addrText = user.address
      ? `\`${user.address}\``
      : tBot('mining.no_address', lang);
    const kb = [];
    if (releaseUrl && !releaseUrl.includes('yourname')) {
      kb.push([{ text: tBot('mining.btn_download', lang), url: releaseUrl }]);
    }
    if (PUBLIC_URL) kb.push([{ text: tBot('mining.btn_wallet', lang), url: PUBLIC_URL }]);
    bot.sendMessage(chatId,
      tBot('mining.title', lang, { address: addrText }),
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: kb.length ? kb : undefined }
      }
    );
    return;
  }

  // Legacy text buttons (search, site) — kept for backward compat
  if (text === '🔎 Поиск' || text === '🔎 Search') {
    setUser(chatId, { state: 'awaiting_search_query' });
    bot.sendMessage(chatId, tBot('search.ask', lang));
    return;
  }

  if (text === '🌐 Сайт' || text === '🌐 Site') {
    if (!PUBLIC_URL) {
      bot.sendMessage(chatId, tBot('err.no_site', lang));
      return;
    }
    bot.sendMessage(chatId, lang === 'en' ? '🌐 Web wallet and explorer:' : '🌐 Веб-кошелёк и обозреватель:', {
      reply_markup: {
        inline_keyboard: [[{ text: lang === 'en' ? 'Open website' : 'Открыть сайт', url: PUBLIC_URL }]]
      }
    });
    return;
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/\/logout/, (msg) => {
  const lang = getUserLang(msg.chat.id) || 'ru';
  setUser(msg.chat.id, { address: null, token: null, state: null });
  bot.sendMessage(msg.chat.id, tBot('logout.done', lang));
});

bot.onText(/\/address/, async (msg) => {
  const chatId = msg.chat.id;
  const lang   = getUserLang(chatId) || 'ru';
  const user   = getUser(chatId);
  if (!user?.address) { bot.sendMessage(chatId, tBot('err.login_only', lang)); return; }
  const addr   = user.address;
  const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(addr)}&margin=10`;
  try {
    await bot.sendPhoto(chatId, qrUrl, {
      caption: tBot('address.caption', lang, { address: addr }),
      parse_mode: 'Markdown'
    });
  } catch {
    bot.sendMessage(chatId, tBot('address.text', lang, { address: addr }), { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/help/, (msg) => {
  const lang = getUserLang(msg.chat.id) || 'ru';
  bot.sendMessage(msg.chat.id, tBot('help.text', lang), { parse_mode: 'Markdown' });
});

bot.onText(/\/miner/, async (msg) => {
  const chatId     = msg.chat.id;
  const lang       = getUserLang(chatId) || 'ru';
  const releaseUrl = process.env.QTR_MINER_RELEASE_URL || MINER_URL;
  log.info(`/miner command from chatId=${chatId}`);
  if (releaseUrl && !releaseUrl.includes('yourname')) {
    await bot.sendMessage(chatId, [
      lang === 'en' ? '⛏ *Qatrol Coin Pool Miner*\n\nDownload the .exe and run it — pool is pre-configured.\nEnter your wallet address (starts with K) and start mining.\n\n💰 Reward: *16.7 QTR* per block'
                    : '⛏ *Qatrol Coin Pool Miner*\n\nСкачай .exe и запусти — пул уже вшит.\nВведи свой адрес кошелька (начинается с K) и начни майнить.\n\n💰 Награда: *16.7 QTR* за блок'
    ].join(''), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: tBot('mining.btn_download', lang), url: releaseUrl }]] }
    });
  } else {
    await bot.sendMessage(chatId, '⚙️ Set QTR_MINER_RELEASE_URL in .env with a GitHub Releases link.');
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
  const lang   = getUserLang(chatId) || 'ru';
  const u      = getUser(chatId) || {};
  const newVal = !(u.notifications === true);
  setUser(chatId, { notifications: newVal });
  bot.sendMessage(chatId,
    tBot(newVal ? 'notif.toggled_on' : 'notif.toggled_off', lang),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/mempool/, async (msg) => {
  const lang = getUserLang(msg.chat.id) || 'ru';
  const res  = await apiRequest('/mempool');
  if (res.error) { bot.sendMessage(msg.chat.id, tBot('mempool.unavailable', lang)); return; }
  bot.sendMessage(msg.chat.id, tBot('mempool.info', lang, { count: res.count || 0, fees: Number(res.totalFees || 0).toFixed(6) }));
});

bot.onText(/\/block (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const lang   = getUserLang(chatId) || 'ru';
  const q      = (match?.[1] || '').trim();
  const res    = await apiRequest('/block/' + encodeURIComponent(q));
  if (res.error || !res.block) { bot.sendMessage(chatId, tBot('block.not_found', lang)); return; }
  bot.sendMessage(chatId,
    tBot('block.info', lang, {
      index:         res.block.index,
      hash:          res.block.hash,
      txCount:       res.block.transactions?.length || 0,
      confirmations: res.confirmations
    }),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/tx (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const lang   = getUserLang(chatId) || 'ru';
  const q      = (match?.[1] || '').trim();
  const res    = await apiRequest('/tx/' + encodeURIComponent(q));
  if (res.error || !res.tx) { bot.sendMessage(chatId, tBot('tx.not_found', lang)); return; }
  bot.sendMessage(chatId,
    tBot('tx.info', lang, {
      id:     res.tx.id,
      from:   res.tx.from,
      to:     res.tx.to,
      amount: res.tx.amount,
      fee:    res.tx.fee || 0,
      status: res.confirmed ? tBot('tx.status_confirmed', lang) : tBot('tx.status_pending', lang)
    }),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const lang   = getUserLang(chatId) || 'ru';
  const q      = encodeURIComponent((match?.[1] || '').trim());
  const res    = await apiRequest('/search/' + q);
  if (res.error) { bot.sendMessage(chatId, tBot('search.not_found', lang)); return; }
  bot.sendMessage(chatId, `🔎 ${lang === 'en' ? 'Found type:' : 'Найден тип:'} ${res.type}`);
});

// ─── Block notifications ──────────────────────────────────────────────────────
let lastKnownBlockIndex = -1;

async function checkNewBlocks() {
  try {
    const res = await apiRequest('/stats');
    if (res.error || typeof res.blocks !== 'number') return;
    const latest = res.blocks - 1;
    if (lastKnownBlockIndex < 0) { lastKnownBlockIndex = latest; return; }
    if (latest <= lastKnownBlockIndex) return;

    for (let idx = lastKnownBlockIndex + 1; idx <= latest; idx++) {
      const blockRes = await apiRequest('/block/' + idx);
      if (blockRes.error || !blockRes.block) continue;
      const block = blockRes.block;
      const miner = block.miner || block.transactions?.find(t => t.from === 'REWARD')?.to;

      const users = loadUsers();
      for (const [cid, u] of Object.entries(users)) {
        if (!u.notifications) continue;
        const uLang = u.lang || 'ru';
        const isMyBlock = miner && u.address && miner === u.address;
        const msgText = isMyBlock
          ? tBot('block.found_by_me', uLang, { index: block.index })
          : tBot('block.found_other', uLang, { index: block.index, miner: short(miner || '?', 8), txCount: block.transactions?.length || 0 });
        bot.sendMessage(cid, msgText, { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
    lastKnownBlockIndex = latest;
  } catch {}
}

setInterval(checkNewBlocks, 20_000);

// ─── Admin commands ───────────────────────────────────────────────────────────
bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Access denied'); return; }
  const text = (match?.[1] || '').trim();
  if (!text) {
    bot.sendMessage(chatId, '📤 *Broadcast*\n\nUsage: /broadcast <text>\n\nExample:\n/broadcast Hello! Contest starts tomorrow.', { parse_mode: 'Markdown' });
    return;
  }
  const users = loadUsers();
  const total = Object.values(users).filter(u => u.address).length;
  await bot.sendMessage(chatId, `📤 Sending to *${total}* users...`, { parse_mode: 'Markdown' });
  const result = await broadcastAll(`📢 *Message from Qatrol Coin team:*\n\n${text}`, { parse_mode: 'Markdown' }, chatId);
  bot.sendMessage(chatId, `✅ *Broadcast done*\n\n📨 Sent: ${result.sent}\n❌ Failed: ${result.failed}\n⏭ No wallet: ${result.skipped}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/startcontest(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Access denied'); return; }
  const parts = (match?.[1] || '').trim().split(/\s+/);
  if (parts.length < 3 || !parts[0].startsWith('K')) {
    bot.sendMessage(chatId, '🏆 *Start contest*\n\nUsage:\n/startcontest <address> <prize_QTR> <date>\n\nExample:\n/startcontest K814F1CF9... 10000 30.04.2026', { parse_mode: 'Markdown' });
    return;
  }
  const [address, prizeStr, ...dateParts] = parts;
  const prize   = parseFloat(prizeStr);
  const endDate = dateParts.join(' ');
  if (isNaN(prize) || prize <= 0) { bot.sendMessage(chatId, '❌ Invalid prize amount'); return; }

  const contest = { active: true, address, prize, endDate, minAmount: 10, startedAt: Date.now() };
  saveContest(contest);

  const announceRu = [
    `🏆 *Конкурс Qatrol Coin — ${prize.toLocaleString()} QTR!*`,
    '',
    `Разыгрываем *${prize.toLocaleString()} QTR* — прямо на твой кошелёк!`,
    '',
    `📋 *Правила:*`,
    `• Отправь QTR на конкурсный адрес`,
    `• Каждый QTR = 1 лотерейный билет`,
    `• Чем больше отправишь — тем выше шанс на победу`,
    '',
    `📍 *Конкурсный адрес:*`,
    `\`${address}\``,
    '',
    `📅 До: *${endDate}*  |  Мин. взнос: *${contest.minAmount} QTR*`,
    '',
    `👇 Нажми *🏆 Конкурс* в меню!`
  ].join('\n');

  const announceEn = [
    `🏆 *Qatrol Coin Contest — ${prize.toLocaleString()} QTR!*`,
    '',
    `We\'re giving away *${prize.toLocaleString()} QTR* — straight to your wallet!`,
    '',
    `📋 *Rules:*`,
    `• Send QTR to the contest address`,
    `• Each QTR = 1 lottery ticket`,
    `• More you send — higher the chance to win`,
    '',
    `📍 *Contest address:*`,
    `\`${address}\``,
    '',
    `📅 Until: *${endDate}*  |  Min: *${contest.minAmount} QTR*`,
    '',
    `👇 Press *🏆 Contest* in the menu!`
  ].join('\n');

  await bot.sendMessage(chatId, '📤 Broadcasting contest announcement...');
  await bot.sendMessage(chatId, announceEn, { parse_mode: 'Markdown' });

  // Send per-user language
  const users = loadUsers();
  let sent = 0, failed = 0;
  for (const [cid, u] of Object.entries(users)) {
    if (!u.address || String(cid) === String(chatId)) continue;
    const uLang = u.lang || 'ru';
    try {
      await bot.sendMessage(Number(cid), uLang === 'en' ? announceEn : announceRu, { parse_mode: 'Markdown' });
      sent++;
      await sleep(65);
    } catch { failed++; }
  }
  bot.sendMessage(chatId, `✅ *Contest started!*\n\n📨 Announced to: ${sent} users\n❌ Failed: ${failed}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/checkcontest/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Access denied'); return; }
  const contest = loadContest();
  if (!contest || !contest.active) { bot.sendMessage(chatId, '❌ No active contest'); return; }

  await bot.sendMessage(chatId, '⏳ Loading data...');
  const entries   = await getContestEntries(contest.address);
  const totalSent = entries.reduce((s, e) => s + e.total, 0);

  if (!entries.length) { bot.sendMessage(chatId, '📭 No participants yet'); return; }
  const lines = entries.slice(0, 15).map((e, i) => {
    const chance = totalSent > 0 ? ((e.total / totalSent) * 100).toFixed(1) : '0';
    const cid = e.chatId ? `tg:${e.chatId}` : 'unreg.';
    return `${i + 1}. \`${e.address.slice(0, 10)}...\` — ${e.total.toFixed(2)} QTR (${chance}%) [${cid}]`;
  });
  bot.sendMessage(chatId, [
    `🏆 *Contest Status*`,
    '',
    `Participants: *${entries.length}*`,
    `Total QTR: *${totalSent.toFixed(2)}*`,
    `Prize pool: *${contest.prize.toLocaleString()} QTR*`,
    '',
    `*Leaderboard:*`,
    lines.join('\n')
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/endcontest/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Access denied'); return; }
  const contest = loadContest();
  if (!contest || !contest.active) { bot.sendMessage(chatId, '❌ No active contest'); return; }

  await bot.sendMessage(chatId, '⏳ Counting results...');
  const entries = await getContestEntries(contest.address);
  if (!entries.length) { bot.sendMessage(chatId, '❌ No participants, contest not ended'); return; }

  const winner     = pickLotteryWinner(entries);
  const totalSent  = entries.reduce((s, e) => s + e.total, 0);
  const winnerChance = ((winner.total / totalSent) * 100).toFixed(1);

  saveContest({ ...contest, active: false, winner: winner.address, endedAt: Date.now() });

  const resultRu = [
    `🎉 *Конкурс Qatrol Coin завершён!*`,
    '',
    `🏆 *Победитель:*\n\`${winner.address}\``,
    '',
    `🎁 Приз: *${contest.prize.toLocaleString()} QTR*`,
    `🎟 Билетов: *${winner.total.toFixed(2)} QTR* (шанс ${winnerChance}%)`,
    `👥 Участников: *${entries.length}*`,
    '',
    `Поздравляем! Приз будет отправлен на кошелёк.`,
    CHANNEL_URL ? `📢 ${CHANNEL_URL}` : ''
  ].filter(Boolean).join('\n');

  const resultEn = [
    `🎉 *Qatrol Coin Contest Ended!*`,
    '',
    `🏆 *Winner:*\n\`${winner.address}\``,
    '',
    `🎁 Prize: *${contest.prize.toLocaleString()} QTR*`,
    `🎟 Tickets: *${winner.total.toFixed(2)} QTR* (chance ${winnerChance}%)`,
    `👥 Participants: *${entries.length}*`,
    '',
    `Congrats! Prize will be sent to the wallet.`,
    CHANNEL_URL ? `📢 ${CHANNEL_URL}` : ''
  ].filter(Boolean).join('\n');

  if (winner.chatId) {
    const wLang = getUserLang(winner.chatId) || 'ru';
    const winMsg = wLang === 'en'
      ? `🎉 *You won the Qatrol Coin contest!*\n\n🏆 Prize: *${contest.prize.toLocaleString()} QTR*\n\nYour tickets: *${winner.total.toFixed(2)} QTR*\n\nPrize coming to \`${winner.address}\` soon!`
      : `🎉 *Ты победил в конкурсе Qatrol Coin!*\n\n🏆 Приз: *${contest.prize.toLocaleString()} QTR*\n\nТвои билеты: *${winner.total.toFixed(2)} QTR*\n\nПриз придёт на \`${winner.address}\` в ближайшее время!`;
    bot.sendMessage(Number(winner.chatId), winMsg, { parse_mode: 'Markdown' }).catch(() => {});
  }

  await bot.sendMessage(chatId, resultEn, { parse_mode: 'Markdown' });
  await bot.sendMessage(chatId, '📤 Broadcasting results...');
  const users = loadUsers();
  let sent = 0;
  for (const [cid, u] of Object.entries(users)) {
    if (!u.address || String(cid) === String(chatId)) continue;
    const uLang = u.lang || 'ru';
    try {
      await bot.sendMessage(Number(cid), uLang === 'en' ? resultEn : resultRu, { parse_mode: 'Markdown' });
      sent++;
      await sleep(65);
    } catch {}
  }
  bot.sendMessage(chatId, `✅ Results broadcast to: ${sent} users`);
});

bot.onText(/\/cancelcontest/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Access denied'); return; }
  const contest = loadContest();
  if (!contest || !contest.active) { bot.sendMessage(chatId, '❌ No active contest'); return; }
  saveContest({ ...contest, active: false, cancelled: true });
  bot.sendMessage(chatId, '✅ Contest cancelled');
});

bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '❌ Access denied'); return; }
  const contest = loadContest();
  bot.sendMessage(chatId, [
    `⚙️ *Admin Panel*`,
    '',
    `📤 *Broadcast:*`,
    `/broadcast <text> — send to all users`,
    '',
    `🏆 *Contest management:*`,
    `/startcontest <address> <prize> <date>`,
    `/checkcontest — status and participants`,
    `/endcontest — end and pick winner`,
    `/cancelcontest — cancel without winner`,
    '',
    `📊 *Contest status:* ${contest?.active ? `✅ Active (until ${contest.endDate})` : '❌ None active'}`,
    '',
    `👥 *Users with wallets:* ${Object.values(loadUsers()).filter(u => u.address).length}`
  ].join('\n'), { parse_mode: 'Markdown' });
});

console.log('\n\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[33m║      ◆  QATROL COIN TELEGRAM BOT  ◆              ║\x1b[0m');
console.log('\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m\n');
console.log('  Bot started. Open @your_bot in Telegram\n');
log.info(`Bot started. API=${API_HOST}:${API_PORT} POOL_BUILD_HOST=${POOL_BUILD_HOST || '(not set)'} PUBLIC_URL=${PUBLIC_URL || '(not set)'} EXE_CACHE_TTL=${MINER_BUILD_COOLDOWN_MS}ms`);
