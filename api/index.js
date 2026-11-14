'use strict';
// Single Vercel function for the whole API (see vercel.json rewrites).
const handle = require('../lib/router');
module.exports = (req, res) => {
  const u = new URL(req.url, 'http://x');
  const query = Object.fromEntries(u.searchParams);
  // vercel.json rewrites /api/x/y -> /api/index.js?p=x/y ; fall back to the raw path when p is absent
  const pathname = query.p !== undefined ? '/api/' + query.p : u.pathname;
  delete query.p;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return handle(req, res, pathname, query);
};
