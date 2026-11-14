'use strict';
const app = $('#app');
let pin = (location.pathname.match(/\/join\/(\d{6})/) || [])[1] || new URLSearchParams(location.search).get('pin') || '';
const key = (p) => 'quizlive.player.' + p;
let stopTimer = null, link = null, lastSig = '';

function saved() { try { return JSON.parse(localStorage.getItem(key(pin)) || 'null'); } catch (e) { return null; } }

function joinScreen(msg) {
  app.innerHTML = `
  <div class="hero"><h1>Join a quiz</h1><p class="muted">Enter the PIN shown on the host's screen.</p></div>
  <form class="card grid" id="f">
    ${pin ? '' : `<div><label class="f">Game PIN</label><input type="text" id="pin" class="pinbox" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off"></div>`}
    <div><label class="f">Your name</label><input type="text" id="name" maxlength="20" placeholder="e.g. Alex" autocomplete="nickname"></div>
    <div class="err" id="err">${esc(msg || '')}</div>
    <button class="btn big block">Join</button>
  </form>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const p = pin || $('#pin').value.trim();
    const name = $('#name').value.trim();
    if (!/^\d{6}$/.test(p)) return ($('#err').textContent = 'Enter the 6-digit PIN');
    if (!name) return ($('#err').textContent = 'Enter your name');
    try {
      const r = await post(`/api/games/${p}/join`, { name });
      pin = p;
      localStorage.setItem(key(p), JSON.stringify({ pid: r.pid, name }));
      history.replaceState(null, '', '/join/' + p);
      start(r.pid);
    } catch (er) { $('#err').textContent = er.message; }
  };
}

function start(pid) {
  link && link.close();
  link = connect(`/api/games/${pin}/events?pid=${pid}`, render, (ok) => ($('#conn').textContent = ok ? '' : 'Reconnecting…'));
  // If the server rejects (game gone), EventSource will keep failing: probe once.
  setTimeout(async () => {
    if (!lastSig) {
      localStorage.removeItem(key(pin));
      link.close();
      joinScreen('Could not rejoin that game. Enter your name to join again.');
    }
  }, 4000);
}

function render(v) {
  lastSig = v.state;
  stopTimer && stopTimer();
  stopTimer = null;
  if (v.kicked) { localStorage.removeItem(key(pin)); link.close(); return joinScreen('You were removed from the game.'); }
  const me = v.me;
  const head = `<div class="meta"><span>${esc(me.name)}</span><span>${me.score.toLocaleString()} pts${me.streak >= 2 ? ' · 🔥' + me.streak : ''}</span></div>`;

  if (v.state === 'lobby') {
    app.innerHTML = `${head}<div class="card center pop" style="margin-top:20px"><h2>You're in! 🎉</h2><p class="bigname">${esc(me.name)}</p>
      <p class="muted pulse">Waiting for the host to start…</p><p class="small muted">${v.playerCount} player${v.playerCount === 1 ? '' : 's'} joined · ${esc(v.title)}</p></div>`;
  } else if (v.state === 'question') {
    const answered = v.my !== undefined;
    app.innerHTML = `${head}<div class="meta"><span>Question ${v.qi + 1} of ${v.total}</span><span>${v.q.points ? v.q.points + ' pts' : 'No points'}</span></div>
      <div class="timer"><div class="bar"><i></i></div><div class="tnum">–</div></div>
      <div class="qtext" style="font-size:clamp(20px,5.5vw,28px)">${esc(v.q.text)}</div>
      ${answered ? '' : optionsHtml(v.q, { click: true })}
      ${answered ? `<div class="card center pop"><h3>Answer locked in ✓</h3><p class="muted pulse">Waiting for the others…</p></div>` : ''}`;
    stopTimer = runTimer(v, $('.bar'), $('.tnum'));
    if (!answered) app.querySelectorAll('.opt').forEach((b) => (b.onclick = async () => {
      app.querySelectorAll('.opt').forEach((x) => (x.disabled = true));
      b.style.outline = '4px solid var(--ink)';
      try { await post(`/api/games/${pin}/answer`, { pid: saved().pid, choice: +b.dataset.i }); navigator.vibrate && navigator.vibrate(30); }
      catch (e) { toast(e.message); }
    }));
  } else if (v.state === 'reveal') {
    const my = v.my;
    const cls = my ? (my.ok ? 'ok' : 'bad') : 'bad';
    const title = my ? (my.ok ? 'Correct! ✓' : 'Wrong ✗') : "Time's up ⏱";
    app.innerHTML = `${head}<div class="result ${cls} pop">${title}<small>${my && my.ok ? '+' + my.pts.toLocaleString() + ' points' : 'No points this round'}</small></div>
      <div class="card" style="margin-top:14px"><div class="muted small" style="margin-bottom:6px">Correct answer</div><b>${esc(v.q.options[v.q.correct])}</b></div>
      <div class="card"><div class="meta"><span>You're #${me.rank} of ${v.playerCount}</span></div>${leaderboardHtml(v.board, me.id)}</div>
      <p class="center muted small">Next question coming up…</p>`;
  } else if (v.state === 'finished') {
    const top = v.board.slice(0, 3);
    app.innerHTML = `<div class="hero" style="padding-bottom:0"><h1>Quiz complete!</h1><p class="muted">${esc(v.title)}</p></div>
      ${podiumHtml(top)}
      <div class="card center pop"><div class="muted">You finished</div><div class="pin" style="font-size:56px">#${me.rank}</div>
      <p><b>${me.score.toLocaleString()}</b> points · ${me.correct} of ${v.total} correct</p></div>
      <div class="card">${leaderboardHtml(v.board, me.id)}</div>
      <a class="btn ghost block" href="/" style="margin-top:14px">Host your own quiz</a>`;
  }
}

const s = saved();
if (pin && s) start(s.pid);
else if (pin) {
  fetch(`/api/games/${pin}/info`).then((r) => r.json()).then((j) => {
    if (j.error) { pin = ''; joinScreen(j.error); }
    else joinScreen();
  });
} else joinScreen();
