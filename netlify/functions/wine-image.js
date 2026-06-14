'use strict';

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: null }) };

  const q = event.queryStringParameters?.q || 'wine bottle';

  try {
    const url = await searchPexels(apiKey, q);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      body: JSON.stringify({ url }),
    };
  } catch {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: null }) };
  }
};

function searchPexels(apiKey, query) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.pexels.com',
      path: `/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=portrait`,
      method: 'GET',
      headers: { Authorization: apiKey },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          // Pega a segunda foto se disponível (evitar sempre a mesma)
          const photo = p.photos?.[1] || p.photos?.[0];
          resolve(photo?.src?.medium || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}
