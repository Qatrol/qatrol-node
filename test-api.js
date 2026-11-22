'use strict';
// Smoke test for the QTR node + web proxy. Run: node test-api.js
const http = require('http');

const WEB = { host: '127.0.0.1', port: 3000 };
let pass = 0, fail = 0;
const failures = [];

function req(path, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      ...WEB, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    };
    const r = http.request(opts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (_) { }
        resolve({ status: res.statusCode, body: b, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + String(extra).slice(0, 200) : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 200) : '')); }
}

(async () => {
  console.log('\n== web server ==');
  const page = await req('/');
  check('GET / returns 200', page.status === 200, page.status);
  check('GET / serves landing html', /<html/i.test(page.body), page.body.slice(0, 60));

  for (const p of ['/login', '/app', '/richlist', '/stats-page', '/status', '/style.css']) {
    const r = await req(p);
    check('GET ' + p, r.status === 200, r.status);
  }

  console.log('\n== node api via proxy ==');
  const stats = await req('/api/stats');
  check('GET /api/stats 200', stats.status === 200, stats.status);
  check('stats has supply', stats.json && stats.json.totalSupply === 1000000000, JSON.stringify(stats.json).slice(0, 120));
  check('stats has ticker QTR', stats.json && stats.json.ticker === 'QTR');

  for (const p of ['/api/chain', '/api/mempool', '/api/peers', '/api/richlist', '/api/chartdata']) {
    const r = await req(p);
    check('GET ' + p, r.status === 200 && r.json !== null, r.status + ' ' + r.body.slice(0, 80));
  }

  console.log('\n== wallet flow ==');
  const reg = await req('/api/auth/register', 'POST', { password: 'test-pass-123' });
  check('POST /api/auth/register', reg.status === 200 && reg.json && reg.json.address, reg.body.slice(0, 150));
  const token = reg.json && (reg.json.token || reg.json.sessionToken);
  const address = reg.json && reg.json.address;
  check('register returns token', !!token, Object.keys(reg.json || {}).join(','));
  check('address looks like K+39 hex', /^K[0-9A-F]{39}$/.test(address || ''), address);

  const login = await req('/api/auth/login', 'POST', { address, password: 'test-pass-123' });
  check('POST /api/auth/login', login.status === 200 && login.json && (login.json.token || login.json.address), login.body.slice(0, 150));

  // login выше выдаёт новую сессию и гасит старую (createSession), поэтому проверяем токен от логина.
  const liveToken = (login.json && login.json.token) || token;
  const me = await req('/api/auth/me', 'GET', null, liveToken ? { 'X-Session-Token': liveToken } : {});
  check('GET /api/auth/me with token', me.status === 200, me.status + ' ' + me.body.slice(0, 120));

  const badLogin = await req('/api/auth/login', 'POST', { address, password: 'wrong' });
  check('login with wrong password rejected', badLogin.status >= 400 || (badLogin.json && !badLogin.json.token), badLogin.body.slice(0, 120));

  console.log('\n== validation ==');
  const noAuth = await req('/api/send', 'POST', { to: 'K0000000000000000000000000000000000000000', amount: 1 });
  check('send without auth rejected', noAuth.status >= 400, noAuth.status + ' ' + noAuth.body.slice(0, 100));

  const authHdr = liveToken ? { 'X-Session-Token': liveToken } : {};

  const badAmount = await req('/api/send', 'POST', { to: address, amount: -5 }, authHdr);
  check('negative amount rejected', badAmount.status === 400, badAmount.status + ' ' + badAmount.body.slice(0, 100));

  const badTo = await req('/api/send', 'POST', { to: 'Kbad', amount: 1 }, authHdr);
  check('send to bad address rejected', badTo.status === 400, badTo.status + ' ' + badTo.body.slice(0, 100));

  const poor = await req('/api/send', 'POST', { to: address, amount: 1 }, authHdr);
  check('send from empty wallet rejected', poor.status === 400, poor.status + ' ' + poor.body.slice(0, 120));

  console.log('\n== security ==');
  const trav = await req('/../package.json');
  check('path traversal blocked', trav.status === 404 && !/qatrol-coin/.test(trav.body), trav.status + ' ' + trav.body.slice(0, 60));
  const trav2 = await req('/..%2fpackage.json');
  check('encoded traversal blocked', trav2.status === 404 && !/qatrol-coin/.test(trav2.body), trav2.status + ' ' + trav2.body.slice(0, 60));

  console.log('\n== pool ==');
  const tpl = await req('/api/pool/template?miner=' + encodeURIComponent(address));
  check('GET /api/pool/template', tpl.status === 200 && tpl.json !== null, tpl.status + ' ' + tpl.body.slice(0, 100));

  console.log('\n== 404 ==');
  const nf = await req('/api/nope-nope');
  check('unknown api path 404', nf.status === 404, nf.status);

  console.log('\n----------------------------------------');
  console.log(`pass ${pass}  fail ${fail}`);
  if (failures.length) { console.log('failed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
