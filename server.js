'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = parseInt(process.env.QTR_WEB_PORT || '3000');
const MINER_API = {
  hostname: process.env.QTR_API_HOST || 'localhost',
  port: parseInt(process.env.QTR_PORT || '3001')
};
const POOL_API = {
  hostname: process.env.QTR_POOL_HOST || 'localhost',
  port: parseInt(process.env.QTR_POOL_PORT || process.env.POOL_PORT || '3002')
};

function proxyMiner(req, res, targetPath) {
  return new Promise(resolve => {
    const opts = { ...MINER_API, path: targetPath, method: req.method, headers: { 'Content-Type': 'application/json', 'Cookie': req.headers.cookie||'', 'X-Session-Token': req.headers['x-session-token']||'' } };
    const proxy = http.request(opts, proxyRes => {
      let d = '';
      proxyRes.on('data', c => d += c);
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(d);
        resolve();
      });
    });
    proxy.on('error', () => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Нода недоступна. Запустите: node miner.js', offline: true }));
      resolve();
    });
    if (req.method === 'POST' || req.method === 'PUT') {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => { proxy.write(b); proxy.end(); });
    } else { proxy.end(); }
  });
}

const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)||!fs.statSync(filePath).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)]||'text/plain', 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,X-Session-Token' });
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
      'Cache-Control': 'public, max-age=600',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(exe).pipe(res);
    return;
  }
  if (url.startsWith('/api/')) { await proxyMiner(req, res, req.url.replace('/api','')); return; }
  if (url.startsWith('/pool/')) {
    return new Promise(resolve => {
      const opts = { ...POOL_API, path: req.url, method: req.method, headers: { 'Content-Type': 'application/json' } };
      const proxy = http.request(opts, proxyRes => {
        let d = ''; proxyRes.on('data', c => d += c);
        proxyRes.on('end', () => { res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(d); resolve(); });
      });
      proxy.on('error', () => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Пул недоступен' })); resolve(); });
      if (req.method === 'POST') { let b = ''; req.on('data', c => b += c); req.on('end', () => { proxy.write(b); proxy.end(); }); } else { proxy.end(); }
    });
  }
  if (url==='/')                          { serveFile(res, path.join(__dirname,'public/landing.html')); return; }
  if (url==='/login')                     { serveFile(res, path.join(__dirname,'public/index.html')); return; }
  if (url==='/app'||url==='/app/')        { serveFile(res, path.join(__dirname,'public/app.html')); return; }
  if (url==='/richlist'||url==='/richlist/') { serveFile(res, path.join(__dirname,'public/richlist.html')); return; }
  if (url==='/stats-page'||url==='/network') { serveFile(res, path.join(__dirname,'public/stats.html')); return; }
  if (url==='/status')                    { serveFile(res, path.join(__dirname,'public/status.html')); return; }
  if (serveFile(res, path.join(__dirname,'public',url))) return;
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
