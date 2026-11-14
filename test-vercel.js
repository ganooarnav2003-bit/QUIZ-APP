'use strict';
// Simulates Vercel: Upstash REST mock + api/index.js function behind the vercel.json rewrite. Run: node test-vercel.js
const http = require('http');
const assert = require('assert');
const kv = new Map();
const upstash = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    const [cmd, k, v, ...rest] = JSON.parse(d); let out = null;
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    if (cmd === 'GET') out = kv.get(k) ?? null;
    else if (cmd === 'DEL') { kv.delete(k); out = 1; }
    else if (cmd === 'SET') { if (rest.includes('NX') && kv.has(k)) out = null; else { kv.set(k, v); out = 'OK'; if (rest.includes('PX')) setTimeout(() => kv.delete(k), 4000).unref(); } }
    res.end(JSON.stringify({ result: out }));
  });
});
upstash.listen(0, async () => {
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${upstash.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok'; process.env.VERCEL = '1';
  const fn = require('./api/index.js');
  const vercel = http.createServer((req, res) => { // emulate rewrite + body pre-parsing
    const u = new URL(req.url, 'http://x');
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
      if (d) req.body = JSON.parse(d);
      const m = u.pathname.match(/^\/api\/(.*)$/);
      req.url = `/api/index.js?p=${m[1]}${u.search ? '&' + u.search.slice(1) : ''}`;
      fn(req, res);
    });
  });
  await new Promise((r) => vercel.listen(0, r));
  const base = `http://127.0.0.1:${vercel.address().port}`;
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  const quiz = { title: 'V', questions: [{ text: 'Q', options: ['a', 'b'], correct: 0, time: 5 }] };
  const g = (await call('POST', '/api/games', { quiz })).j;
  assert.ok(/^\d{6}$/.test(g.pin));
  const pids = (await Promise.all(Array.from({ length: 25 }, (_, i) => call('POST', `/api/games/${g.pin}/join`, { name: 'u' + i })))).map((r) => r.j.pid);
  assert.ok(pids.every(Boolean) && new Set(pids).size === 25, 'concurrent joins through Redis lock');
  assert.strictEqual((await call('POST', `/api/games/${g.pin}/host`, { key: g.hostKey, action: 'start' })).s, 200);
  const rs = await Promise.all(pids.map((p, i) => call('POST', `/api/games/${g.pin}/answer`, { pid: p, choice: i % 2 })));
  assert.ok(rs.every((r) => r.s === 200), 'concurrent answers');
  const h = (await call('GET', `/api/games/${g.pin}/state?role=host&key=${g.hostKey}`)).j;
  assert.strictEqual(h.state, 'reveal'); assert.strictEqual(h.answered, 25);
  assert.strictEqual((await call('GET', `/api/games/${g.pin}/state?pid=nope`)).s, 403);
  assert.strictEqual((await call('GET', '/api/games/000000/state?pid=x')).s, 404);
  console.log('VERCEL SIMULATION PASSED'); process.exit(0);
});
