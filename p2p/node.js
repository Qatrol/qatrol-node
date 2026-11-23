// p2p/node.js — P2P синхронизация между нодами
'use strict';
const http = require('http');
const fs   = require('fs');
const bc   = require('../blockchain');
const { readJson, writeJsonAtomic } = require('../lib/storage');

const PEERS_FILE    = require('path').join(__dirname, '..', 'peers.json');
const SYNC_INTERVAL = 10_000; // ms между циклами синхронизации
const MAX_PEERS     = 50;     // максимум пиров
const REQ_TIMEOUT   = 4_000;  // таймаут запроса к пиру
const MAX_RESPONSE  = 4 * 1024 * 1024; // больше — обрываем: пир может отдать гигабайты

// Bootstrap-пиры задаются через QTR_BOOTSTRAP_PEERS (через запятую).
// Раньше здесь был захардкожен адрес одной частной ноды: каждая свежая
// установка пыталась синхронизироваться с чужим сервером.
const BOOTSTRAP_PEERS = (process.env.QTR_BOOTSTRAP_PEERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── Хранение пиров ──────────────────────────────────────────────────────────
function loadPeers() {
  let peers = [];
  try {
    peers = readJson(PEERS_FILE).data || [];
  } catch (err) {
    // Битый peers.json — не повод падать: список пиров восстановим.
    // readJson уже сохранил копию .corrupt-<ts>.
    console.error('peers.json повреждён, список пиров сброшен:', err.message);
    peers = [];
  }
  // Bootstrap добавляем к своим пирам, а не вместо них
  const base = [...peers, ...BOOTSTRAP_PEERS];
  return [...new Set(base)].filter(isValidPeerUrl).slice(0, MAX_PEERS);
}

function savePeers(peers) {
  const clean = [...new Set(peers)].slice(0, MAX_PEERS);
  try { writeJsonAtomic(PEERS_FILE, clean); }
  catch (err) { console.error('Не удалось сохранить peers.json:', err.message); }
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

  // IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224+
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // Числовые формы вида 2130706433 уже отсекаются: это не hostname с точками
  if (/^\d+$/.test(h)) return true;
  // IPv6: loopback, link-local, ULA, "::"
  if (h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

function isValidPeerUrl(u) {
  try {
    const url = new URL(u);
    // peerRequest ходит только по http; https-пиры раньше молча не работали
    if (url.protocol !== 'http:') return false;
    if (!url.hostname) return false;
    if (isPrivateHost(url.hostname)) return false;
    const port = Number(url.port || 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    // Не добавляем себя
    const myHost = process.env.QTR_PUBLIC_HOST;
    if (myHost && url.hostname === myHost) return false;
    return true;
  } catch { return false; }
}

function addPeer(addr) {
  if (!isValidPeerUrl(addr)) return false;
  const peers = loadPeers();
  if (peers.includes(addr)) return false;
  if (peers.length >= MAX_PEERS) return false;
  peers.push(addr);
  savePeers(peers);
  return true;
}

// ─── HTTP к пиру ─────────────────────────────────────────────────────────────
function peerRequest(peerUrl, path, method = 'GET', body = null) {
  return new Promise(resolve => {
    try {
      const url  = new URL(peerUrl);
      const opts = {
        hostname: url.hostname, port: url.port || 3001,
        path, method,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQ_TIMEOUT
      };
      const req = http.request(opts, res => {
        let data = '';
        let tooBig = false;
        res.on('data', c => {
          if (tooBig) return;
          data += c;
          if (data.length > MAX_RESPONSE) { tooBig = true; data = ''; req.destroy(); resolve(null); }
        });
        res.on('end', () => {
          if (tooBig) return;
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch { resolve(null); }
  });
}

// ─── Менеджер данных (внедряется из miner.js чтобы использовать кэш) ──────────
// По умолчанию — прямые вызовы blockchain.js (для автономного использования)
let _dm = {
  load: () => bc.load(),
  save: (data) => bc.save(data)
};
function setDataManager(dm) { _dm = dm; }

// ─── Синхронизация с одним пиром ─────────────────────────────────────────────
async function syncWithPeer(peerUrl, myApiPort) {
  const peerStats = await peerRequest(peerUrl, '/stats');
  if (!peerStats || !peerStats.blocks) return false;

  // Обменяться пирами (gossip)
  if (myApiPort && process.env.QTR_PUBLIC_HOST) {
    const myUrl = `http://${getMyPublicHost()}:${myApiPort}`;
    await peerRequest(peerUrl, '/peers/add', 'POST', { url: myUrl });
    const theirPeers = await peerRequest(peerUrl, '/peers');
    if (theirPeers?.peers) {
      for (const p of theirPeers.peers) {
        if (isValidPeerUrl(p) && p !== myUrl) addPeer(p);
      }
    }
  }

  const data = _dm.load();
  if (!data) return false;

  if (peerStats.blocks > data.chain.length) {
    console.log(`🔗 P2P: ${peerUrl} — ${peerStats.blocks} блоков (у нас ${data.chain.length}), синхронизируем...`);
    const peerChain = await peerRequest(peerUrl, '/chain/p2p');
    if (!peerChain?.chain) return false;

    if (peerChain.chain.length > data.chain.length) {
      // importChain сверяет genesis, структуру, PoW, сложность и каждую
      // транзакцию; балансы пересчитываются с нуля.
      const imported = bc.importChain(peerChain.chain);
      if (imported.error) {
        console.log(`⚠️  P2P: цепь от ${peerUrl} отклонена: ${imported.error}`);
        return false;
      }
      const newData = imported.data;
      newData.mempool = data.mempool || [];

      // Удаляем из mempool транзакции уже включённые в новую цепь
      const txInChain = new Set(newData.chain.flatMap(b => (b.transactions || []).map(t => t.id)));
      newData.mempool = newData.mempool.filter(t => !txInChain.has(t.id));

      _dm.save(newData); // обновляет и кэш и файл
      console.log(`✅ P2P: синхронизировано ${newData.chain.length} блоков`);
      return true;
    }
  }

  // Синхронизируем mempool
  const peerMempool = await peerRequest(peerUrl, '/mempool');
  if (peerMempool?.mempool && Array.isArray(peerMempool.mempool)) {
    const data2  = _dm.load();
    if (!data2 || !Array.isArray(data2.mempool)) return false;
    const ownIds = new Set(data2.mempool.map(t => t.id));
    let added = 0;
    for (const tx of peerMempool.mempool) {
      if (data2.mempool.length >= 1000) break; // защита от заваливания мемпула
      if (!ownIds.has(tx.id)) {
        const err = bc.validateTx(tx, data2.wallets, data2.mempool);
        if (!err) { data2.mempool.push(tx); ownIds.add(tx.id); added++; }
      }
    }
    if (added > 0) { _dm.save(data2); console.log(`📨 P2P: +${added} транзакций из mempool`); }
  }

  return false;
}

// ─── Broadcast нового блока всем пирам ───────────────────────────────────────
async function announceBlock(block) {
  const peers = loadPeers();
  const results = await Promise.allSettled(
    peers.map(peer => peerRequest(peer, '/block/push', 'POST', { block }))
  );
  const ok = results.filter(r => r.status === 'fulfilled' && r.value?.accepted).length;
  if (peers.length > 0) console.log(`📡 P2P: блок #${block.index} анонсирован ${ok}/${peers.length} пирам`);
}

// ─── Определить свой публичный хост ──────────────────────────────────────────
let _myHost = null;
function getMyPublicHost() {
  if (_myHost) return _myHost;
  _myHost = process.env.QTR_PUBLIC_HOST || 'localhost';
  return _myHost;
}

// ─── Запуск периодической синхронизации ──────────────────────────────────────
function startSync(myApiPort, dataManager) {
  if (dataManager) setDataManager(dataManager);
  const peers = loadPeers();
  if (peers.length > 0) console.log(`🌐 P2P: пиры: ${peers.join(', ')}`);

  // Без флага циклы накладывались друг на друга при медленных пирах:
  // 50 пиров × 4 с таймаута при интервале 10 с = десятки параллельных проходов.
  let syncing = false;
  setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try {
      for (const peer of loadPeers()) {
        try { await syncWithPeer(peer, myApiPort); }
        catch (e) { console.log(`⚠️  P2P: синхронизация с ${peer} упала: ${e.message}`); }
      }
    } finally {
      syncing = false;
    }
  }, SYNC_INTERVAL);
}

module.exports = {
  loadPeers, savePeers, addPeer, isValidPeerUrl,
  syncWithPeer, announceBlock, startSync, setDataManager,
  BOOTSTRAP_PEERS, MAX_PEERS
};
