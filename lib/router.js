'use strict';
// Framework-free API handler shared by the local server and the Vercel function.
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const G = require('./game');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(res, code, obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) { // Vercel pre-parses
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch (e) { throw G.fail('Bad JSON', 400); } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString() || '{}'); } catch (e) { throw G.fail('Bad JSON', 400); } }
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 300000) { reject(G.fail('Too large', 413)); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(G.fail('Bad JSON', 400)); } });
    req.on('error', reject);
  });
}

const key = (pin) => 'game:' + pin;
async function load(pin) {
  const g = /^\d{6}$/.test(pin) ? await store.get(key(pin)) : null;
  if (!g) throw G.fail('Game not found. Check the PIN.', 404);
  return g;
}
// Read-modify-write under a short lock so concurrent players can't overwrite each other.
async function mutate(pin, fn) {
  const lk = 'lock:' + pin;
  let got = false;
  for (let i = 0; i < 60 && !(got = await store.lock(lk)); i++) await sleep(40 + Math.random() * 40);
  if (!got) throw G.fail('Busy, please retry', 503);
  try {
    const g = await load(pin);
    G.tick(g, Date.now());
    const out = fn(g, Date.now());
    await store.set(key(pin), g);
    return out;
  } finally { await store.unlock(lk); }
}

function lan() {
  if (process.env.VERCEL) return [];
  const out = [];
  for (const l of Object.values(os.networkInterfaces())) for (const i of l || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

async function route(req, res, pathname, query) {
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  if (!store) throw G.fail('Storage not configured: add an Upstash Redis database (see README).', 500);
  if (parts[1] === 'info') return send(res, 200, { lan: lan(), port: Number(process.env.PORT) || 3000, storage: store.kind });

  if (parts[1] === 'games' && parts.length === 2 && req.method === 'POST') {
    const quiz = G.sanitizeQuiz((await readBody(req)).quiz);
    for (let i = 0; i < 20; i++) {
      const pin = String(crypto.randomInt(100000, 1000000));
      const g = G.newGame(pin, quiz);
      if (await store.setNx(key(pin), g)) return send(res, 200, { pin, hostKey: g.hostKey });
    }
    throw G.fail('Could not allocate a PIN', 503);
  }
  if (parts[1] !== 'games' || !parts[2]) throw G.fail('Not found', 404);
  const pin = parts[2], action = parts[3];

  if (action === 'state' && req.method === 'GET') {
    let g = await load(pin);
    if (G.isDue(g, Date.now())) g = await mutate(pin, (x) => x);
    const now = Date.now();
    if (query.role === 'host') {
      if (query.key !== g.hostKey) throw G.fail('Not the host', 403);
      return send(res, 200, G.hostView(g, now));
    }
    const p = g.players[query.pid];
    if (!p) throw G.fail('Not in this game', 403);
    return send(res, 200, G.playerView(g, p, now));
  }
  if (action === 'info' && req.method === 'GET') { const g = await load(pin); return send(res, 200, { title: g.quiz.title, state: g.state, players: Object.keys(g.players).length }); }
  if (action === 'join' && req.method === 'POST') {
    const b = await readBody(req);
    return send(res, 200, { pid: await mutate(pin, (g, now) => G.join(g, b.name, now).id) });
  }
  if (action === 'answer' && req.method === 'POST') {
    const b = await readBody(req);
    await mutate(pin, (g, now) => G.answer(g, String(b.pid), b.choice, now));
    return send(res, 200, { ok: true });
  }
  if (action === 'host' && req.method === 'POST') {
    const b = await readBody(req);
    await mutate(pin, (g, now) => { if (b.key !== g.hostKey) throw G.fail('Not the host', 403); G.hostAction(g, b, now); });
    return send(res, 200, { ok: true });
  }
  if (action === 'results.csv' && req.method === 'GET') {
    const g = await load(pin);
    if (query.key !== g.hostKey) throw G.fail('Not the host', 403);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quiz-${pin}-results.csv"`);
    return res.end('﻿' + G.csv(g));
  }
  throw G.fail('Not found', 404);
}

module.exports = async function handle(req, res, pathname, query) {
  try { await route(req, res, pathname, query); }
  catch (e) { if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message || 'Error' }); }
};
