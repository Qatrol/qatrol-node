// logger.js — Qatrol Coin централизованное логирование
'use strict';
const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, 'logs');
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB → rotate

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

/**
 * @param {string} name  — имя компонента (miner / bot / pool / p2p …)
 * @param {{ printToConsole?: boolean }} opts
 *   printToConsole = true  → дублировать в stdout/stderr
 *   printToConsole = false → только в файл (для TUI-режима майнера)
 */
function createLogger(name, { printToConsole = true } = {}) {
  const file = path.join(LOG_DIR, `${name}.log`);

  function write(level, ...args) {
    const ts  = new Date().toISOString();
    const msg = args.map(a => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');

    const line = `[${ts}] [${level.padEnd(5)}] [${name}] ${msg}\n`;

    // ── File ────────────────────────────────────────────────────────────────
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_SIZE) {
        const old = file + '.1';
        try { fs.unlinkSync(old); } catch {}
        fs.renameSync(file, old);
      }
      fs.appendFileSync(file, line);
    } catch { /* ignore I/O errors — never crash on logging */ }

    // ── Console (optional) ──────────────────────────────────────────────────
    if (printToConsole) {
      if (level === 'ERROR') process.stderr.write(line);
      else process.stdout.write(line);
    }
  }

  return {
    info:  (...a) => write('INFO',  ...a),
    warn:  (...a) => write('WARN',  ...a),
    error: (...a) => write('ERROR', ...a),
    debug: (...a) => write('DEBUG', ...a),
  };
}

module.exports = { createLogger, LOG_DIR };
