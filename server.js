'use strict';
// QuizLive server — zero dependencies. Run: node server.js  (PORT env optional)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 300;
const MAX_QUESTIONS = 100;
const GAME_TTL = 6 * 3600 * 1000;

const games = new Map(); // pin -> game

// ---------- helpers ----------
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const clampInt = (v, lo, hi, d) => {
  v = Math.round(Number(v));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function newPin() {
  for (let i = 0; i < 1000; i++) {
    const p = String(crypto.randomInt(100000, 1000000));
    if (!games.has(p)) return p;
  }
  throw new Error('no pin');
}

function sanitizeQuiz(q) {
  if (!q || typeof q !== 'object') throw new Error('Invalid quiz');
  const title = clean(q.title, 80) || 'Untitled quiz';
  if (!Array.isArray(q.questions) || !q.questions.length) throw new Error('Add at least one question');
  if (q.questions.length > MAX_QUESTIONS) throw new Error('Too many questions');
  const questions = q.questions.map((x, i) => {
    const text = clean(x && x.text, 300);
    if (!text) throw new Error(`Question ${i + 1} has no text`);
    const options = (Array.isArray(x.options) ? x.options : []).map((o) => clean(o, 120)).filter(Boolean);
    if (options.length < 2 || options.length > 6) throw new Error(`Question ${i + 1} needs 2–6 options`);
    const correct = clampInt(x.correct, 0, options.length - 1, 0);
    return {
      text,
      options,
      correct,
      time: clampInt(x.time, 5, 300, 20),
      points: [0, 1000, 2000].includes(Number(x.points)) ? Number(x.points) : 1000,
    };
  });
  return { title, questions };
}

// ---------- game logic ----------
function createGame(quiz) {
  const g = {
    pin: newPin(),
    hostKey: rid(16),
    quiz,
    state: 'lobby', // lobby | question | reveal | finished
    qi: -1,
    qStart: 0,
    qEnd: 0,
    players: new Map(),
    conns: new Set(),
    timer: null,
    created: Date.now(),
    touched: Date.now(),
  };
  games.set(g.pin, g);
  return g;
}

function ranked(g) {
  return [...g.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
}

function answeredCount(g) {
  let n = 0;
  for (const p of g.players.values()) if (p.answers[g.qi] !== undefined) n++;
  return n;
}

function startQuestion(g, i) {
  clearTimeout(g.timer);
  g.qi = i;
  g.state = 'question';
  g.qStart = Date.now();
  g.qEnd = g.qStart + g.quiz.questions[i].time * 1000;
  schedule(g);
}

function schedule(g) {
  clearTimeout(g.timer);
  g.timer = setTimeout(() => reveal(g), Math.max(0, g.qEnd - Date.now()) + 50);
}

function reveal(g) {
  if (g.state !== 'question') return;
  clearTimeout(g.timer);
  g.state = 'reveal';
  g.qEnd = Math.min(g.qEnd, Date.now());
  // streak bookkeeping happens here so unanswered questions reset the streak
  for (const p of g.players.values()) {
    const a = p.answers[g.qi];
    if (!a || !a.ok) p.streak = 0;
  }
  broadcast(g);
}

function submitAnswer(g, p, choice) {
  const q = g.quiz.questions[g.qi];
  if (g.state !== 'question' || Date.now() > g.qEnd + 250) throw new Error('Time is up');
  if (p.answers[g.qi] !== undefined) throw new Error('Already answered');
  choice = clampInt(choice, 0, q.options.length - 1, -1);
  if (choice < 0) throw new Error('Bad choice');
  const ms = Math.min(Date.now(), g.qEnd) - g.qStart;
  const ok = choice === q.correct;
  let pts = 0;
  if (ok && q.points > 0) {
    const frac = 1 - ms / (q.time * 1000);
    pts = Math.round(q.points * (0.5 + 0.5 * Math.max(0, frac)));
    pts += Math.min(p.streak, 5) * (q.points / 20); // streak bonus (up to +25%)
    pts = Math.round(pts);
  }
  p.streak = ok ? p.streak + 1 : 0;
  p.score += pts;
  p.answers[g.qi] = { choice, ok, pts, ms };
  if (answeredCount(g) >= g.players.size) reveal(g);
  else broadcast(g);
}

function hostAction(g, body) {
  const q = g.quiz.questions;
  switch (body.action) {
    case 'start':
      if (g.state !== 'lobby') throw new Error('Already started');
      if (!g.players.size) throw new Error('Wait for at least one player');
      startQuestion(g, 0);
      break;
    case 'reveal':
      if (g.state !== 'question') throw new Error('Not in a question');
      reveal(g);
      return;
    case 'next':
      if (g.state !== 'reveal') throw new Error('Reveal the answer first');
      if (g.qi + 1 >= q.length) { g.state = 'finished'; clearTimeout(g.timer); }
      else startQuestion(g, g.qi + 1);
      break;
    case 'extend':
      if (g.state !== 'question') throw new Error('Not in a question');
      g.qEnd += clampInt(body.seconds, 1, 120, 10) * 1000;
      schedule(g);
      break;
    case 'end':
      clearTimeout(g.timer);
      g.state = 'finished';
      break;
    case 'kick': {
      const p = g.players.get(String(body.pid));
      if (p) { g.players.delete(p.id); if (g.state === 'question' && g.players.size && answeredCount(g) >= g.players.size) reveal(g); }
      break;
    }
    default: throw new Error('Unknown action');
  }
  broadcast(g);
}

// ---------- views ----------
function board(g, n) {
  return ranked(g).slice(0, n).map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score, streak: p.streak }));
}

function baseView(g) {
  const q = g.quiz.questions[g.qi];
  const v = {
    now: Date.now(),
    pin: g.pin,
    title: g.quiz.title,
    state: g.state,
    total: g.quiz.questions.length,
    qi: g.qi,
    playerCount: g.players.size,
  };
  if (q && (g.state === 'question' || g.state === 'reveal')) {
    v.q = { text: q.text, options: q.options, time: q.time, points: q.points };
    v.qStart = g.qStart;
    v.qEnd = g.qEnd;
    v.answered = answeredCount(g);
  }
  if (g.state === 'reveal') {
    v.q.correct = q.correct;
    const dist = q.options.map(() => 0);
    for (const p of g.players.values()) { const a = p.answers[g.qi]; if (a) dist[a.choice]++; }
    v.dist = dist;
  }
  return v;
}

function hostView(g) {
  const v = baseView(g);
  v.role = 'host';
  v.players = [...g.players.values()].map((p) => ({ id: p.id, name: p.name }));
  if (g.state === 'question') {
    const q = g.quiz.questions[g.qi];
    v.liveDist = q.options.map(() => 0); // counts only (no answer leak to anyone but host)
    for (const p of g.players.values()) { const a = p.answers[g.qi]; if (a) v.liveDist[a.choice]++; }
    v.q.correct = q.correct;
  }
  if (g.state !== 'lobby') v.board = board(g, g.state === 'finished' ? 100 : 10);
  if (g.state === 'finished') v.stats = questionStats(g);
  return v;
}

function playerView(g, p) {
  const v = baseView(g);
  v.role = 'player';
  v.me = { id: p.id, name: p.name, score: p.score, streak: p.streak };
  const list = ranked(g);
  v.me.rank = list.findIndex((x) => x.id === p.id) + 1;
  const a = p.answers[g.qi];
  if (a) v.my = g.state === 'reveal' ? a : { choice: a.choice };
  else if (g.state === 'reveal') v.my = null;
  if (g.state !== 'lobby') v.board = board(g, g.state === 'finished' ? 10 : 5);
  if (g.state === 'finished') {
    v.me.correct = p.answers.filter((x) => x && x.ok).length;
  }
  return v;
}

function questionStats(g) {
  return g.quiz.questions.map((q, i) => {
    let right = 0, n = 0;
    for (const p of g.players.values()) { const a = p.answers[i]; if (a) { n++; if (a.ok) right++; } }
    return { text: q.text, answered: n, correct: right };
  });
}

function csv(g) {
  const esc = (s) => `"${String(s).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const rows = [['Rank', 'Name', 'Score', 'Correct', ...g.quiz.questions.map((_, i) => `Q${i + 1}`)].map(esc).join(',')];
  ranked(g).forEach((p, i) => {
    const cells = g.quiz.questions.map((_, k) => { const a = p.answers[k]; return a ? (a.ok ? `✓ ${a.pts}` : '✗') : '–'; });
    rows.push([i + 1, p.name, p.score, p.answers.filter((a) => a && a.ok).length, ...cells].map(esc).join(','));
  });
  return rows.join('\n');
}

function broadcast(g) {
  g.touched = Date.now();
  for (const c of g.conns) send(g, c);
}
function send(g, c) {
  let view;
  if (c.role === 'host') view = hostView(g);
  else {
    const p = g.players.get(c.pid);
    view = p ? playerView(g, p) : { role: 'player', kicked: true, now: Date.now() };
  }
  try { c.res.write(`data: ${JSON.stringify(view)}\n\n`); } catch (e) { g.conns.delete(c); }
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 300000) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'info') return json(res, 200, { lan: lanAddresses(), port: PORT, now: Date.now() });

  if (parts[1] === 'games' && parts.length === 2 && req.method === 'POST') {
    const body = await readBody(req);
    const g = createGame(sanitizeQuiz(body.quiz));
    return json(res, 200, { pin: g.pin, hostKey: g.hostKey });
  }
  const g = games.get(parts[2]);
  if (parts[1] !== 'games' || !g) return json(res, 404, { error: 'Game not found. Check the PIN.' });
  const action = parts[3];

  if (action === 'events' && req.method === 'GET') {
    const role = url.searchParams.get('role');
    const c = { res, role: 'player', pid: url.searchParams.get('pid') };
    if (role === 'host') {
      if (url.searchParams.get('key') !== g.hostKey) return json(res, 403, { error: 'Not the host' });
      c.role = 'host';
    } else if (!g.players.has(c.pid)) return json(res, 403, { error: 'Not in this game' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n');
    g.conns.add(c);
    send(g, c);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ka); g.conns.delete(c); });
    return;
  }

  if (action === 'info' && req.method === 'GET') return json(res, 200, { title: g.quiz.title, state: g.state, players: g.players.size });

  if (action === 'join' && req.method === 'POST') {
    const body = await readBody(req);
    if (g.state !== 'lobby') return json(res, 409, { error: 'This quiz has already started.' });
    if (g.players.size >= MAX_PLAYERS) return json(res, 409, { error: 'This quiz is full.' });
    const name = clean(body.name, 20);
    if (!name) return json(res, 400, { error: 'Enter a name' });
    for (const p of g.players.values()) if (p.name.toLowerCase() === name.toLowerCase()) return json(res, 409, { error: 'That name is taken — pick another.' });
    const p = { id: rid(8), name, score: 0, streak: 0, answers: [], joinedAt: Date.now() };
    g.players.set(p.id, p);
    broadcast(g);
    return json(res, 200, { pid: p.id });
  }

  if (action === 'answer' && req.method === 'POST') {
    const body = await readBody(req);
    const p = g.players.get(String(body.pid));
    if (!p) return json(res, 403, { error: 'Not in this game' });
    try { submitAnswer(g, p, body.choice); } catch (e) { return json(res, 409, { error: e.message }); }
    return json(res, 200, { ok: true });
  }

  if (action === 'host' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.key !== g.hostKey) return json(res, 403, { error: 'Not the host' });
    try { hostAction(g, body); } catch (e) { return json(res, 409, { error: e.message }); }
    return json(res, 200, { ok: true });
  }

  if (action === 'results.csv' && req.method === 'GET') {
    if (url.searchParams.get('key') !== g.hostKey) return json(res, 403, { error: 'Not the host' });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="quiz-${g.pin}-results.csv"` });
    return res.end('﻿' + csv(g));
  }
  json(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (/^\/join(\/|$)/.test(p)) p = '/play.html';
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => { if (!res.headersSent) json(res, 400, { error: e.message || 'Error' }); });
  } else serveStatic(req, res, url);
});

setInterval(() => {
  const now = Date.now();
  for (const [pin, g] of games) if (now - g.touched > GAME_TTL && !g.conns.size) { clearTimeout(g.timer); games.delete(pin); }
}, 600000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`QuizLive running:\n  http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  http://${ip}:${PORT}   (phones on the same Wi-Fi can use this)`);
  });
}
module.exports = { server, games };
