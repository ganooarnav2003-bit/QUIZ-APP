'use strict';
// End-to-end smoke test: node test.js
const assert = require('assert');
const { server } = require('./server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (u, b) => { const r = await fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
  const quiz = { title: 'T', questions: [
    { text: 'Q1', options: ['a', 'b'], correct: 1, time: 5 },
    { text: 'Q2', options: ['a', 'b', 'c'], correct: 0, time: 5 } ] };
  assert.strictEqual((await post('/api/games', { quiz: { title: 'x', questions: [] } })).s, 400);
  const { j: g } = await post('/api/games', { quiz });
  const a = (await post(`/api/games/${g.pin}/join`, { name: 'Ann' })).j.pid;
  const b = (await post(`/api/games/${g.pin}/join`, { name: 'Bob' })).j.pid;
  assert.strictEqual((await post(`/api/games/${g.pin}/join`, { name: 'ann' })).s, 409, 'dup name');
  const host = (action, x = {}) => post(`/api/games/${g.pin}/host`, { key: g.hostKey, action, ...x });
  assert.strictEqual((await post(`/api/games/${g.pin}/host`, { key: 'bad', action: 'start' })).s, 403);
  // read player stream: must never leak the correct answer during a question
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/games/${g.pin}/events?pid=${a}`, { signal: ctrl.signal });
  let last = null; (async () => { const dec = new TextDecoder(); let buf = ''; try { for await (const c of res.body) { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = buf.slice(0, i).match(/^data: (.*)$/m); buf = buf.slice(i + 2); if (m) last = JSON.parse(m[1]); } } } catch (e) {} })();
  assert.strictEqual((await host('start')).s, 200);
  await sleep(100);
  assert.strictEqual(last.state, 'question'); assert.strictEqual(last.q.correct, undefined, 'answer leaked');
  assert.strictEqual((await post(`/api/games/${g.pin}/answer`, { pid: a, choice: 1 })).s, 200);
  assert.strictEqual((await post(`/api/games/${g.pin}/answer`, { pid: a, choice: 0 })).s, 409, 'double answer');
  await post(`/api/games/${g.pin}/answer`, { pid: b, choice: 0 }); // all answered -> auto reveal
  await sleep(100);
  assert.strictEqual(last.state, 'reveal'); assert.strictEqual(last.q.correct, 1); assert.ok(last.me.score >= 500 && last.me.rank === 1);
  await host('next'); await sleep(50);
  // let timer expire on its own (5s)
  await sleep(5300);
  assert.strictEqual(last.state, 'reveal', 'timer should auto-reveal');
  await host('next'); await sleep(50);
  assert.strictEqual(last.state, 'finished');
  const csv = await (await fetch(`${base}/api/games/${g.pin}/results.csv?key=${g.hostKey}`)).text();
  assert.ok(csv.includes('Ann'));
  ctrl.abort(); server.close();
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
