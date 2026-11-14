'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
const SHAPES = [
  '<svg class="shape" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 22 21H2z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 22 12 12 22 2 12z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7 7 .6-5.3 4.7 1.7 7.2L12 17.8 5.6 21.5l1.7-7.2L2 9.6 9 9z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 21 7v10l-9 5-9-5V7z"/></svg>',
];

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast pop';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}

// Live connection with server-clock sync. Calls onView(view) for each update.
function connect(url, onView, onStatus) {
  let es, offset = 0, closed = false;
  const open = () => {
    es = new EventSource(url);
    es.onmessage = (e) => {
      const v = JSON.parse(e.data);
      offset = v.now - Date.now();
      v.skew = offset;
      onStatus && onStatus(true);
      onView(v);
    };
    es.onerror = () => {
      onStatus && onStatus(false);
      if (es.readyState === 2 && !closed) setTimeout(open, 2000);
    };
  };
  open();
  return { close() { closed = true; es.close(); }, serverNow: () => Date.now() + offset };
}

// Drives a countdown bar + number from a view. Returns stop().
function runTimer(view, barEl, numEl, onDone) {
  let raf, done = false;
  const total = view.q.time * 1000;
  const tick = () => {
    const left = Math.max(0, view.qEnd - (Date.now() + view.skew));
    // qEnd can be extended by host; total only for bar scale
    const frac = Math.min(1, left / Math.max(total, left));
    if (barEl) { barEl.firstElementChild.style.width = frac * 100 + '%'; barEl.classList.toggle('low', left < 5000); }
    if (numEl) { numEl.textContent = Math.ceil(left / 1000); numEl.classList.toggle('low', left < 5000); }
    if (left <= 0) { if (!done && onDone) onDone(); done = true; return; }
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(raf);
}

function optionsHtml(q, o = {}) {
  // o: {click, counts, correct, mine, dim}
  return `<div class="opts ${q.options.length % 2 === 0 || q.options.length > 4 ? 'two' : ''}">` + q.options.map((t, i) => {
    const cls = ['opt'];
    if (o.correct !== undefined) { if (i === o.correct) cls.push('right'); else cls.push('dim'); }
    if (o.mine === i) cls.push('mine');
    return `<button class="${cls.join(' ')}" data-i="${i}" style="background:${COLORS[i]}" ${o.click ? '' : 'disabled'}>${SHAPES[i]}<span>${esc(t)}</span>${o.counts ? `<span class="cnt">${o.counts[i]}</span>` : ''}</button>`;
  }).join('') + '</div>';
}

function leaderboardHtml(list, meId) {
  return `<ol class="lb">` + list.map((p) => `<li class="${p.id === meId ? 'me' : ''}"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)}${p.streak >= 3 ? ' 🔥' : ''}</span><span class="sc">${p.score.toLocaleString()}</span></li>`).join('') + '</ol>';
}

function podiumHtml(b) {
  const top = [b[1], b[0], b[2]].filter(Boolean);
  return `<div class="podium">` + top.map((p) => `<div class="p${p.rank}"><b>${esc(p.name)}</b><span class="muted small">${p.score.toLocaleString()}</span><div class="blk">${p.rank}</div></div>`).join('') + '</div>';
}
