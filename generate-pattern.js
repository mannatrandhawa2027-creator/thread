/* Vercel serverless function - same logic as server.js, for Vercel deploys. */
'use strict';
const { generate, providerInfo, CONFIG_HELP } = require('../lib/generate');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'GET') {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ...providerInfo() }));
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: { message: 'POST only.' } }));
  }
  try {
    const prefs = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { pattern, meta } = await generate(prefs || {});
    res.statusCode = 200;
    res.end(JSON.stringify({ pattern, meta }));
  } catch (e) {
    res.statusCode = e.code === 'NO_PROVIDER' ? 503 : 502;
    res.end(JSON.stringify({
      error: { code: e.code || 'UPSTREAM', message: e.message, config: e.code === 'NO_PROVIDER' ? CONFIG_HELP : undefined }
    }));
  }
};
