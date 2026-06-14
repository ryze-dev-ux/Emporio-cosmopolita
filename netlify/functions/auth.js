'use strict';

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROLES        = { ADMIN: 'admin', CLIENT: 'client' };
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const _revoked     = new Set();

function secret() {
  return process.env.ADMIN_SECRET || 'ec-dev-secret-troque-em-producao-2025';
}

function users() {
  return [
    {
      username:     process.env.AUTH_ADMIN_USER || 'admin',
      passwordHash: sha256(process.env.AUTH_ADMIN_PASS || 'admin123'),
      role: ROLES.ADMIN,
      name: 'Administrador',
    },
    {
      username:     process.env.AUTH_CLIENT_USER || 'cliente',
      passwordHash: sha256(process.env.AUTH_CLIENT_PASS || 'cliente123'),
      role: ROLES.CLIENT,
      name: 'Cliente',
    },
  ];
}

function sha256(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}
function sign(p) {
  return crypto.createHmac('sha256', secret()).update(p).digest('base64url');
}
function generateToken(user) {
  const now = Date.now();
  const p   = Buffer.from(JSON.stringify({
    sub: user.username, role: user.role, name: user.name,
    iat: now, exp: now + TOKEN_TTL_MS,
  })).toString('base64url');
  return p + '.' + sign(p);
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (_revoked.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [p, sig] = parts;
  try {
    if (!crypto.timingSafeEqual(
      Buffer.from(sig,    'base64url'),
      Buffer.from(sign(p),'base64url')
    )) return null;
  } catch { return null; }
  let data;
  try { data = JSON.parse(Buffer.from(p, 'base64url').toString()); }
  catch { return null; }
  if (!data || Date.now() > data.exp) return null;
  return data;
}

function reply(status, obj) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { error: 'Método não permitido.' });

  // Lê o body (com suporte a base64 do Netlify)
  let raw = event.body || '{}';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');

  let body;
  try { body = JSON.parse(raw); }
  catch { return reply(400, { error: 'JSON inválido.' }); }

  // Detecta ação: primeiro pelo path, depois pelo campo action no body
  const pathLast = (event.path || event.rawPath || '').split('/').filter(Boolean).pop() || '';
  const action   = ['login','verify','logout'].includes(pathLast)
    ? pathLast
    : (['login','verify','logout'].includes(body.action) ? body.action : null);

  // LOGIN
  if (action === 'login') {
    const { username, password } = body;
    if (!username || !password)
      return reply(400, { error: 'Usuário e senha são obrigatórios.' });

    await new Promise(r => setTimeout(r, 80 + Math.random() * 80));

    const user = users().find(
      u => u.username === String(username).trim() && u.passwordHash === sha256(password)
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

  // VERIFY
  if (action === 'verify') {
    const data = verifyToken(body.token);
    if (!data) return reply(401, { valid: false, error: 'Token inválido ou expirado.' });
    return reply(200, { valid: true, role: data.role, username: data.sub, name: data.name, expiresAt: data.exp });
  }

  // LOGOUT
  if (action === 'logout') {
    if (body.token) _revoked.add(body.token);
    return reply(200, { ok: true });
  }

  return reply(400, { error: 'Ação inválida. Use: login, verify ou logout.' });
};

exports.verifyToken = verifyToken;
exports.ROLES       = ROLES;
