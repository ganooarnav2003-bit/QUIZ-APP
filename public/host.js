'use strict';
const app = $('#app');
const LS = 'quizlive.quizzes';
const SESSION = 'quizlive.hosting';
let quizzes = load();
let editing = null; // quiz being edited
let game = null;    // {pin,hostKey}
let link = null, stopTimer = null, lastView = null, baseUrl = location.origin, lan = [];

function load() { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch (e) { return []; } }
function persist() { try { localStorage.setItem(LS, JSON.stringify(quizzes)); } catch (e) { toast('Could not save (storage full or blocked)'); } }
const uid = () => Math.random().toString(36).slice(2, 10);
const blankQ = (t = 20) => ({ text: '', options: ['', '', '', ''], correct: 0, time: t, points: 1000 });

const SAMPLE = {
  title: 'General knowledge (sample)',
  questions: [
    { text: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correct: 1, time: 15, points: 1000 },
    { text: 'What is the capital of Australia?', options: ['Sydney', 'Melbourne', 'Canberra', 'Perth'], correct: 2, time: 20, points: 1000 },
    { text: 'The Great Wall of China is visible from the Moon with the naked eye.', options: ['True', 'False'], correct: 1, time: 10, points: 1000 },
    { text: 'What is 12 × 12?', options: ['124', '132', '144', '154'], correct: 2, time: 30, points: 2000 },
  ],
};

// ---------------- Home ----------------
function home() {
  stopAll();
  const resume = sessionStorage.getItem(SESSION);
  app.innerHTML = `
  <div class="hero"><h1>Run live quizzes with a timer on every question</h1>
  <p class="muted">Build a quiz, show the QR code, and your audience plays on their phones — no app or sign-up.</p>
  <div class="row" style="justify-content:center;margin-top:18px">
    <button class="btn big" id="new">+ Create a quiz</button>
    <button class="btn big ghost" id="sample">Try the sample</button></div></div>
  ${resume ? `<div class="card row"><div class="sp"><b>A game is still running</b><div class="muted small">PIN ${JSON.parse(resume).pin}</div></div><button class="btn" id="resume">Resume hosting</button></div>` : ''}
  <div class="row" style="margin:18px 0 10px"><h2>My quizzes</h2><div class="sp"></div><label class="btn ghost sm">Import JSON<input type="file" id="imp" accept="application/json,.json" hidden></label></div>
  ${quizzes.length ? `<div class="grid g2">${quizzes.map((q) => `<div class="card qcard"><h3>${esc(q.title)}</h3>
    <p class="muted small">${q.questions.length} question${q.questions.length === 1 ? '' : 's'} · ${q.questions.reduce((a, x) => a + x.time, 0)}s total timer</p>
    <div class="row"><button class="btn sm" data-host="${q.id}">▶ Host live</button><button class="btn sm ghost" data-edit="${q.id}">Edit</button>
    <button class="btn sm plain" data-exp="${q.id}">Export</button><button class="btn sm danger" data-del="${q.id}">Delete</button></div></div>`).join('')}</div>`
    : `<div class="card center muted">No quizzes yet. Create one or try the sample.</div>`}`;
  $('#new').onclick = () => edit({ id: uid(), title: '', questions: [blankQ()] });
  $('#sample').onclick = () => { const q = { ...structuredClone(SAMPLE), id: uid() }; quizzes.unshift(q); persist(); home(); };
  if (resume) $('#resume').onclick = () => { game = JSON.parse(resume); live(); };
  $('#imp').onchange = async (e) => {
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if (!d.title || !Array.isArray(d.questions)) throw 0;
      quizzes.unshift({ id: uid(), title: String(d.title).slice(0, 80), questions: d.questions }); persist(); home();
    } catch (er) { toast('That file is not a valid quiz'); }
  };
  app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => edit(structuredClone(quizzes.find((q) => q.id === b.dataset.edit)))));
  app.querySelectorAll('[data-host]').forEach((b) => (b.onclick = () => startGame(quizzes.find((q) => q.id === b.dataset.host))));
  app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { if (confirm('Delete this quiz?')) { quizzes = quizzes.filter((q) => q.id !== b.dataset.del); persist(); home(); } }));
  app.querySelectorAll('[data-exp]').forEach((b) => (b.onclick = () => {
    const q = quizzes.find((x) => x.id === b.dataset.exp);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ title: q.title, questions: q.questions }, null, 2)], { type: 'application/json' }));
    a.download = q.title.replace(/[^\w-]+/g, '_') + '.json'; a.click();
  }));
}

// ---------------- Editor ----------------
function edit(q) {
  editing = q;
  const defTime = q.questions[q.questions.length - 1]?.time || 20;
  app.innerHTML = `
  <div class="row" style="margin-bottom:14px"><button class="btn plain sm" id="back">← Back</button><h2 class="sp">Quiz editor</h2>
    <button class="btn ghost" id="save">Save</button><button class="btn" id="savehost">Save & host ▶</button></div>
  <div class="card"><label class="f">Quiz title</label><input type="text" id="title" maxlength="80" placeholder="e.g. Friday pub quiz" value="${esc(q.title)}">
  <div class="row" style="margin-top:12px"><span class="muted small sp">Set a timer per question below, or apply one to all:</span>
  <select id="allt" style="width:auto">${[10, 15, 20, 30, 45, 60, 90, 120].map((s) => `<option value="${s}" ${s === defTime ? 'selected' : ''}>${s}s</option>`).join('')}</select>
  <button class="btn sm ghost" id="applyall">Apply to all</button></div></div>
  <div id="qs"></div>
  <button class="btn block ghost big" id="addq" style="margin-top:14px">+ Add question</button>
  <div class="err" id="err" style="margin-top:10px"></div>`;
  const draw = () => {
    $('#qs').innerHTML = q.questions.map((x, i) => `<div class="card qcard" data-q="${i}">
      <div class="qhead"><span class="qnum">${i + 1}</span><textarea data-f="text" maxlength="300" rows="2" placeholder="Type your question">${esc(x.text)}</textarea></div>
      ${x.options.map((o, k) => `<div class="opt-edit"><span class="dot" style="background:${COLORS[k]}"></span>
        <input type="text" data-o="${k}" maxlength="120" placeholder="Option ${k + 1}" value="${esc(o)}">
        <input type="radio" class="tick" name="c${i}" data-c="${k}" ${x.correct === k ? 'checked' : ''} title="Correct answer">
        ${x.options.length > 2 ? `<button class="btn sm plain" data-rm="${k}" title="Remove option">✕</button>` : ''}</div>`).join('')}
      <div class="qtools">
        ${x.options.length < 6 ? `<button class="btn sm plain" data-add>+ Option</button>` : ''}
        <button class="btn sm plain" data-tf>True/False</button>
        <label>⏱ <select data-f="time">${[5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300].map((s) => `<option value="${s}" ${s === x.time ? 'selected' : ''}>${s >= 60 ? s / 60 + ' min' : s + ' sec'}</option>`).join('')}</select></label>
        <label>Points <select data-f="points"><option value="1000" ${x.points === 1000 ? 'selected' : ''}>Standard</option><option value="2000" ${x.points === 2000 ? 'selected' : ''}>Double</option><option value="0" ${x.points === 0 ? 'selected' : ''}>None</option></select></label>
        <span class="sp"></span>
        <button class="btn sm plain" data-up ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn sm plain" data-dn ${i === q.questions.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn sm plain" data-dup>Duplicate</button>
        <button class="btn sm danger" data-del ${q.questions.length === 1 ? 'disabled' : ''}>Delete</button></div></div>`).join('');
  };
  draw();
  $('#qs').addEventListener('input', (e) => {
    const card = e.target.closest('[data-q]'); if (!card) return;
    const x = q.questions[+card.dataset.q];
    if (e.target.dataset.o !== undefined) x.options[+e.target.dataset.o] = e.target.value;
    else if (e.target.dataset.f === 'text') x.text = e.target.value;
  });
  $('#qs').addEventListener('change', (e) => {
    const card = e.target.closest('[data-q]'); if (!card) return;
    const x = q.questions[+card.dataset.q];
    if (e.target.dataset.c !== undefined) x.correct = +e.target.dataset.c;
    else if (e.target.dataset.f === 'time' || e.target.dataset.f === 'points') x[e.target.dataset.f] = +e.target.value;
  });
  $('#qs').addEventListener('click', (e) => {
    const card = e.target.closest('[data-q]'); const btn = e.target.closest('button'); if (!card || !btn) return;
    const i = +card.dataset.q, x = q.questions[i], d = btn.dataset;
    if ('add' in d) x.options.push('');
    else if ('rm' in d) { const k = +d.rm; x.options.splice(k, 1); if (x.correct >= x.options.length) x.correct = 0; else if (x.correct > k) x.correct--; }
    else if ('tf' in d) { x.options = ['True', 'False']; x.correct = 0; }
    else if ('up' in d) [q.questions[i - 1], q.questions[i]] = [q.questions[i], q.questions[i - 1]];
    else if ('dn' in d) [q.questions[i + 1], q.questions[i]] = [q.questions[i], q.questions[i + 1]];
    else if ('dup' in d) q.questions.splice(i + 1, 0, structuredClone(x));
    else if ('del' in d) q.questions.splice(i, 1);
    else return;
    draw();
  });
  $('#addq').onclick = () => { q.questions.push(blankQ(+$('#allt').value)); draw(); app.querySelector('#qs .card:last-child textarea').focus(); };
  $('#applyall').onclick = () => { q.questions.forEach((x) => (x.time = +$('#allt').value)); draw(); toast('Timer applied to all questions'); };
  $('#title').oninput = (e) => (q.title = e.target.value);
  $('#back').onclick = () => { if (confirm('Leave without saving?')) home(); };
  const save = () => {
    q.title = q.title.trim();
    if (!q.title) return fail('Give your quiz a title');
    for (let i = 0; i < q.questions.length; i++) {
      const x = q.questions[i];
      if (!x.text.trim()) return fail(`Question ${i + 1} needs text`);
      const filled = x.options.map((o) => o.trim());
      if (filled.some((o) => !o)) return fail(`Question ${i + 1} has an empty option — fill or remove it`);
      if (new Set(filled.map((o) => o.toLowerCase())).size !== filled.length) return fail(`Question ${i + 1} has duplicate options`);
    }
    const at = quizzes.findIndex((z) => z.id === q.id);
    if (at >= 0) quizzes[at] = q; else quizzes.unshift(q);
    persist(); return true;
  };
  const fail = (m) => { $('#err').textContent = m; return false; };
  $('#save').onclick = () => { if (save()) { toast('Saved'); home(); } };
  $('#savehost').onclick = () => { if (save()) startGame(q); };
}

// ---------------- Live hosting ----------------
async function startGame(q) {
  try {
    game = await post('/api/games', { quiz: { title: q.title, questions: q.questions } });
    sessionStorage.setItem(SESSION, JSON.stringify(game));
    live();
  } catch (e) { toast(e.message); }
}
function stopAll() { stopTimer && stopTimer(); stopTimer = null; link && link.close(); link = null; }
const hostCall = (action, extra = {}) => post(`/api/games/${game.pin}/host`, { key: game.hostKey, action, ...extra }).catch((e) => toast(e.message));

async function live() {
  lastView = null;
  stopAll();
  try { const i = await (await fetch('/api/info')).json(); lan = i.lan.map((ip) => `http://${ip}:${i.port}`); } catch (e) {}
  const isLocal = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  if (isLocal && lan.length) baseUrl = lan[0];
  link = connect(`/api/games/${game.pin}/events?role=host&key=${game.hostKey}`, renderLive, (ok) => ($('#conn').textContent = ok ? '' : 'Reconnecting…'));
  setTimeout(() => { if (!lastView) { sessionStorage.removeItem(SESSION); toast('That game no longer exists'); home(); } }, 4000);
}

function joinUrl() { return `${baseUrl.replace(/\/$/, '')}/join/${game.pin}`; }
function qrSvg(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 6, margin: 0, scalable: true }); }

function renderLive(v) {
  lastView = v;
  stopTimer && stopTimer(); stopTimer = null;
  if (v.state === 'lobby') {
    const isLocal = /^(localhost|127\.|\[::1\])/.test(new URL(baseUrl).hostname);
    app.innerHTML = `<div class="lobby">
      <div class="card center"><div class="qr">${qrSvg(joinUrl())}</div>
        <p class="muted small" style="margin:12px 0 4px">Scan with your phone camera, or go to</p>
        <div class="joinurl" id="ju">${esc(joinUrl())}</div>
        <p class="muted small">and enter PIN</p><div class="pin">${v.pin}</div>
        ${isLocal ? `<p class="err small">⚠ “localhost” won't work on phones. Open this page using your computer's network address${lan.length ? '' : ' (e.g. http://192.168.x.x:3000)'} or a public URL.</p>` : ''}
        <div class="row" style="justify-content:center;margin-top:10px">
          ${lan.length > 1 || (lan.length && isLocal) ? `<select id="base" style="width:auto">${[...lan, location.origin].filter((x, i, a) => a.indexOf(x) === i).map((u) => `<option ${u === baseUrl ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>` : ''}
          <button class="btn sm ghost" id="copy">Copy link</button><button class="btn sm ghost" id="custom">Set address…</button></div></div>
      <div><div class="card"><div class="row"><h2 class="sp">${esc(v.title)}</h2><span class="chip">${v.total} questions</span></div>
        <p class="muted">${v.players.length ? `${v.players.length} player${v.players.length === 1 ? '' : 's'} in the lobby` : 'Waiting for players to join…'}</p>
        <div class="row" id="plist">${v.players.map((p) => `<span class="chip pop">${esc(p.name)}<button data-k="${p.id}" title="Remove">✕</button></span>`).join('')}</div></div>
        <div class="row" style="margin-top:14px"><button class="btn big sp" id="go" ${v.players.length ? '' : 'disabled'}>Start quiz ▶</button><button class="btn plain" id="end">Cancel</button></div></div></div>`;
    $('#go').onclick = () => hostCall('start');
    $('#end').onclick = () => { if (confirm('Cancel this game?')) { end(); } };
    $('#copy').onclick = () => navigator.clipboard.writeText(joinUrl()).then(() => toast('Link copied'), () => toast(joinUrl()));
    $('#custom').onclick = () => { const u = prompt('Public address players should use (e.g. https://quiz.example.com):', baseUrl); if (u && /^https?:\/\//.test(u)) { baseUrl = u; renderLive(v); } };
    if ($('#base')) $('#base').onchange = (e) => { baseUrl = e.target.value; renderLive(v); };
    app.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => hostCall('kick', { pid: b.dataset.k })));
  } else if (v.state === 'question' || v.state === 'reveal') {
    const rev = v.state === 'reveal';
    const last = v.qi + 1 >= v.total;
    app.innerHTML = `<div class="meta"><span>Question ${v.qi + 1} / ${v.total}</span><span>PIN ${v.pin} · ${v.answered}/${v.playerCount} answered</span></div>
      ${rev ? '' : `<div class="timer"><div class="bar"><i></i></div><div class="tnum">–</div></div>`}
      <div class="qtext">${esc(v.q.text)}</div>
      ${optionsHtml(v.q, rev ? { correct: v.q.correct, counts: v.dist } : { counts: v.liveDist })}
      <div class="row" style="margin-top:18px;justify-content:center">
        ${rev ? `<button class="btn big" id="next">${last ? 'Finish & show results 🏆' : 'Next question ▶'}</button>`
          : `<button class="btn ghost" id="plus">+10 s</button><button class="btn big" id="rev">Reveal answer now</button>`}
        <button class="btn plain" id="end">End quiz</button></div>
      ${rev ? `<div class="card" style="margin-top:18px"><h3 style="margin-bottom:10px">Leaderboard</h3>${leaderboardHtml(v.board)}</div>` : ''}`;
    if (!rev) stopTimer = runTimer(v, $('.bar'), $('.tnum'));
    if (rev) $('#next').onclick = () => hostCall('next'); else { $('#rev').onclick = () => hostCall('reveal'); $('#plus').onclick = () => hostCall('extend', { seconds: 10 }); }
    $('#end').onclick = () => { if (confirm('End the quiz now and show final results?')) hostCall('end'); };
  } else if (v.state === 'finished') {
    sessionStorage.removeItem(SESSION);
    app.innerHTML = `<div class="hero" style="padding-bottom:0"><h1>🏆 Final results</h1><p class="muted">${esc(v.title)} · ${v.playerCount} players</p></div>
      ${podiumHtml(v.board.slice(0, 3))}
      <div class="grid g2"><div class="card"><h3 style="margin-bottom:10px">Leaderboard</h3>${v.board.length ? leaderboardHtml(v.board) : '<p class="muted">No players.</p>'}</div>
      <div class="card"><h3 style="margin-bottom:10px">How each question went</h3>${v.stats.map((s, i) => { const pct = s.answered ? Math.round((100 * s.correct) / s.answered) : 0; return `<div class="stat-row"><span class="muted">${i + 1}</span><span class="t">${esc(s.text)}</span><span class="mini"><i style="width:${pct}%"></i></span><b>${pct}%</b></div>`; }).join('')}</div></div>
      <div class="row" style="margin-top:16px;justify-content:center"><a class="btn" href="/api/games/${v.pin}/results.csv?key=${game.hostKey}">⬇ Download results (CSV)</a><button class="btn ghost" id="done">Back to my quizzes</button></div>`;
    $('#done').onclick = () => { stopAll(); lastView = null; home(); };
    stopAll2();
  }
}
function stopAll2() { /* keep SSE open so CSV/state stay live; nothing to do */ }
async function end() { await hostCall('end'); stopAll(); sessionStorage.removeItem(SESSION); lastView = null; home(); }

home();
