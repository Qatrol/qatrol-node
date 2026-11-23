// ecosystem.config.js — pm2 конфиг для Qatrol Coin
// Запуск: pm2 start ecosystem.config.js
// Обновление: pm2 reload ecosystem.config.js --update-env
'use strict';
const path = require('path');
// Все пути — от каталога конфига, а не от /root: репозиторий можно положить куда угодно.
// .env ищется рядом с конфигом; если dotenv не установлен — переменные берутся из pm2.
try { require('dotenv').config({ path: process.env.QTR_ENV_FILE || path.join(__dirname, '.env') }); }
catch { /* dotenv опционален */ }

const env = {
  QTR_PORT:              process.env.QTR_PORT              || '3001',
  QTR_WEB_PORT:          process.env.QTR_WEB_PORT          || '3000',
  QTR_POOL_PORT:         process.env.QTR_POOL_PORT         || '3002',
  QTR_API_HOST:          process.env.QTR_API_HOST          || '127.0.0.1',
  QTR_POOL_API_KEY:      process.env.QTR_POOL_API_KEY      || '',
  QTR_POOL_ADDRESS:      process.env.QTR_POOL_ADDRESS      || '',
  QTR_POOL_PRIVATE_KEY:  process.env.QTR_POOL_PRIVATE_KEY  || '',
  QTR_MINER_ADDRESS:     process.env.QTR_MINER_ADDRESS     || '',
  QTR_MINER_PRIVATE_KEY: process.env.QTR_MINER_PRIVATE_KEY || '',
  QTR_BOT_TOKEN:         process.env.QTR_BOT_TOKEN         || '',
  QTR_BOT_POLLING_INTERVAL_MS: process.env.QTR_BOT_POLLING_INTERVAL_MS || '1500',
  QTR_PUBLIC_URL:        process.env.QTR_PUBLIC_URL        || '',
  QTR_POOL_BUILD_HOST:   process.env.QTR_POOL_BUILD_HOST   || '',
  QTR_MINER_RELEASE_URL: process.env.QTR_MINER_RELEASE_URL || '',
  QTR_BOT_PROXY:         process.env.QTR_BOT_PROXY         || '',
  NODE_OPTIONS:          '--dns-result-order=ipv4first',
};

module.exports = {
  apps: [
    {
      name: 'qtr-node',
      script: path.join(__dirname, 'miner.js'),
      cwd: __dirname,
      env,
      restart_delay: 5000,
      max_restarts: 999,
      min_uptime: '10s',
    },
    {
      name: 'qtr-pool',
      script: path.join(__dirname, 'pool', 'server.js'),
      cwd: __dirname,
      env,
      restart_delay: 5000,
      max_restarts: 999,
      min_uptime: '10s',
    },
    {
      name: 'qtr-web',
      script: path.join(__dirname, 'server.js'),
      cwd: __dirname,
      env,
      restart_delay: 3000,
      max_restarts: 999,
      min_uptime: '5s',
    },
    {
      name: 'qtr-bot',
      script: path.join(__dirname, 'bot', 'index.js'),
      cwd: __dirname,
      env,
      restart_delay: 8000,
      max_restarts: 999,
      min_uptime: '10s',
    },
  ],
};
