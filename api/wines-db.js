'use strict';

const fs = require('fs');
const { verifyToken, ROLES } = require('./auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const TMP_PATH  = '/tmp/wines-catalog.json';
const BLOB_KEY  = 'wines-catalog';

function requireAdmin(event) {
  const h     = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token)                    return { ok: false, res: reply(401, { error: 'Autenticação necessária.' }) };
  const data = verifyToken(token);
  if (!data)                     return { ok: false, res: reply(401, { error: 'Token inválido ou expirado.' }) };
  if (data.role !== ROLES.ADMIN) return { ok: false, res: reply(403, { error: 'Acesso negado.' }) };
  return { ok: true };
}

/* ── Persistência: tenta Blobs, fallback /tmp ─────────────── */
async function saveCatalog(data) {
  // Sempre salva em /tmp (rápido, mesma instância)
  try { fs.writeFileSync(TMP_PATH, JSON.stringify(data)); } catch {}

  // Tenta salvar em Netlify Blobs (persiste entre instâncias)
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({ name: 'emporio-catalog', consistency: 'strong' });
    await store.setJSON(BLOB_KEY, data);
    return 'blobs';
  } catch (e) {
    console.warn('[wines-db] Blobs indisponível, usando apenas /tmp:', e.message);
    return 'tmp';
  }
}

async function readCatalog() {
  // 1. Tenta Netlify Blobs (fonte confiável)
  try {
    const { getStore } = require('@netlify/blobs');
    const store   = getStore({ name: 'emporio-catalog', consistency: 'strong' });
    const catalog = await store.get(BLOB_KEY, { type: 'json' });
    if (catalog?.wines?.length) return catalog;
  } catch {}

  // 2. Fallback: /tmp (mesma instância)
  try {
    if (fs.existsSync(TMP_PATH)) {
      const d = JSON.parse(fs.readFileSync(TMP_PATH, 'utf8'));
      if (d?.wines?.length) return d;
    }
  } catch {}

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  /* GET — catálogo público */
  if (event.httpMethod === 'GET') {
    const catalog = await readCatalog();
    if (!catalog) return reply(404, { error: 'Nenhum catálogo carregado.' });
    return reply(200, catalog);
  }

  /* POST — salva catálogo (requer admin) */
  if (event.httpMethod === 'POST') {
    const guard = requireAdmin(event);
    if (!guard.ok) return guard.res;

    let raw = event.body || '{}';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');

    let body;
    try { body = JSON.parse(raw); }
    catch { return reply(400, { error: 'JSON inválido.' }); }

    if (!Array.isArray(body.wines))
      return reply(422, { error: 'Campo "wines" ausente ou inválido.' });
    if (!body.wines.length)
      return reply(422, { error: 'Nenhum vinho com estoque encontrado.' });

    const storage = await saveCatalog(body);

    return reply(200, {
      success: true,
      message: body.wines.length + ' vinhos importados.',
      storage,
      meta:    body.meta || {},
      wines:   body.wines,
    });
  }

  return reply(405, { error: 'Método não permitido.' });
};

function reply(s, o) {
  return {
    statusCode: s,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(o),
  };
}
