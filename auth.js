// auth.js — авторизация, AES-256-GCM, сессии, мнемоник
'use strict';
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const ecdsa    = require('./crypto/ecdsa');
const mn       = require('./crypto/mnemonic');
const { readJson, writeJsonAtomic } = require('./lib/storage');

// Файлы данных всегда рядом с кодом, а не в текущем каталоге процесса:
// иначе запуск `node /opt/qatrol/miner.js` из другого каталога создаёт пустые кошельки.
const DATA_DIR      = __dirname;
const WALLETS_FILE  = path.join(DATA_DIR, 'wallets.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL   = 7 * 24 * 60 * 60 * 1000;

// ─── AES-256-GCM ─────────────────────────────────────────────────────────────

function encryptKey(text, password) {
  const salt   = crypto.randomBytes(16);
  const iv     = crypto.randomBytes(12);
  const key    = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { encrypted: enc.toString('hex'), iv: iv.toString('hex'), salt: salt.toString('hex'), tag: tag.toString('hex') };
}

function decryptKey(enc, password) {
  try {
    const key      = crypto.pbkdf2Sync(password, Buffer.from(enc.salt, 'hex'), 100_000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
    return decipher.update(Buffer.from(enc.encrypted, 'hex')) + decipher.final('utf8');
  } catch { return null; }
}

// ─── Хранилище ───────────────────────────────────────────────────────────────

function loadWallets() {
  // Битый wallets.json — исключение, а не пустой объект: иначе следующая
  // регистрация перезапишет файл и все зашифрованные ключи пропадут.
  const r = readJson(WALLETS_FILE);
  return r.data || {};
}
function saveWallets(w) { writeJsonAtomic(WALLETS_FILE, w); }

// ─── Сессии ──────────────────────────────────────────────────────────────────

// Сессии кешируются в памяти: файл перечитывается, только когда его изменил
// другой процесс (бот, вторая нода). На каждый запрос чтения с диска больше нет.
let _sessionsCache = null;
let _sessionsMtime = 0;

function sessionsMtime() {
  try { return fs.statSync(SESSIONS_FILE).mtimeMs; } catch { return 0; }
}

function loadSessions() {
  const m = sessionsMtime();
  if (_sessionsCache && m === _sessionsMtime) return _sessionsCache;
  if (m === 0) { _sessionsCache = {}; _sessionsMtime = 0; return _sessionsCache; }
  try {
    _sessionsCache = readJson(SESSIONS_FILE).data || {};
  } catch (err) {
    // Сессии восстановимы (заново войти), поэтому не роняем ноду,
    // но громко пишем и оставляем бэкап — readJson его уже сделал.
    console.error('sessions.json повреждён, все сессии сброшены:', err.message);
    _sessionsCache = {};
  }
  _sessionsMtime = m;
  return _sessionsCache;
}

function saveSessions(s) {
  _sessionsCache = s;
  try {
    writeJsonAtomic(SESSIONS_FILE, s);
    _sessionsMtime = sessionsMtime();
  } catch (err) {
    // Не смогли сохранить сессию — пользователь перелогинится,
    // а падение ноды из-за этого недопустимо.
    console.error('Не удалось сохранить sessions.json:', err.message);
  }
}

function createSession(address) {
  const token    = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  for (const [k, v] of Object.entries(sessions)) {
    if (v.address === address || Date.now() > v.expiresAt) delete sessions[k];
  }
  sessions[token] = { address, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
  saveSessions(sessions);
  return token;
}

function verifySession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() > s.expiresAt) { delete sessions[token]; saveSessions(sessions); return null; }
  return s.address;
}

function deleteSession(token) {
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(c => {
    const [k, ...rest] = c.trim().split('=');
    if (k) out[k.trim()] = rest.join('=').trim();
  });
  return out;
}

function getSessionFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token   = cookies['koin_session'] || req.headers['x-session-token'];
  return { token: token || null, address: token ? verifySession(token) : null };
}

// ─── Регистрация ──────────────────────────────────────────────────────────────

function register(password, label) {
  if (typeof password !== 'string' || password.length < 8) return { error: 'Пароль минимум 8 символов' };
  const kp     = ecdsa.generateKeyPair();
  const phrase = mn.generateMnemonic();
  const enc    = encryptKey(kp.privateKey, password);
  const encMn  = encryptKey(phrase, password);
  const wallets = loadWallets();
  wallets[kp.address] = { address: kp.address, publicKey: kp.publicKey, encrypted: enc, mnemonic: encMn, label: label || '', createdAt: Date.now() };
  saveWallets(wallets);
  return { address: kp.address, publicKey: kp.publicKey, privateKey: kp.privateKey, mnemonic: phrase, token: createSession(kp.address), label: label || '' };
}

function importWallet(privateKeyHex, password, label) {
  if (!privateKeyHex || typeof privateKeyHex !== 'string') return { error: 'Нужен приватный ключ' };
  if (typeof password !== 'string' || password.length < 8) return { error: 'Пароль минимум 8 символов' };
  const derived = ecdsa.addressFromPrivate(privateKeyHex);
  if (!derived) return { error: 'Неверный приватный ключ' };
  const enc     = encryptKey(privateKeyHex, password);
  const wallets = loadWallets();
  wallets[derived.address] = { address: derived.address, publicKey: derived.publicKey, encrypted: enc, label: label || '', createdAt: Date.now() };
  saveWallets(wallets);
  return { address: derived.address, publicKey: derived.publicKey, token: createSession(derived.address), label: label || '' };
}

function restoreFromMnemonic(phrase, password, label) {
  if (typeof phrase !== 'string' || !mn.validateMnemonic(phrase)) return { error: 'Неверная мнемоническая фраза (12 слов)' };
  if (typeof password !== 'string' || password.length < 8) return { error: 'Пароль минимум 8 символов' };
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  const seed = mn.mnemonicToSeed(normalized);
  const kp = ecdsa.deriveKeyPairFromSeed(seed);
  if (!kp) return { error: 'Не удалось восстановить кошелёк из мнемоника' };
  const enc = encryptKey(kp.privateKey, password);
  const encMn = encryptKey(normalized, password);
  const wallets = loadWallets();
  const existing = wallets[kp.address] || {};
  wallets[kp.address] = {
    address: kp.address,
    publicKey: kp.publicKey,
    encrypted: enc,
    mnemonic: encMn,
    label: label || existing.label || '',
    createdAt: existing.createdAt || Date.now()
  };
  saveWallets(wallets);
  return { address: kp.address, publicKey: kp.publicKey, token: createSession(kp.address), label: label || '' };
}

function login(address, password) {
  const wallets = loadWallets();
  const w = wallets[address];
  if (!w) return { error: 'Кошелёк не найден' };
  const privateKey = decryptKey(w.encrypted, password);
  if (!privateKey) return { error: 'Неверный пароль' };
  return { address, publicKey: w.publicKey, privateKey, token: createSession(address), label: w.label };
}

function getWalletInfo(address) {
  const w = loadWallets()[address];
  if (!w) return null;
  return { address: w.address, publicKey: w.publicKey, label: w.label, createdAt: w.createdAt };
}

function getPrivateKey(address, password) {
  const w = loadWallets()[address];
  if (!w) return null;
  return decryptKey(w.encrypted, password);
}

function getMnemonic(address, password) {
  const w = loadWallets()[address];
  if (!w || !w.mnemonic) return null;
  return decryptKey(w.mnemonic, password);
}

module.exports = {
  register, importWallet, restoreFromMnemonic, login,
  createSession, verifySession, deleteSession,
  getSessionFromReq, parseCookies,
  getWalletInfo, getPrivateKey, getMnemonic, loadWallets
};
