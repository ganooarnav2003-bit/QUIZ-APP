'use strict';
// Storage: Upstash/Vercel KV (Redis over REST) when configured, else in-memory (local dev / tests).
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const TTL = 6 * 3600;

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Storage error: ' + (j.error || r.status));
  return j.result;
}

const remote = {
  kind: 'redis',
  async get(k) { const v = await redis(['GET', k]); return v ? JSON.parse(v) : null; },
  async set(k, v) { await redis(['SET', k, JSON.stringify(v), 'EX', TTL]); },
  async setNx(k, v) { return (await redis(['SET', k, JSON.stringify(v), 'EX', TTL, 'NX'])) === 'OK'; },
  async lock(k) { return (await redis(['SET', k, '1', 'PX', 4000, 'NX'])) === 'OK'; },
  async unlock(k) { await redis(['DEL', k]); },
};

const mem = new Map();
const local = {
  kind: 'memory',
  async get(k) { const e = mem.get(k); return e ? JSON.parse(e.v) : null; },
  async set(k, v) { mem.set(k, { v: JSON.stringify(v), t: Date.now() }); },
  async setNx(k, v) { if (mem.has(k)) return false; mem.set(k, { v: JSON.stringify(v), t: Date.now() }); return true; },
  async lock(k) { const e = mem.get(k); if (e && Date.now() - e.t < 4000) return false; mem.set(k, { v: '1', t: Date.now() }); return true; },
  async unlock(k) { mem.delete(k); },
};
setInterval(() => { const now = Date.now(); for (const [k, e] of mem) if (now - e.t > TTL * 1000) mem.delete(k); }, 600000).unref();

const onVercel = !!process.env.VERCEL;
module.exports = URL_ && TOKEN ? remote : (onVercel ? null : local);
