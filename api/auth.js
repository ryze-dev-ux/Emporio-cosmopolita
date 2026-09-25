'use strict';

/**
 * netlify/functions/auth.js
 * Empório Cosmopolita — Autenticação
 *
 * POST /api/auth/login   → { username, password } → { token, role, name, expiresAt }
 * POST /api/auth/verify  → { token } → { valid, role, username, name }
 * POST /api/auth/logout  → { token } → 204
 *
 * Credenciais via variáveis de ambiente (Netlify → Site Settings → Env Vars):
 *   ADMIN_SECRET        segredo HMAC (obrigatório em produção)
 *   AUTH_ADMIN_USER     usuário admin  (padrão: admin)
 *   AUTH_ADMIN_PASS     senha admin    (padrão: admin123)
 *   AUTH_CLIENT_USER    usuário cliente (padrão: cliente)
 *   AUTH_CLIENT_PASS    senha cliente   (padrão: cliente123)
 */

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROLES = { ADMIN: 'admin', CLIENT: 'client' };
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas

/* ── Lista negra de tokens revogados (em memória) ── */
const _revoked = new Set();

/* ── Segredo HMAC ── */
function secret() {
  return process.env.ADMIN_SECRET || 'ec-dev-secret-troque-em-producao-2025';
}

/* ── Usuários (carregados das env vars) ── */
function users() {
  return [
    {
      username:     process.env.AUTH_ADMIN_USER  || 'admin',
      passwordHash: sha256(process.env.AUTH_ADMIN_PASS  || 'admin123'),
      role:         ROLES.ADMIN,
      name:         'Administrador',
    },
    {
      username:     process.env.AUTH_CLIENT_USER || 'cliente',
      passwordHash: sha256(process.env.AUTH_CLIENT_PASS || 'cliente123'),
      role:         ROLES.CLIENT,
      name:         'Cliente',
    },
  ];
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function generateToken(user) {
  const now     = Date.now();
  const payload = Buffer.from(JSON.stringify({
    sub:  user.username,
    role: user.role,
    name: user.name,
    iat:  now,
    exp:  now + TOKEN_TTL_MS,
  })).toString('base64url');
  return payload + '.' + sign(payload);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (_revoked.has(token)) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  const expected = sign(payload);

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(sig,      'base64url'),
      Buffer.from(expected, 'base64url')
    );
  } catch { return null; }

  if (!valid) return null;

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { return null; }

  if (!data || Date.now() > data.exp) return null;
  return data;
}

module.exports = async (req, res) => {
  const event = {
    httpMethod: req.method,
    queryStringParameters: req.query || {},
    headers: req.headers || {},
    body: null,
  };
  const result = await _handler(event);
  if (result.headers) Object.entries(result.headers).forEach(([k,v]) => res.setHeader(k,v));
  if (result.isBase64Encoded) {
    res.status(result.statusCode).send(Buffer.from(result.body,'base64'));
  } else {
    res.status(result.statusCode).send(result.body);
  }
};

async function _handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { error: 'Método não permitido.' });

  // Detecta ação pelo path OU pelo campo 'action' no body
  // Com URLs nativas Netlify, o path pode variar: /auth, /auth/login, etc.
  const pathAction = (event.path || event.rawPath || '').split('/').filter(Boolean).pop();
  let action = ['login','verify','logout'].includes(pathAction) ? pathAction : null;

  // Fallback: lê do body se não veio no path
  if (!action) {
    try {
      const b = JSON.parse(event.body || '{}');
      if (['login','verify','logout'].includes(b.action)) action = b.action;
    } catch { }
  }

  // Log para diagnóstico
  console.log('[auth] path:', event.path, '| rawPath:', event.rawPath, '| action:', action);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { error: 'JSON inválido.' }); }

  /* LOGIN */
  if (action === 'login') {
    const { username, password } = body;
    if (!username || !password)
      return reply(400, { error: 'Usuário e senha são obrigatórios.' });

    await new Promise(r => setTimeout(r, 80 + Math.random() * 80)); // anti-timing

    const user = users().find(
      u => u.username === username.trim() && u.passwordHash === sha256(password)
    );
    if (!user) return reply(401, { error: 'Usuário ou senha incorretos.' });

    const token = generateToken(user);
    return reply(200, {
      token,
      role:      user.role,
      name:      user.name,
      username:  user.username,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
  }

  /* VERIFY */
  if (action === 'verify') {
    const data = verifyToken(body.token);
    if (!data) return reply(401, { valid: false, error: 'Token inválido ou expirado.' });
    return reply(200, { valid: true, role: data.role, username: data.sub, name: data.name, expiresAt: data.exp });
  }

  /* LOGOUT */
  if (action === 'logout') {
    if (body.token) _revoked.add(body.token);
    return reply(200, { ok: true });
  }

  return reply(404, { error: 'Ação não encontrada.' });
};

exports.verifyToken = verifyToken;
exports.ROLES       = ROLES;

function reply(status, obj) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}
