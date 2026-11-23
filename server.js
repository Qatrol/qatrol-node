'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = parseInt(process.env.QTR_WEB_PORT || '3000');
const MINER_API = {
  hostname: process.env.QTR_API_HOST || '127.0.0.1',
  port: parseInt(process.env.QTR_PORT || '3001')
};
const POOL_API = {
  hostname: process.env.QTR_POOL_HOST || '127.0.0.1',
  port: parseInt(process.env.QTR_POOL_PORT || process.env.POOL_PORT || '3002')
};

const MAX_PROXY_BODY = 1024 * 1024;   // нода и так режет на 1 МБ, не копим больше здесь
const MAX_PROXY_RESP = 16 * 1024 * 1024;
const PROXY_TIMEOUT  = 10_000;

function proxyMiner(req, res, targetPath) {
  return new Promise(resolve => {
    const opts = {
      ...MINER_API,
      path: targetPath,
      method: req.method,
      timeout: PROXY_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': req.headers.cookie || '',
        'X-Session-Token': req.headers['x-session-token'] || ''
      }
    };
    const proxy = http.request(opts, proxyRes => {
      let d = '';
      let tooBig = false;
      proxyRes.on('data', c => {
        if (tooBig) return;
        d += c;
        if (d.length > MAX_PROXY_RESP) { tooBig = true; proxyRes.destroy(); }
      });
      proxyRes.on('end', () => {
        if (tooBig) { res.writeHead(502); res.end('{"error":"Ответ ноды слишком большой"}'); return resolve(); }
        const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (process.env.QTR_CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = process.env.QTR_CORS_ORIGIN;
        // Прокси не должен терять HttpOnly-cookie, которую ставит нода при логине
        if (proxyRes.headers['set-cookie']) headers['Set-Cookie'] = proxyRes.headers['set-cookie'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(d);
        resolve();
      });
    });
    proxy.on('error', () => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Нода недоступна. Запустите: node miner.js', offline: true }));
      resolve();
    });
    proxy.on('timeout', () => {
      proxy.destroy(new Error('timeout'));
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Нода не ответила вовремя', timeout: true }));
      }
      resolve();
    });
    if (req.method === 'POST' || req.method === 'PUT') {
      let b = '';
      let tooBig = false;
      req.on('data', c => {
        if (tooBig) return;
        b += c;
        if (b.length > MAX_PROXY_BODY) {
          tooBig = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Тело запроса больше 1 МБ' }));
        }
      });
      req.on('end', () => {
        if (tooBig) return resolve();
        proxy.write(b);
        proxy.end();
      });
    } else { proxy.end(); }
  });
}

const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

const PUBLIC_DIR = path.join(__dirname, 'public');

// Отдаём только файлы внутри public/. Раньше путь собирался как path.join(__dirname,'public',url)
// и запрос вида GET /../package.json вытаскивал любой файл с диска.
function safePublicPath(rawUrl) {
  let decoded;
  try { decoded = decodeURIComponent(rawUrl); } catch { return null; }
  if (decoded.includes('\0')) return null;
  if (decoded.includes('..')) return null;
  const full = path.resolve(PUBLIC_DIR, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

function serveFile(res, filePath) {
  if (!filePath) return false;
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  } catch { return false; }
  const stream = fs.createReadStream(filePath);
  // Без обработчика 'error' гонка «файл исчез между stat и read» роняла веб-сервер
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)]||'text/plain', 'Cache-Control': 'no-cache' });
  stream.pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    const optHeaders = { 'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,X-Session-Token' };
    if (process.env.QTR_CORS_ORIGIN) optHeaders['Access-Control-Allow-Origin'] = process.env.QTR_CORS_ORIGIN;
    res.writeHead(200, optHeaders);
    res.end(); return;
  }
  const url = req.url.split('?')[0];
  if (url === '/download/qtr-pool-miner.exe' && req.method === 'GET') {
    const exe = path.join(__dirname, 'dist', 'qtr-pool-miner-public.exe');
    if (!fs.existsSync(exe)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Miner not built yet. On server: QTR_POOL_BUILD_HOST=ip:3002 npm run build:miner-win:embed');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="qtr-pool-miner.exe"',
      'Cache-Control': 'public, max-age=600'
    });
    const exeStream = fs.createReadStream(exe);
    exeStream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
    exeStream.pipe(res);
    return;
  }
  if (url.startsWith('/api/')) { await proxyMiner(req, res, req.url.replace('/api','')); return; }
  if (url.startsWith('/pool/')) {
    return new Promise(resolve => {
      const opts = { ...POOL_API, path: req.url, method: req.method, headers: { 'Content-Type': 'application/json' } };
      const proxy = http.request({ ...opts, timeout: PROXY_TIMEOUT }, proxyRes => {
        let d = ''; let tooBig = false;
        proxyRes.on('data', c => {
          if (tooBig) return;
          d += c;
          if (d.length > MAX_PROXY_RESP) { tooBig = true; proxyRes.destroy(); }
        });
        proxyRes.on('end', () => {
          if (tooBig) { res.writeHead(502); res.end('{"error":"Ответ пула слишком большой"}'); return resolve(); }
          const headers = { 'Content-Type': 'application/json' };
          if (process.env.QTR_CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = process.env.QTR_CORS_ORIGIN;
          res.writeHead(proxyRes.statusCode, headers); res.end(d); resolve();
        });
      });
      proxy.on('error', () => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Пул недоступен' })); resolve(); });
      proxy.on('timeout', () => { proxy.destroy(new Error('timeout')); if (!res.headersSent) { res.writeHead(504, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Пул не ответил вовремя' })); } resolve(); });
      if (req.method === 'POST') { let b = ''; req.on('data', c => b += c); req.on('end', () => { proxy.write(b); proxy.end(); }); } else { proxy.end(); }
    });
  }
  if (url==='/')                          { serveFile(res, path.join(__dirname,'public/landing.html')); return; }
  if (url==='/login')                     { serveFile(res, path.join(__dirname,'public/index.html')); return; }
  if (url==='/app'||url==='/app/')        { serveFile(res, path.join(__dirname,'public/app.html')); return; }
  if (url==='/richlist'||url==='/richlist/') { serveFile(res, path.join(__dirname,'public/richlist.html')); return; }
  if (url==='/stats-page'||url==='/network') { serveFile(res, path.join(__dirname,'public/stats.html')); return; }
  if (url==='/status')                    { serveFile(res, path.join(__dirname,'public/status.html')); return; }
  if (serveFile(res, safePublicPath(url))) return;
  if (url.startsWith('/app'))             { serveFile(res, path.join(__dirname,'public/app.html')); return; }
  res.writeHead(404); res.end('404');
});

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         КOIN WEB SERVER                  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Сайт:  http://localhost:${PORT}`);
  console.log(`  API →  localhost:3001`);
  console.log(`\n  Майнер: node miner.js\n`);
});
