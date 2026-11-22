# ◆ Qatrol Coin (QTR)

Децентрализованная криптовалюта. Фиксированная эмиссия 1,000,000,000 QTR.

> Снимок с домашнего ПК от 22.11.2026, снят перед передачей машины. Код в том виде, в каком он лежал на диске: рабочая нода, сервер, пул, TUI и бот. Приватные ключи, токены и серверные пароли в репозиторий не попали.

## Быстрый старт (локально)

```bash
npm install
npm run start:node      # терминал 1 — нода + майнер
npm run start:web       # терминал 2 — веб-сайт
# http://localhost:3000
```

## Пул майнеров

```bash
# Запустить пул (нужна работающая нода)
npm run start:pool

# Клиент майнера (для пользователей)
npm run start:pool-miner -- ТВОЙ_АДРЕС localhost:3002
```

## Telegram бот

```bash
# Получи токен от @BotFather
QTR_BOT_TOKEN=123:ABC npm run start:bot
```

## Сборка .exe для Windows

```bash
npm install
npm run build:miner-client:win
# dist/qtr-pool-miner.exe
```

## Команды Telegram-бота

```bash
/start
/help
/address
/logout
/stats
/pool
/mempool
/block <index|hash>
/tx <id>
/search <query>
```

## Деплой на сервер (Ubuntu VPS)

```bash
# 1) Установить Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install nodejs

# 2) Клонировать и установить
git clone ... && cd qatrol && npm install

# 3) Создать .env (пример)
cat > .env <<'EOF'
QTR_PORT=3001
QTR_WEB_PORT=3000
QTR_POOL_PORT=3002
QTR_API_HOST=127.0.0.1
QTR_POOL_ADDRESS=K_ВАШ_АДРЕС_ПУЛА
QTR_POOL_API_KEY=CHANGE_ME_STRONG_KEY
QTR_POOL_PRIVATE_KEY=... # приватный ключ адреса пула (для auto payout)
# Для headless запуска ноды (выбери один вариант):
# QTR_MINER_PRIVATE_KEY=...
# QTR_MINER_MNEMONIC="word1 ... word12"
# QTR_MINER_ADDRESS=K...
EOF

# 4) PM2 для автозапуска
npm install -g pm2
set -a && . ./.env && set +a
pm2 start miner.js --name qtr-node --update-env
pm2 start server.js --name qtr-web --update-env
pm2 start pool/server.js --name qtr-pool --update-env
pm2 startup && pm2 save

# 5) Nginx конфиг
# /etc/nginx/sites-available/qatrol
server {
    server_name qatrol.com;
    location /api/ { proxy_pass http://127.0.0.1:3001/; }
    location /pool/ { proxy_pass http://127.0.0.1:3002/pool/; }
    location /     { proxy_pass http://localhost:3000/; }
}

# 6) SSL
certbot --nginx -d qatrol.com
```

### Майнинг с домашнего ПК через пул VPS

```bash
# На домашнем ПК
node pool/miner-client.js ТВОЙ_АДРЕС_КОШЕЛЬКА IP_ИЛИ_ДОМЕН_VPS:3002
```

Открой на VPS входящий порт `3002/tcp` в firewall/security-group.

## Переменные окружения

```bash
QTR_PORT=3001          # порт API ноды
QTR_WEB_PORT=3000      # порт веб-сервера
POOL_PORT=3002         # порт пула
QTR_API_HOST=localhost # хост API (на сервере — IP)
QTR_POOL_ADDRESS=...   # адрес пула для награды блока
QTR_POOL_API_KEY=...   # ключ для /pool/submit-block
QTR_POOL_PRIVATE_KEY=... # ключ кошелька пула для выплат участникам
QTR_MINER_PRIVATE_KEY=... # headless запуск ноды без prompts
QTR_MINER_MNEMONIC="..."  # или восстановление по мнемонику
QTR_MINER_ADDRESS=...     # или только адрес (без приватного ключа)
QTR_BOT_TOKEN=...      # токен Telegram бота
QTR_MINER_URL=...      # ссылка на скачивание майнера
QTR_BOT_PROXY=...      # HTTP/HTTPS proxy для Telegram бота (если Telegram ограничен)
QTR_BOT_POLLING_INTERVAL_MS=1200 # интервал polling бота
QTR_PUBLIC_URL=http://ТВОЙ_IP_или_домен     # ссылка «Сайт» в боте
QTR_POOL_BUILD_HOST=ТВОЙ_IP:3002            # хост:порт пула, вшивается в .exe из бота
QTR_PROJECT_ROOT=/path/to/qatrol            # корень проекта (если бот не из каталога репо)
QTR_MINER_BUILD_COOLDOWN_MS=600000          # не пересобирать exe чаще, чем раз в N мс
QTR_BOT_UPLOAD_TIMEOUT_MS=600000          # таймаут HTTP при отправке больших файлов в Telegram (прокси)
```

Прямая ссылка на майнер (если Telegram рвёт загрузку): после сборки exe открой  
`http://ТВОЙ_IP:3000/download/qtr-pool-miner.exe`  
(нужен `QTR_PUBLIC_URL` в боте для подстановки ссылки в сообщение).

Сборка публичного майнера с зашитым пулом (вручную):

```bash
QTR_POOL_BUILD_HOST=194.67.99.111:3002 npm run build:miner-win:embed
# → dist/qtr-pool-miner-public.exe
```

## Структура

```
blockchain.js          ядро цепочки
miner.js               нода + интерактивный майнер
server.js              веб-сервер
auth.js                авторизация AES-256-GCM
crypto/ecdsa.js        ECDSA P-256 подписи
crypto/mnemonic.js     BIP-39 мнемоник
p2p/node.js            P2P синхронизация
pool/server.js         пул майнеров
pool/miner-client.js   клиент пула (скачивают пользователи)
tui/dashboard.js       TUI дашборд в терминале
bot/index.js           Telegram бот
public/                веб-интерфейс
```
