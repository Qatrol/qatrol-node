// tui/dashboard.js — ANSI терминальный дашборд
'use strict';

const ESC      = '\x1b';
const R        = `${ESC}[0m`;
const BOLD     = s => `${ESC}[1m${s}${R}`;
const DIM      = s => `${ESC}[2m${s}${R}`;
const CYAN     = s => `${ESC}[96m${s}${R}`;
const GREEN    = s => `${ESC}[92m${s}${R}`;
const YELLOW   = s => `${ESC}[93m${s}${R}`;
const MAGENTA  = s => `${ESC}[95m${s}${R}`;

function clear() { process.stdout.write(`${ESC}[2J${ESC}[H`); }
function hideCursor() { process.stdout.write(`${ESC}[?25l`); }
function showCursor() { process.stdout.write(`${ESC}[?25h`); }

function fmtHash(h) {
  if (h > 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
  if (h > 1e3) return (h / 1e3).toFixed(1) + ' kH/s';
  return (h || 0) + ' H/s';
}

function uptime(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}

function hashBar(hr, width = 24) {
  const pct    = Math.min(1, (hr || 0) / 500_000);
  const filled = Math.round(pct * width);
  return CYAN('█'.repeat(filled) + '░'.repeat(width - filled)) + ' ' + YELLOW(fmtHash(hr));
}

class Dashboard {
  constructor() {
    this.stats   = {};
    this.logs    = [];
    this.maxLogs = 8;
    this.started = Date.now();
    this.enabled = process.stdout.isTTY;
  }

  update(s) {
    this.stats = { ...this.stats, ...s };
    if (this.enabled) this.render();
  }

  log(msg) {
    const t = new Date().toLocaleTimeString('ru');
    this.logs.push(DIM(`[${t}]`) + ' ' + msg);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    if (!this.enabled) {
      console.log(`[${t}] ${msg.replace(/\x1b\[[0-9;]*m/g, '')}`);
    } else {
      this.render();
    }
  }

  render() {
    const w  = process.stdout.columns || 80;
    const hr = '─'.repeat(w);
    const s  = this.stats;
    const lines = [
      '',
      BOLD(CYAN('  КOIN BLOCKCHAIN MINER v2.0')),
      '',
      DIM(hr),
      '',
      '  ' + BOLD('Блок: ')      + YELLOW(String(s.block || '—').padEnd(6)) +
      '  '  + BOLD('Сложность: ') + CYAN(String(s.difficulty || '—').padEnd(4)) +
      '  '  + BOLD('В пуле: ')   + GREEN(String(s.pending || 0)) + ' тр.',
      '',
      '  ' + BOLD('Аптайм: ')   + YELLOW(uptime(this.started)) +
      '  '  + BOLD('Блоков: ')   + CYAN(String(s.blocksFound || 0)) +
      '  '  + BOLD('Баланс: ')   + GREEN(String((s.balance || 0).toFixed(4)) + ' КOIN'),
      '',
      '  ' + BOLD('Hashrate: ') + hashBar(s.hashrate || 0),
      '',
      '  ' + BOLD('Адрес: ') + DIM(s.address || '—'),
      '',
      DIM(hr),
      '',
      s.mining
        ? '  ' + MAGENTA('⛏  Майним #' + s.block) + '  ' + DIM('nonce: ' + (s.nonce || 0).toLocaleString())
        : '  ' + DIM('⏸  Ожидание...'),
      '',
      DIM(hr),
      '',
      '  ' + BOLD('Лог:'),
      ...(this.logs.length ? this.logs.map(l => '  ' + l) : ['  ' + DIM('...')]),
      '',
      DIM(hr),
      '  ' + DIM('Ctrl+C — стоп  ·  API: http://localhost:3001'),
      ''
    ];
    clear();
    process.stdout.write(lines.join('\n'));
  }

  start() {
    if (!this.enabled) return;
    hideCursor();
    process.on('exit', () => showCursor());
    process.on('SIGINT', () => { showCursor(); process.exit(0); });
  }
}

module.exports = { Dashboard };
