/* ============================================================
   Thread - zero-dependency Node server (Node 18+).
   Serves the static app from /public and the AI endpoint
   POST /api/generate-pattern. Keys stay server-side only.
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { generate, providerInfo, CONFIG_HELP } = require('./lib/generate');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 12 * 1024 * 1024; // 12 MB - room for a downscaled base64 photo

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Upload too large (12 MB max).'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validatePrefs(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['Missing request body.'];
  if (!['Knitting', 'Crochet'].includes(p.craftType)) errors.push('craftType must be Knitting or Crochet.');
  if (!['Beginner', 'Beginner+', 'Intermediate'].includes(p.skillLevel)) errors.push('Invalid skillLevel.');
  if (!['Small', 'Medium', 'Large'].includes(p.size)) errors.push('Invalid size.');
  for (const f of ['yarnType', 'yarnWeight', 'yarnQuantity']) {
    if (typeof p[f] !== 'string' || !p[f].trim()) errors.push(f + ' is required (or "I don\'t know").');
  }
  return errors;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, ...providerInfo() });
  }

  if (url.pathname === '/api/generate-pattern') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only.' } });
    let prefs;
    try {
      prefs = JSON.parse(await readBody(req));
    } catch (e) {
      return sendJson(res, e.code === 'TOO_LARGE' ? 413 : 400, { error: { code: e.code || 'BAD_JSON', message: e.message } });
    }
    const errors = validatePrefs(prefs);
    if (errors.length) return sendJson(res, 422, { error: { code: 'VALIDATION', message: errors.join(' ') } });

    try {
      const { pattern, meta } = await generate(prefs);
      return sendJson(res, 200, { pattern, meta });
    } catch (e) {
      if (e.code === 'NO_PROVIDER') {
        return sendJson(res, 503, { error: { code: 'NO_PROVIDER', message: e.message, config: CONFIG_HELP } });
      }
      console.error('[generate]', e);
      return sendJson(res, 502, { error: { code: 'UPSTREAM', message: e.message || 'The AI provider failed. Please try again.' } });
    }
  }

  // static files
  let filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  if (url.pathname === '/' || url.pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-ish fallback: unknown non-api paths serve index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const info = providerInfo();
  console.log(`Thread running at http://localhost:${PORT}`);
  console.log(`AI provider: ${info.provider}${info.vision ? ' (vision enabled)' : ' (text only)'}`);
});
