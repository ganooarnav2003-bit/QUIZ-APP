'use strict';
// Pure game logic on plain-JSON state (so it can live in Redis). No timers: deadlines are checked lazily.
const crypto = require('crypto');
const MAX_PLAYERS = 300, MAX_QUESTIONS = 100;

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const clampInt = (v, lo, hi, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const fail = (m, code = 409) => Object.assign(new Error(m), { code });

function sanitizeQuiz(q) {
  if (!q || typeof q !== 'object') throw fail('Invalid quiz', 400);
  const title = clean(q.title, 80) || 'Untitled quiz';
  if (!Array.isArray(q.questions) || !q.questions.length) throw fail('Add at least one question', 400);
  if (q.questions.length > MAX_QUESTIONS) throw fail('Too many questions', 400);
  const questions = q.questions.map((x, i) => {
    const text = clean(x && x.text, 300);
    if (!text) throw fail(`Question ${i + 1} has no text`, 400);
    const options = (Array.isArray(x.options) ? x.options : []).map((o) => clean(o, 120)).filter(Boolean);
    if (options.length < 2 || options.length > 6) throw fail(`Question ${i + 1} needs 2–6 options`, 400);
    return { text, options, correct: clampInt(x.correct, 0, options.length - 1, 0), time: clampInt(x.time, 5, 300, 20), points: [0, 1000, 2000].includes(Number(x.points)) ? Number(x.points) : 1000 };
  });
  return { title, questions };
}

function newGame(pin, quiz) {
  return { pin, hostKey: rid(16), quiz, state: 'lobby', qi: -1, qStart: 0, qEnd: 0, players: {}, created: Date.now() };
}

const plist = (g) => Object.values(g.players);
const ranked = (g) => plist(g).sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
const answeredCount = (g) => plist(g).filter((p) => p.answers[g.qi] != null).length;

function startQuestion(g, i, now) {
  g.qi = i; g.state = 'question'; g.qStart = now; g.qEnd = now + g.quiz.questions[i].time * 1000;
}
function reveal(g, now) {
  if (g.state !== 'question') return;
  g.state = 'reveal'; g.qEnd = Math.min(g.qEnd, now);
  for (const p of plist(g)) { const a = p.answers[g.qi]; if (!a || !a.ok) p.streak = 0; }
}
// Lazy timer: call before reading/mutating. Returns true if state changed.
function tick(g, now) {
  if (g.state === 'question' && now >= g.qEnd) { reveal(g, now); return true; }
  return false;
}
const isDue = (g, now) => g.state === 'question' && now >= g.qEnd;

function join(g, name, now) {
  if (g.state !== 'lobby') throw fail('This quiz has already started.');
  if (plist(g).length >= MAX_PLAYERS) throw fail('This quiz is full.');
  name = clean(name, 20);
  if (!name) throw fail('Enter a name', 400);
  if (plist(g).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw fail('That name is taken — pick another.');
  const p = { id: rid(8), name, score: 0, streak: 0, answers: [], joinedAt: now };
  g.players[p.id] = p;
  return p;
}

function answer(g, pid, choice, now) {
  const p = g.players[pid];
  if (!p) throw fail('Not in this game', 403);
  const q = g.quiz.questions[g.qi];
  if (g.state !== 'question' || now > g.qEnd) throw fail('Time is up');
  if (p.answers[g.qi] != null) throw fail('Already answered');
  choice = clampInt(choice, 0, q.options.length - 1, -1);
  if (choice < 0) throw fail('Bad choice', 400);
  const ms = now - g.qStart, ok = choice === q.correct;
  let pts = 0;
  if (ok && q.points > 0) {
    const frac = Math.max(0, 1 - ms / (q.time * 1000));
    pts = Math.round(q.points * (0.5 + 0.5 * frac) + Math.min(p.streak, 5) * (q.points / 20));
  }
  p.streak = ok ? p.streak + 1 : 0;
  p.score += pts;
  p.answers[g.qi] = { choice, ok, pts, ms };
  if (answeredCount(g) >= plist(g).length) reveal(g, now);
}

function hostAction(g, body, now) {
  const qs = g.quiz.questions;
  switch (body.action) {
    case 'start':
      if (g.state !== 'lobby') throw fail('Already started');
      if (!plist(g).length) throw fail('Wait for at least one player');
      startQuestion(g, 0, now); break;
    case 'reveal':
      if (g.state !== 'question') throw fail('Not in a question');
      reveal(g, now); break;
    case 'next':
      if (g.state !== 'reveal') throw fail('Reveal the answer first');
      if (g.qi + 1 >= qs.length) g.state = 'finished'; else startQuestion(g, g.qi + 1, now);
      break;
    case 'extend':
      if (g.state !== 'question') throw fail('Not in a question');
      g.qEnd += clampInt(body.seconds, 1, 120, 10) * 1000; break;
    case 'end': g.state = 'finished'; break;
    case 'kick':
      delete g.players[String(body.pid)];
      if (g.state === 'question' && plist(g).length && answeredCount(g) >= plist(g).length) reveal(g, now);
      break;
    default: throw fail('Unknown action', 400);
  }
}

// ---- views ----
const board = (g, n) => ranked(g).slice(0, n).map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score, streak: p.streak }));

function baseView(g, now) {
  const q = g.quiz.questions[g.qi];
  const v = { now, pin: g.pin, title: g.quiz.title, state: g.state, total: g.quiz.questions.length, qi: g.qi, playerCount: plist(g).length };
  if (q && (g.state === 'question' || g.state === 'reveal')) {
    v.q = { text: q.text, options: q.options, time: q.time, points: q.points };
    v.qStart = g.qStart; v.qEnd = g.qEnd; v.answered = answeredCount(g);
  }
  if (g.state === 'reveal') {
    v.q.correct = q.correct;
    v.dist = q.options.map(() => 0);
    for (const p of plist(g)) { const a = p.answers[g.qi]; if (a) v.dist[a.choice]++; }
  }
  return v;
}

function hostView(g, now) {
  const v = baseView(g, now);
  v.role = 'host';
  v.players = plist(g).map((p) => ({ id: p.id, name: p.name }));
  if (g.state === 'question') {
    const q = g.quiz.questions[g.qi];
    v.liveDist = q.options.map(() => 0);
    for (const p of plist(g)) { const a = p.answers[g.qi]; if (a) v.liveDist[a.choice]++; }
  }
  if (g.state !== 'lobby') v.board = board(g, g.state === 'finished' ? 100 : 10);
  if (g.state === 'finished') v.stats = g.quiz.questions.map((q, i) => {
    let n = 0, right = 0;
    for (const p of plist(g)) { const a = p.answers[i]; if (a) { n++; if (a.ok) right++; } }
    return { text: q.text, answered: n, correct: right };
  });
  return v;
}

function playerView(g, p, now) {
  const v = baseView(g, now);
  v.role = 'player';
  v.me = { id: p.id, name: p.name, score: p.score, streak: p.streak, rank: ranked(g).findIndex((x) => x.id === p.id) + 1 };
  const a = p.answers[g.qi];
  if (a) v.my = g.state === 'reveal' ? a : { choice: a.choice };
  else if (g.state === 'reveal') v.my = null;
  if (g.state !== 'lobby') v.board = board(g, g.state === 'finished' ? 10 : 5);
  if (g.state === 'finished') v.me.correct = p.answers.filter((x) => x && x.ok).length;
  return v;
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

module.exports = { sanitizeQuiz, newGame, tick, isDue, join, answer, hostAction, hostView, playerView, csv, fail, rid };
