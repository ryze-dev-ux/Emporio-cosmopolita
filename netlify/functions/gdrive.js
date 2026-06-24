'use strict';

/**
 * gdrive.js — Netlify Function
 * Lê planilha xlsx e lista imagens diretamente do Google Drive
 * usando Service Account (sem login de usuário).
 *
 * Variáveis de ambiente no Netlify:
 *   GOOGLE_CREDENTIALS  → conteúdo do credentials.json
 *   GDRIVE_SHEET_ID     → ID do xlsx no Drive
 *   GDRIVE_IMAGES_ID    → ID da pasta de imagens
 */

'use strict';
const https  = require('https');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/* ── JWT para Service Account ──────────────────────────── */
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function getToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(Buffer.from(JSON.stringify({ alg:'RS256', typ:'JWT' })));
  const pay = b64url(Buffer.from(JSON.stringify({
    iss:   creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now, exp: now + 3600,
  })));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${hdr}.${pay}`).sign(creds.private_key));
  const jwt = `${hdr}.${pay}.${sig}`;

  return new Promise((res, rej) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req  = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'Content-Length': Buffer.byteLength(body) },
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        const p = JSON.parse(d);
        if (p.error) return rej(new Error(p.error_description || p.error));
        res(p.access_token);
      });
    });
    req.on('error', rej);
    req.write(body); req.end();
  });
}

/* ── Drive API genérica ─────────────────────────────────── */
function driveGet(path, token) {
  return new Promise((res, rej) => {
    const req = https.request({
      hostname: 'www.googleapis.com', path, method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    });
    req.on('error', rej);
    req.setTimeout(30000, () => { req.destroy(); rej(new Error('Timeout')); });
    req.end();
  });
}

/* ── Download de arquivo binário ────────────────────────── */
async function downloadFile(id, token) {
  return driveGet(`/drive/v3/files/${id}?alt=media`, token);
}

/* ── Lista arquivos de uma pasta ────────────────────────── */
async function listFolder(id, token) {
  const q  = encodeURIComponent(`'${id}' in parents and trashed=false`);
  const fl = encodeURIComponent('files(id,name)');
  const buf = await driveGet(`/drive/v3/files?q=${q}&fields=${fl}&pageSize=500`, token);
  return JSON.parse(buf.toString()).files || [];
}

/* ── Normaliza nome para chave do mapa ──────────────────── */
function normKey(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\.(jpg|jpeg|png|webp)$/i,'')
    .replace(/[^a-z0-9]/g,'_')
    .replace(/_+/g,'_')
    .replace(/^_|_$/g,'');
}

/* ── Parse xlsx em memória ──────────────────────────────── */
function parseXlsx(buf) {
  const XLSX = require('xlsx');
  const wb   = XLSX.read(buf, { type:'buffer' });

  const sheetName = wb.SheetNames.find(n => /somente/i.test(n))
    || wb.SheetNames.find(n => /vinho|espumante/i.test(n))
    || wb.SheetNames[0];

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header:1, defval:null });
  if (rows.length < 2) throw new Error('Planilha sem dados');

  // Cabeçalho
  let hIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => c !== null)) { hIdx = i; break; }
  }
  const headers = rows[hIdx].map(h => String(h||'').toLowerCase().trim());

  const COLS = {
    name:        ['produto','nome','name'],
    qty:         ['qtd atual','quantidade','qty','estoque'],
    cost:        ['preço','preco','custo médio','custo medio','price'],
    country:     ['país','pais','país de origem','pais de origem'],
    winery:      ['vinícola','vinicola','produtor','winery'],
    grapes:      ['uva / casta','uva/casta','uva','casta'],
    type:        ['tipo','type'],
    temperature: ['temperatura de serviço','temperatura de servico','temperatura'],
    tannins:     ['taninos'],
    pairing:     ['harmonização','harmonizacao','harmoniza'],
  };

  const map = {};
  for (const [field, aliases] of Object.entries(COLS)) {
    for (const [i, h] of headers.entries()) {
      if (aliases.some(a => h.includes(a))) { map[field] = i; break; }
    }
  }

  const get = (row, f, fb='') => {
    const i = map[f];
    if (i === undefined) return fb;
    const v = row[i];
    return (v !== null && v !== undefined) ? String(v).trim() : fb;
  };
  const parseNum = s => parseFloat(String(s).replace(/[^\d,]/g,'').replace(',','.')) || 0;

  function titleCase(str) {
    const up = str.replace(/[^A-Za-z]/g,'');
    if (up.length > 3 && up === up.toUpperCase())
      return str.toLowerCase().replace(/(^|[\s-])([a-záàãâéêíóôõúüçñ])/gi,(_,s,c)=>s+c.toUpperCase());
    return str;
  }

  const wines = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === null || c === '')) continue;

    const rawName = get(row,'name');
    if (!rawName) continue;

    const name = titleCase(rawName.replace(/\s*[-–]\s*\d+\s*(ml|l|lt)\s*$/i,'').trim());
    const type = get(row,'type');
    if (!type) continue;

    const hasQty = map['qty'] !== undefined;
    const qty    = parseNum(get(row,'qty','0'));
    if (hasQty && qty <= 0) continue;

    const costRaw = get(row,'cost');
    const costVal = parseNum(costRaw);
    if (costVal <= 0.01) continue;

    wines.push({
      id:           'r' + i,
      name,
      winery:       get(row,'winery'),
      producer:     get(row,'winery'),
      qty,
      cost_display: costRaw,
      cost_value:   costVal,
      country:      get(row,'country'),
      grapes:       get(row,'grapes'),
      type,
      temperature:  get(row,'temperature'),
      tannins:      get(row,'tannins'),
      pairing:      get(row,'pairing'),
      in_stock:     !hasQty || qty > 0,
    });
  }

  return {
    wines,
    meta: { sheetUsed: sheetName, count: wines.length, importedAt: new Date().toISOString() },
  };
}

/* ── Handler ────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS, body:'' };
  if (event.httpMethod !== 'GET')     return reply(405, { error:'Método não permitido' });

  const action = event.queryStringParameters?.action || 'catalog';

  try {
    const credsRaw = process.env.GOOGLE_CREDENTIALS;
    if (!credsRaw) return reply(503, { error:'GOOGLE_CREDENTIALS não configurada' });
    const creds = JSON.parse(credsRaw);
    const token = await getToken(creds);

    /* ── Catálogo ── */
    if (action === 'catalog') {
      const sheetId = process.env.GDRIVE_SHEET_ID;
      if (!sheetId) return reply(503, { error:'GDRIVE_SHEET_ID não configurada' });
      const buf    = await downloadFile(sheetId, token);
      const result = parseXlsx(buf);
      return reply(200, result);
    }

    /* ── Imagens: retorna mapa nome→URL ── */
    if (action === 'images') {
      const folderId = process.env.GDRIVE_IMAGES_ID;
      if (!folderId) return reply(503, { error:'GDRIVE_IMAGES_ID não configurada' });
      const files = await listFolder(folderId, token);
      const imageMap = {};
      for (const f of files) {
        // URL de visualização direta — funciona para arquivos compartilhados com a service account
        imageMap[normKey(f.name)] = `https://drive.google.com/uc?export=view&id=${f.id}`;
      }
      return reply(200, { images: imageMap, count: files.length });
    }

    return reply(400, { error:'action inválida. Use: catalog ou images' });

  } catch (err) {
    console.error('[gdrive]', err.message);
    return reply(500, { error: err.message });
  }
};

function reply(s, o) {
  return {
    statusCode: s,
    headers: { ...CORS, 'Content-Type':'application/json; charset=utf-8' },
    body: JSON.stringify(o),
  };
}
