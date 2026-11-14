'use strict';
// Local dev server (zero deps). On Vercel, public/ is served statically and api/index.js handles the API.
const http = require('http');
const fs = require('fs');
const path = require('path');
const handle = require('./lib/router');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname.startsWith('/api/')) return handle(req, res, url.pathname, Object.fromEntries(url.searchParams));
  let p = decodeURIComponent(url.pathname);
  if (/^\/join\/\d+$/.test(p)) p = '/play.html';
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`QuizLive running:\n  http://localhost:${PORT}`);
    for (const l of Object.values(require('os').networkInterfaces())) for (const i of l || []) if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}   (phones on the same Wi-Fi)`);
  });
}
module.exports = { server };
