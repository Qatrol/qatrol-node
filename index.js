// bot/index.js — Qatrol Coin Telegram Bot
// npm install node-telegram-bot-api
'use strict';

const TelegramBot = require('node-telegram-bot-api');
const http        = require('http');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const { execSync } = require('child_process');

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

const TOKEN    = process.env.QTR_BOT_TOKEN || '';
const API_HOST = process.env.QTR_API_HOST  || 'localhost';
const API_PORT = parseInt(process.env.QTR_PORT || '3001');
const MINER_URL = process.env.QTR_MINER_URL || 'https://github.com/yourname/qatrol/releases';
const PUBLIC_URL = (process.env.QTR_PUBLIC_URL || '').trim();
const POOL_BUILD_HOST = (process.env.QTR_POOL_BUILD_HOST || '').trim();
const MINER_PUBLIC_EXE = path.join(PROJECT_ROOT, 'dist', 'qtr-pool-miner-public.exe');
const MINER_BUILD_COOLDOWN_MS = parseInt(process.env.QTR_MINER_BUILD_COOLDOWN_MS || '600000', 10);
const BOT_PROXY = process.env.QTR_BOT_PROXY || '';
const BOT_POLLING_INTERVAL_MS = parseInt(process.env.QTR_BOT_POLLING_INTERVAL_MS || '1200');
const BOT_UPLOAD_TIMEOUT_MS = parseInt(process.env.QTR_BOT_UPLOAD_TIMEOUT_MS || '600000', 10);

if (!TOKEN) { console.error('❌ Нужен QTR_BOT_TOKEN'); process.exit(1); }

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
  console.error('⚠ polling_error:', err?.message || err);
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
  console.log(`📦 Отправка майнера: ${exePath} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
  if (st.size > TG_DOC_LIMIT) {
    const url = minerDownloadUrl();
    await bot.sendMessage(chatId, url
      ? `Файл слишком большой для Telegram. Скачай с сайта:\n${url}`
      : `Файл слишком большой. Задай QTR_PUBLIC_URL и открой /download/qtr-pool-miner.exe на веб-сервере.`);
    return { sent: false };
  }

  const fileBuf = fs.readFileSync(exePath);
  const docOpts = {
    caption: 'Запуск на ПК: введи только адрес K… Пул уже зашит внутрь.',
    filename: 'qtr-pool-miner.exe',
    contentType: 'application/octet-stream'
  };

  const retriable = (err) => {
    const m = (err && (err.message || err.code || '')).toString();
    return /hang up|ECONNRESET|ETIMEDOUT|socket|aborted|timeout/i.test(m);
  };

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt > 0) console.log(`↻ Повтор отправки exe (${attempt + 1}/5)…`);
      await bot.sendDocument(chatId, fileBuf, docOpts);
      return { sent: true };
    } catch (e) {
      lastErr = e;
      console.error(`sendDocument attempt ${attempt + 1}:`, e.message || e);
      if (!retriable(e) || attempt === 4) break;
      await sleep(4000 * (attempt + 1));
    }
  }

  const url = minerDownloadUrl();
  await bot.sendMessage(chatId, [
    '❌ Telegram оборвал загрузку (часто из‑за прокси на больших файлах).',
    url ? `\nСкачай напрямую с сервера (без Telegram):\n${url}` : '\nУкажи QTR_PUBLIC_URL=http://ТВОЙ_IP:3000 в .env — тогда дам ссылку на скачивание.',
    `\nОшибка: ${lastErr && (lastErr.message || lastErr)}`
  ].filter(Boolean).join('\n'));
  return { sent: false };
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
  users[chatId] = { ...users[chatId], ...data };
  saveUsers(users);
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
  if (res.error) { bot.sendMessage(chatId, '❌ Нода недоступна'); return; }
  bot.sendMessage(chatId, [
    `📊 *Qatrol Coin — Статистика*`,
    ``,
    `⛓ Блоков: *${res.blocks}*`,
    `🎯 Сложность: ${res.difficulty}`,
    `⚡ Hashrate: ${fmtHashrate(res.hashrate || 0)}`,
    `⏳ В очереди: ${res.pendingTx} тр.`,
    ``,
    `💎 Эмиссия: ${Number(res.totalSupply).toLocaleString()} QTR`,
    `💰 В обращении: ${Number(res.circulatingSupply).toLocaleString()} QTR`,
    `🏆 Награда за блок: ${res.blockReward} QTR`,
    `💸 Комиссия: ${res.feePercent}%`,
    ``,
    `✅ Цепочка ${res.valid ? 'валидна' : '❌ НАРУШЕНА'}`
  ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
}

async function sendPoolStats(chatId, address = null) {
  const res = await apiRequest('/pool/stats', 'GET');
  if (res.error) { bot.sendMessage(chatId, '❌ Пул недоступен'); return; }
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
  ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
}

const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      ['💰 Баланс', '📤 Отправить'],
      ['🌐 Сайт', '⛏ Майнинг'],
      ['📊 Статистика сети', '🏊 Пул'],
      ['📦 Mempool', '🔎 Поиск'],
      ['📜 История', '⚙️ Настройки']
    ],
    resize_keyboard: true
  }
};

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = getUser(chatId);

  if (user?.address) {
    bot.sendMessage(chatId, [
      `👋 *С возвращением!*`,
      ``,
      `◆ *Qatrol Coin (QTR)*`,
      ``,
      `Твой кошелёк: \`${user.address}\``,
      ``,
      `Используй кнопки меню ниже 👇`
    ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
    return;
  }

  const welcomeKb = [
    [{ text: '🆕 Создать кошелёк', callback_data: 'create_wallet' }],
    [{ text: '🔑 Войти (есть аккаунт)', callback_data: 'login_wallet' }]
  ];
  if (PUBLIC_URL) welcomeKb.push([{ text: '🌐 Открыть сайт', url: PUBLIC_URL }]);

  bot.sendMessage(chatId, [
    `👋 *Добро пожаловать в Qatrol Coin!*`,
    ``,
    `◆ QTR — децентрализованная криптовалюта`,
    `◆ Фиксированная эмиссия: 1,000,000,000 QTR`,
    `◆ Награда за блок: 0.1 QTR`,
    ``,
    `Что хочешь сделать?`
  ].join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: welcomeKb }
  });
});

// ─── Создание кошелька ────────────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const data   = q.data;
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
      bot.sendMessage(chatId, `❌ Ошибка: ${res.error}`, MAIN_MENU);
    } else {
      bot.sendMessage(chatId, [
        `✅ *Транзакция отправлена!*`,
        ``,
        `Кому: \`${short(to)}\``,
        `Сумма: *${amount} QTR*`,
        `Комиссия: ${res.fee} QTR`,
        `ID: \`${res.tx.id}\``,
        ``,
        `⏳ Ожидает подтверждения майнером`
      ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
    }
    setUser(chatId, { pendingSend: null, state: null });
  }

  if (data === 'cancel_send') {
    setUser(chatId, { pendingSend: null, state: null });
    bot.sendMessage(chatId, '❌ Отменено', MAIN_MENU);
  }

  if (data === 'miner_download') {
    await bot.sendMessage(chatId, '⏳ Собираю Windows-майнер (1–3 мин). Не закрывай чат…');
    try {
      const { sent } = await sendMinerDocument(chatId);
      if (sent) await bot.sendMessage(chatId, '✅ Файл отправлен.', MAIN_MENU);
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, `❌ ${e.message || e}`);
    }
  }
});

// ─── Обработка текста ─────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  const user = getUser(chatId) || {};

  // ── Состояния ──────────────────────────────────────────────────────────────
  if (user.state === 'awaiting_new_password') {
    if (text.length < 6) { bot.sendMessage(chatId, '❌ Минимум 6 символов, попробуй ещё:'); return; }
    bot.sendMessage(chatId, '⏳ Создаю кошелёк...');
    const res = await apiRequest('/auth/register', 'POST', { password: text, label: `Telegram ${chatId}` });
    if (res.error) { bot.sendMessage(chatId, `❌ Ошибка: ${res.error}`); return; }
    setUser(chatId, { address: res.address, token: res.token, state: null });
    bot.sendMessage(chatId, [
      `🎉 *Кошелёк создан!*`,
      ``,
      `📍 Адрес:`,
      `\`${res.address}\``,
      ``,
      `🔑 Приватный ключ:`,
      `\`${res.privateKey}\``,
      ``,
      `🌱 Мнемоник (12 слов):`,
      `\`${res.mnemonic}\``,
      ``,
      `⚠️ *СОХРАНИ ЭТИ ДАННЫЕ* — без них доступ потерян навсегда!`,
      `❗ Удали это сообщение после сохранения`
    ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
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
    if (res.error) { bot.sendMessage(chatId, `❌ ${res.error}`); return; }
    setUser(chatId, { address: res.address, token: res.token, loginAddress: null, state: null });
    bot.sendMessage(chatId, `✅ *Вход выполнен!*\n\nКошелёк: \`${res.address}\``, { parse_mode: 'Markdown', ...MAIN_MENU });
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
  if (text === '💰 Баланс') {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди или создай кошелёк. /start'); return; }
    const res = await apiRequest('/balance/' + user.address);
    if (res.error) { bot.sendMessage(chatId, '❌ Нода недоступна'); return; }
    bot.sendMessage(chatId, [
      `💰 *Баланс кошелька*`,
      ``,
      `📍 \`${user.address}\``,
      ``,
      `Доступно:    *${(res.available || 0).toFixed(6)} QTR*`,
      `В обработке: ${(res.pendingOut || 0).toFixed(6)} QTR`,
      `Всего:       ${(res.balance || 0).toFixed(6)} QTR`
    ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
    return;
  }

  if (text === '📤 Отправить') {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди. /start'); return; }
    setUser(chatId, { state: 'awaiting_send_to' });
    bot.sendMessage(chatId, '📤 *Отправить QTR*\n\nВведи адрес получателя (начинается с K):', { parse_mode: 'Markdown' });
    return;
  }

  if (text === '📊 Статистика сети') {
    await sendNetworkStats(chatId);
    return;
  }

  if (text === '🏊 Пул') {
    await sendPoolStats(chatId, user.address || null);
    return;
  }

  if (text === '📦 Mempool') {
    const res = await apiRequest('/mempool');
    if (res.error) { bot.sendMessage(chatId, '❌ Нода недоступна'); return; }
    bot.sendMessage(chatId, [
      `📦 *Mempool*`,
      ``,
      `Транзакций: *${res.count || 0}*`,
      `Сумма комиссий: ${(res.totalFees || 0).toFixed ? res.totalFees.toFixed(6) : Number(res.totalFees || 0).toFixed(6)} QTR`
    ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
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

  if (text === '⛏ Майнинг') {
    const lines = [
      `⛏ *Майнинг Qatrol Coin*`,
      ``,
      `Майни в пуле и получай долю награды за блоки.`,
      ``,
      `Твой адрес (для справки): ${user.address ? `\`${user.address}\`` : '_(создай или войди в кошелёк)_'}`,
      ``,
      `📥 *Готовый .exe* — нажми кнопку ниже (пул уже вшит).`,
      `Или вручную: \`node pool/miner-client.js АДРЕС ${POOL_BUILD_HOST || 'IP:3002'}\``,
      ``,
      `🔗 Альтернатива: [релизы](${MINER_URL})`
    ];
    bot.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📥 Скачать майнер (.exe)', callback_data: 'miner_download' }],
          ...(PUBLIC_URL ? [[{ text: '🌐 Сайт', url: PUBLIC_URL }]] : [])
        ]
      }
    });
    return;
  }

  if (text === '📜 История') {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди. /start'); return; }
    const res = await apiRequest('/history/' + user.address + '?limit=10');
    if (res.error || !res.history?.length) {
      bot.sendMessage(chatId, '📜 *История транзакций*\n\nПока нет транзакций', { parse_mode: 'Markdown', ...MAIN_MENU });
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
    bot.sendMessage(chatId, `📜 *Последние транзакции:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...MAIN_MENU });
    return;
  }

  if (text === '⚙️ Настройки') {
    if (!user.address) { bot.sendMessage(chatId, '❌ Сначала войди. /start'); return; }
    bot.sendMessage(chatId, [
      `⚙️ *Настройки*`,
      ``,
      `📍 Адрес: \`${user.address}\``,
      ``,
      `/logout — выйти из кошелька`,
      `/address — показать адрес + QR`,
      `/pool — статистика пула`,
      `/stats — статистика сети`,
      `/mempool — mempool`,
      `/block <index|hash> — блок`,
      `/tx <id> — транзакция`,
      `/search <q> — поиск`,
      `/help — помощь`
    ].join('\n'), { parse_mode: 'Markdown', ...MAIN_MENU });
    return;
  }

  if (user.state === 'awaiting_search_query') {
    setUser(chatId, { state: null });
    const q = encodeURIComponent(text);
    const res = await apiRequest('/search/' + q);
    if (res.error) { bot.sendMessage(chatId, '❌ Ничего не найдено или нода недоступна', MAIN_MENU); return; }
    if (res.type === 'block') {
      bot.sendMessage(chatId, `🧱 Найден блок #${res.data.index}\nHash: \`${res.data.hash}\``, { parse_mode: 'Markdown', ...MAIN_MENU });
      return;
    }
    if (res.type === 'tx') {
      bot.sendMessage(chatId, `💸 Найдена tx\nID: \`${res.data.id}\`\nСумма: ${res.data.amount} QTR`, { parse_mode: 'Markdown', ...MAIN_MENU });
      return;
    }
    if (res.type === 'address') {
      bot.sendMessage(chatId, `👛 Адрес: \`${res.data.address}\`\nБаланс: *${Number(res.data.balance || 0).toFixed(6)} QTR*`, { parse_mode: 'Markdown', ...MAIN_MENU });
      return;
    }
    bot.sendMessage(chatId, 'ℹ️ Найдено, но формат не распознан', MAIN_MENU);
    return;
  }
});

// ─── Команды ──────────────────────────────────────────────────────────────────
bot.onText(/\/logout/, (msg) => {
  setUser(msg.chat.id, { address: null, token: null, state: null });
  bot.sendMessage(msg.chat.id, '👋 Выход выполнен. /start чтобы войти снова.');
});

bot.onText(/\/address/, async (msg) => {
  const user = getUser(msg.chat.id);
  if (!user?.address) { bot.sendMessage(msg.chat.id, '❌ Войди сначала. /start'); return; }
  bot.sendMessage(msg.chat.id, `📍 Твой адрес:\n\n\`${user.address}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, [
    `❓ *Помощь — Qatrol Coin Bot*`,
    ``,
    `*Genesis (блок №0):* это начальный кошелёк со всем запасом монет. Войти в него можно *только* если сохранён приватный ключ или мнемоника того, кто первым запускал ноду при создании genesis (см. genesis.json). Без ключа доступ невозможен.`,
    ``,
    `/start — главное меню`,
    `/address — твой адрес`,
    `/logout — выход`,
    `/help — эта справка`,
    ``,
    `*Кнопки меню:*`,
    `💰 Баланс — проверить баланс`,
    `📤 Отправить — перевести QTR`,
    `📊 Статистика — данные сети`,
    `⛏ Майнинг — скачать майнер`,
    `🏊 Пул — статистика пула`,
    `📦 Mempool — очередь транзакций`,
    `🔎 Поиск — поиск блока/tx/адреса`,
    `🌐 Сайт — ссылка на веб-кошелёк`,
    `📜 История — транзакции`,
    `⚙️ Настройки — управление`,
    ``,
    `/miner — скачать Windows-майнер (.exe) с пулом внутри`
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/miner/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳ Собираю Windows-майнер…');
  try {
    const { sent } = await sendMinerDocument(chatId);
    if (sent) await bot.sendMessage(chatId, '✅ Файл отправлен.', MAIN_MENU);
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, `❌ ${e.message || e}`);
  }
});

bot.onText(/\/stats/, async (msg) => {
  await sendNetworkStats(msg.chat.id);
});

bot.onText(/\/pool/, async (msg) => {
  const user = getUser(msg.chat.id) || {};
  await sendPoolStats(msg.chat.id, user.address || null);
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

console.log('\n\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[33m║      ◆  QATROL COIN TELEGRAM BOT  ◆              ║\x1b[0m');
console.log('\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m\n');
console.log('  Бот запущен. Открой @твой_бот в Telegram\n');
