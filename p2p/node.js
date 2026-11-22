// p2p/node.js — P2P синхронизация между нодами
'use strict';
const http = require('http');
const fs   = require('fs');
const bc   = require('../blockchain');

const PEERS_FILE    = 'peers.json';
const SYNC_INTERVAL = 10_000; // ms между циклами синхронизации
const MAX_PEERS     = 50;     // максимум пиров
const REQ_TIMEOUT   = 4_000;  // таймаут запроса к пиру

// Bootstrap peers — всегда стартуем с главной ноды.
// Добавь сюда все известные стабильные ноды сети.
const BOOTSTRAP_PEERS = [
  'http://95.163.226.148:3001'
];

// ─── Хранение пиров ──────────────────────────────────────────────────────────
function loadPeers() {
  let peers = [];
  if (fs.existsSync(PEERS_FILE)) {
    try { peers = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8')); } catch {}
  }
  // Bootstrap только если peers.json пуст — чтобы главный сервер не добавлял себя
  const base = peers.length > 0 ? peers : BOOTSTRAP_PEERS;
  return [...new Set(base)].filter(isValidPeerUrl).slice(0, MAX_PEERS);
}

function savePeers(peers) {
  const clean = [...new Set(peers)].slice(0, MAX_PEERS);
  fs.writeFileSync(PEERS_FILE, JSON.stringify(clean, null, 2));
}

function isValidPeerUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname || url.hostname === 'localhost' || url.hostname === '127.0.0.1') return false;
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
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
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
  if (myApiPort) {
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

    const validation = bc.validateChain(peerChain.chain);
    if (!validation.ok) {
      console.log(`⚠️  P2P: невалидная цепочка от ${peerUrl}: ${validation.reason} (блок ${validation.index})`);
      return false;
    }

    if (peerChain.chain.length > data.chain.length) {
      // Пересчитываем балансы с нуля — не доверяем данным пира
      const newData = { chain: peerChain.chain, mempool: data.mempool, wallets: {} };
      for (const block of newData.chain) bc.applyBlock(newData, block);

      // Удаляем из mempool транзакции уже включённые в новую цепь
      const txInChain = new Set(newData.chain.flatMap(b => b.transactions.map(t => t.id)));
      newData.mempool = newData.mempool.filter(t => !txInChain.has(t.id));

      _dm.save(newData); // обновляет и кэш и файл
      console.log(`✅ P2P: синхронизировано ${newData.chain.length} блоков`);
      return true;
    }
  }

  // Синхронизируем mempool
  const peerMempool = await peerRequest(peerUrl, '/mempool');
  if (peerMempool?.mempool) {
    const data2  = _dm.load();
    const ownIds = new Set(data2.mempool.map(t => t.id));
    let added = 0;
    for (const tx of peerMempool.mempool) {
      if (!ownIds.has(tx.id)) {
        const err = bc.validateTx(tx, data2.wallets, data2.mempool);
        if (!err) { data2.mempool.push(tx); added++; }
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

  setInterval(async () => {
    for (const peer of loadPeers()) {
      try { await syncWithPeer(peer, myApiPort); } catch {}
    }
  }, SYNC_INTERVAL);
}

module.exports = {
  loadPeers, savePeers, addPeer, isValidPeerUrl,
  syncWithPeer, announceBlock, startSync, setDataManager,
  BOOTSTRAP_PEERS, MAX_PEERS
};
