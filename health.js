'use strict';
const { providerInfo } = require('../lib/generate');
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, ...providerInfo() }));
};
