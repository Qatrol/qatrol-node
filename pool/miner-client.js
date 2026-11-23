#!/usr/bin/env node
// Qatrol Coin — Pool Miner Client (multi-threaded, persistent workers)
'use strict';

const crypto  = require('crypto');
const os      = require('os');
const { Worker, isMainThread, parentPort, workerData,
        receiveMessageOnPort, MessageChannel } = require('worker_threads');

const VERSION = '1.2.1';

// Зашивается при сборке
const EMBEDDED_POOL = '__QTR_POOL_HOST__';

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER THREAD — запускается один раз, работает непрерывно
// ═══════════════════════════════════════════════════════════════════════════════
if (!isMainThread) {
  const { port, initialJob, startNonce } = workerData;

  let { target, template, jobId } = initialJob;
  let blockTarget = '0'.repeat(template.difficulty); // полная сложность блока
  let nonce  = (startNonce >>> 0);
  let count  = 0;
  let t0     = Date.now();
  const CHECK_MSG_EVERY = 10_000;  // проверяем новое задание каждые 10k хэшей
  const REPORT_EVERY    = 200_000; // репортим хэшрейт каждые 200k хэшей

  // Самоограничение шар: минимум difficulty 5 чтобы не флудить при высоком хэшрейте.
  // Блоки (полная сложность) всегда передаются немедленно.
  // Шары (selfTarget) — не чаще чем нужно для статистики.
  let selfTarget = target; // обновляется с заданием

  function buildParts(tpl) {
    return {
      pre: `{"index":${tpl.index},"prevHash":"${tpl.prevHash}","timestamp":${tpl.timestamp},"transactions":${JSON.stringify(tpl.transactions)},"nonce":`,
      suf: `,"difficulty":${tpl.difficulty}}`
    };
  }

  let { pre, suf } = buildParts(template);

  while (true) {
    // ─── Проверка нового задания (синхронно, без yield) ───────────────────────
    if (count % CHECK_MSG_EVERY === 0 && count > 0) {
      const msg = receiveMessageOnPort(port);
      if (msg) {
        if (msg.message.type === 'newJob') {
          ({ target, template, jobId } = msg.message.job);
          blockTarget = '0'.repeat(template.difficulty);
          selfTarget  = target; // сбрасываем при новом задании
          ({ pre, suf } = buildParts(template));
          nonce = (Math.random() * 0xFFFFFFFF) >>> 0;
          count = 0; t0 = Date.now();
        } else if (msg.message.type === 'selfTarget') {
          selfTarget = msg.message.selfTarget;
        } else if (msg.message.type === 'stop') {
          break;
        }
      }
    }

    // ─── Хэш ─────────────────────────────────────────────────────────────────
    const h = crypto.createHash('sha256').update(pre + nonce + suf).digest('hex');

    if (h.startsWith(blockTarget)) {
      // БЛОК — немедленно сообщаем с флагом isBlock
      const elapsed = (Date.now() - t0) / 1000 || 0.001;
      parentPort.postMessage({ type: 'found', nonce, hash: h, jobId, isBlock: true,
                               hr: Math.round(count / elapsed) });
      count = 0; t0 = Date.now();
    } else if (h.startsWith(selfTarget)) {
      // Шара (не блок)
      const elapsed = (Date.now() - t0) / 1000 || 0.001;
      parentPort.postMessage({ type: 'found', nonce, hash: h, jobId, isBlock: false,
                               hr: Math.round(count / elapsed) });
      count = 0; t0 = Date.now();
    }

    nonce = (nonce + 1) >>> 0;
    count++;

    // ─── Репорт хэшрейта ──────────────────────────────────────────────────────
    if (count % REPORT_EVERY === 0) {
      const elapsed = (Date.now() - t0) / 1000 || 0.001;
      parentPort.postMessage({ type: 'hashrate', hr: Math.round(REPORT_EVERY / elapsed) });
      t0 = Date.now(); count = 0;
    }
  }
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN THREAD
// ═══════════════════════════════════════════════════════════════════════════════
const http     = require('http');
const readline = require('readline');

function resolveDefaultPool() {
  if (process.env.QTR_POOL) return process.env.QTR_POOL;
  if (EMBEDDED_POOL && EMBEDDED_POOL.includes(':')) return EMBEDDED_POOL;
  return 'localhost:3002';
}

const DEFAULT_POOL = resolveDefaultPool();
const NUM_THREADS  = Math.max(1, parseInt(process.env.QTR_THREADS || '') || os.cpus().length);

let poolHost    = '';
let poolPort    = 3002;
let myAddress   = '';
let mining      = true;
let currentJob  = null;
let totalShares = 0;
let startTime   = Date.now();

const threadHR  = new Array(NUM_THREADS).fill(0);
function totalHashrate() { return threadHR.reduce((a, b) => a + b, 0); }

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const Y = s => `\x1b[93m${s}\x1b[0m`;
const G = s => `\x1b[92m${s}\x1b[0m`;
const C = s => `\x1b[96m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const R = s => `\x1b[91m${s}\x1b[0m`;
function clearScr() { process.stdout.write('\x1b[2J\x1b[H'); }

function fmtHash(h) {
  if (h >= 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
  if (h >= 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
  if (h >= 1e3) return (h / 1e3).toFixed(1) + ' kH/s';
  return h + ' H/s';
}

function uptime() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}

function renderDashboard() {
  const w  = Math.min(process.stdout.columns || 60, 72);
  const hr = '─'.repeat(w);
  clearScr();
  console.log('');
  console.log(Y('  ◆  QATROL COIN (QTR) — POOL MINER  ◆'));
  console.log(D(`  v${VERSION}  |  ${os.hostname()}  |  ${NUM_THREADS} потоков`));
  console.log('');
  console.log(D(hr));
  console.log('');
  console.log(`  ${Y('Пул:')}      ${poolHost}:${poolPort}`);
  console.log(`  ${Y('Адрес:')}    ${myAddress}`);
  console.log('');
  console.log(D(hr));
  console.log('');
  console.log(`  ${Y('Шары:')}     ${G(String(totalShares))}`);
  console.log(`  ${Y('Hashrate:')} ${C(fmtHash(totalHashrate()))}`);
  const hrLine = threadHR.map(h => C(fmtHash(h))).join(D(' | '));
  console.log(`  ${Y('Потоки:')}   ${hrLine}`);
  console.log(`  ${Y('Аптайм:')}   ${uptime()}`);
  console.log(`  ${Y('Задание:')}  ${currentJob
    ? `#${currentJob.jobId} (блок #${currentJob.index})`
    : D('ожидание...')}`);
  console.log('');
  console.log(D(hr));
  console.log(D('  Ctrl+C — остановить'));
  console.log('');
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

function poolRequest(path, method = 'GET', body = null) {
  return new Promise(resolve => {
    const opts = {
      hostname: poolHost, port: poolPort, path, method,
      headers: { 'Content-Type': 'application/json' }, timeout: 5000
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
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Управление воркерами ─────────────────────────────────────────────────────
let workerList   = []; // { worker, port }
let sharesBusy   = false; // идёт ли отправка обычной шары
let blockPending = false; // идёт ли отправка блока

// Адаптивный self-target: целимся на 1-2 шары/сек на поток
// log16(hashrate) = log(hashrate)/log(16)
function calcSelfDiff(hr) {
  if (hr <= 0) return 3;
  const d = Math.ceil(Math.log(hr) / Math.log(16));
  return Math.max(3, Math.min(d, 10)); // минимум 3, максимум 10
}

function updateSelfTargets() {
  const hr = totalHashrate();
  if (hr < 1_000_000) return; // < 1 MH/s — оставляем дефолт
  const perThread = Math.ceil(hr / NUM_THREADS);
  const diff = calcSelfDiff(perThread);
  const t = '0'.repeat(diff);
  for (const { port } of workerList) {
    port.postMessage({ type: 'selfTarget', selfTarget: t });
  }
}

async function doSubmit(nonce, jobId, isBlock) {
  const payload = { address: myAddress, nonce, jobId, hashrate: totalHashrate() };
  // Блок — это деньги: при обрыве связи повторяем, а не выбрасываем.
  const attempts = isBlock ? 5 : 1;
  let result = null;
  for (let i = 0; i < attempts; i++) {
    result = await poolRequest('/pool/submit', 'POST', payload);
    if (result) break;
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  if (!result) {
    console.log(R(`\n  ❌ ${isBlock ? 'Блок найден, но пул не ответил' : 'Шара не отправлена'} — связь с пулом потеряна\n`));
    return;
  }
  if (!result.accepted && result.reason && result.reason !== 'duplicate share') {
    console.log(D(`\n  ↩ ${isBlock ? 'Блок' : 'Шара'} отклонены пулом: ${result.reason}\n`));
  }

  if (result.accepted) {
    totalShares++;
    renderDashboard();
    if (result.isBlock || isBlock) {
      console.log(G('\n  🎯 БЛОК НАЙДЕН! Награда начислена!\n'));
      await sleep(1500);
    }
    if (result.newJob && result.newJob.jobId !== currentJob?.jobId) {
      currentJob = result.newJob;
      sendJobToWorkers(result.newJob);
    }
  }
}

function spawnWorkers(job) {
  for (let i = 0; i < NUM_THREADS; i++) createWorker(i, job);
}

function createWorker(idx, job) {
  {
    const { port1, port2 } = new MessageChannel();
    const startNonce = (Math.random() * 0xFFFFFFFF) >>> 0;
    const w = new Worker(__filename, {
      workerData: { port: port2, initialJob: job, startNonce },
      transferList: [port2]
    });
    w.on('message', msg => {
      if (msg.type === 'hashrate') {
        threadHR[idx] = msg.hr;
        renderDashboard();
        updateSelfTargets(); // корректируем сложность шар под хэшрейт
        return;
      }
      if (msg.type !== 'found') return;
      if (msg.hr) { threadHR[idx] = msg.hr; }
      if (msg.jobId !== currentJob?.jobId) return; // устаревшая шара — игнор

      if (msg.isBlock) {
        // ── БЛОК: отправляем немедленно, не ждём sharesBusy ──────────────────
        if (!blockPending) {
          blockPending = true;
          doSubmit(msg.nonce, msg.jobId, true)
            .catch(e => console.error('block submit:', e.message))
            .finally(() => { blockPending = false; });
        }
      } else {
        // ── Шара: только если не занята отправка предыдущей ──────────────────
        if (!sharesBusy) {
          sharesBusy = true;
          doSubmit(msg.nonce, msg.jobId, false)
            .catch(e => console.error('share submit:', e.message))
            .finally(() => { sharesBusy = false; });
        }
        // иначе — просто пропускаем. hashrate нам важнее статистики шар
      }
    });
    w.on('error', err => console.error(`\nWorker #${idx}: ${err.message}`));
    // Умерший поток раньше просто снижал хэшрейт, а дашборд врал про аптайм.
    w.on('exit', code => {
      if (!mining || code === 0) return;
      console.error(R(`\n  ⚠ Поток #${idx} упал (код ${code}), перезапускаю…`));
      threadHR[idx] = 0;
      setTimeout(() => { if (mining) createWorker(idx, currentJob); }, 2000);
    });
    workerList.push({ worker: w, port: port1 });
  }
}

function sendJobToWorkers(job) {
  for (const { port } of workerList) {
    port.postMessage({ type: 'newJob', job });
  }
}

function stopWorkers() {
  for (const { port, worker } of workerList) {
    try { port.postMessage({ type: 'stop' }); } catch {}
    worker.terminate();
  }
  workerList = [];
  threadHR.fill(0);
}

// ─── Основной цикл ────────────────────────────────────────────────────────────
async function run() {
  // Получаем первое задание и запускаем воркеры
  let job = null;
  let poolDownLogged = false;
  while (!job) {
    const res = await poolRequest('/pool/job', 'POST', { address: myAddress });
    if (res?.job) { job = res.job; if (poolDownLogged) console.log(G('\n  ✅ Пул снова на связи')); }
    else {
      if (!poolDownLogged) { console.log(R('\n  ❌ Пул недоступен. Повторяю каждые 5 секунд...')); poolDownLogged = true; }
      await sleep(5000);
    }
  }
  currentJob = job;
  renderDashboard();
  spawnWorkers(job);

  // Обновление задания каждые 10 сек (синхронно с сервером)
  let misses = 0;
  while (mining) {
    await sleep(10_000);
    if (!mining) break;
    const res = await poolRequest('/pool/job', 'POST', { address: myAddress });
    if (!res?.job) {
      misses++;
      if (misses === 3 || misses % 12 === 0) {
        console.log(R(`\n  ⚠ Пул не отвечает (${misses} попыток подряд) — майнер работает на старом задании\n`));
      }
      continue;
    }
    if (misses > 0) { console.log(G('\n  ✅ Пул снова на связи\n')); misses = 0; }
    if (res.job.jobId !== currentJob?.jobId) {
      currentJob = res.job;
      sendJobToWorkers(res.job);
      renderDashboard();
    }
  }

  stopWorkers();
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
(async () => {
  process.stdout.write('\x1b[?25l');
  process.on('SIGINT', () => {
    process.stdout.write('\x1b[?25h');
    mining = false;
    stopWorkers();
    console.log('\n\n  Остановлено.\n');
    process.exit(0);
  });

  console.log('\n' + Y('  ◆  QATROL COIN POOL MINER  ◆') + '\n');
  console.log(D(`  CPU: ${os.cpus()[0]?.model || 'unknown'}`));
  console.log(D(`  Ядра: ${os.cpus().length}  →  Потоки: ${NUM_THREADS}\n`));

  const addrArg = process.argv[2];
  if (addrArg && addrArg.startsWith('K')) {
    myAddress = addrArg;
  } else {
    myAddress = await prompt('  Введи адрес кошелька QTR (начинается с K):\n  > ');
    if (!myAddress.startsWith('K')) {
      console.log(R('  ❌ Неверный адрес')); process.exit(1);
    }
  }

  const poolArg = process.argv[3] || DEFAULT_POOL;
  const parts   = poolArg.split(':');
  poolHost = parts[0];
  poolPort = parseInt(parts[1] || '3002');

  console.log(`\n  ${G('✓')} Адрес:   ${myAddress}`);
  console.log(`  ${G('✓')} Пул:     ${poolHost}:${poolPort}`);
  console.log(`  ${G('✓')} Потоки:  ${NUM_THREADS}`);
  console.log(`\n  Подключаемся...\n`);

  await sleep(800);
  await run();
})();
