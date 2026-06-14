'use strict';

const fs = require('fs');
const CATALOG_PATH = '/tmp/wines-catalog.json';

exports.handler = async () => {
  let catalog = { loaded: false };
  try {
    if (fs.existsSync(CATALOG_PATH)) {
      const d = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      catalog = { loaded: true, count: (d.wines || []).length, importedAt: d.meta?.importedAt };
    }
  } catch (e) { catalog.error = e.message; }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      status:      'ok',
      apiKey:      process.env.OPENROUTER_API_KEY ? 'configured' : 'missing',
      adminSecret: process.env.ADMIN_SECRET       ? 'configured' : 'using-default',
      model:       'meta-llama/llama-3.3-70b-instruct:free',
      provider:    'OpenRouter',
      catalog,
      ts:          new Date().toISOString(),
    }),
  };
};
