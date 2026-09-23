'use strict';
const https  = require('https');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function getToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(Buffer.from(JSON.stringify({ alg:'RS256', typ:'JWT' })));
  const pay = b64url(Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(hdr+'.'+pay).sign(creds.private_key));
  const jwt = hdr+'.'+pay+'.'+sig;
  return new Promise((res, rej) => {
    const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='+jwt;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
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
    req.write(body);
    req.end();
  });
}

function driveGet(path, token) {
  const GAPI = 'www.googleapis.com';
  return new Promise((res, rej) => {
    const req = https.request({
      hostname: GAPI,
      path: path,
      method: 'GET',
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

async function downloadFile(id, token) {
  try {
    const buf = await driveGet('/drive/v3/files/'+id+'?alt=media', token);
    if (buf[0] === 0x50 && buf[1] === 0x4B) return buf;
  } catch(e) {}
  return driveGet('/drive/v3/files/'+id+'/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet', token);
}

async function listFolder(id, token) {
  const q  = encodeURIComponent("'"+id+"' in parents and trashed=false");
  const fl = encodeURIComponent('files(id,name,thumbnailLink,mimeType)');
  const buf = await driveGet('/drive/v3/files?q='+q+'&fields='+fl+'&pageSize=500', token);
  return JSON.parse(buf.toString()).files || [];
}

function normKey(s) {
  // Remove extensão e converte para lowercase — preserva espaços e acentos para match exato
  return s.replace(/\.(jpg|jpeg|png|webp|gif)$/i, '').toLowerCase().trim();
}

function normHeader(s) {
  // Remove acentos, lowercase, colapsa espaços — usado para comparação EXATA
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseXlsx(buf) {
  const XLSX = require('xlsx');
  const wb   = XLSX.read(buf, { type:'buffer' });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header:1, defval:null });
  if (rows.length < 2) throw new Error('Planilha sem dados');

  let hIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => c !== null)) { hIdx = i; break; }
  }
  const headers = rows[hIdx].map(h => String(h||'').trim());

  const COLS = {
    id:          ['id'],
    name:        ['produto','nome','name'],
    qty:         ['qtd atual','quantidade','qty','estoque','qtd','saldo'],
    cost:        ['preco','custo medio','price'],
    country:     ['pais','pais de origem'],
    winery:      ['vinicola','produtor','winery'],
    grapes:      ['uva','casta','uva / casta','uva/casta'],
    type:        ['tipo','type'],
    temperature: ['temperatura de servico','temperatura'],
    tannins:     ['taninos'],
    pairing:     ['harmonizacao','harmoniza'],
  };

  // Correspondência EXATA (não por substring) para evitar colisões como
  // "estoque" batendo dentro de "disponível em estoque/loja? (s/n)"
  // em vez da coluna correta "qtd atual".
  const normHeaders = headers.map(h => normHeader(h));
  const map = {};
  for (const [field, aliases] of Object.entries(COLS)) {
    for (const alias of aliases) {
      const idx = normHeaders.indexOf(normHeader(alias));
      if (idx !== -1) { map[field] = idx; break; }
    }
  }

  const get = (row, f, fb) => {
    fb = fb === undefined ? '' : fb;
    const i = map[f];
    if (i === undefined) return fb;
    const v = row[i];
    return (v !== null && v !== undefined) ? String(v).trim() : fb;
  };

  const parseNum = s => parseFloat(String(s).replace(/[^\d,]/g,'').replace(',','.')) || 0;

  const wines = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === null || c === '')) continue;
    const rawName = get(row,'name');
    if (!rawName) continue;
    const name = rawName.replace(/\s*[-]\s*\d+\s*(ml|l)\s*$/i,'').trim();
    const hasQty = map['qty'] !== undefined;
    const qty    = parseNum(get(row,'qty','0'));
    const costRaw = get(row,'cost');
    const costVal = parseNum(costRaw);
    // Planilha já é pré-filtrada — não bloquear por qty ou preço
    const wineId = get(row,'id','');
    wines.push({
      id:           wineId ? String(parseInt(wineId)) : String(i),
      name:         name,
      winery:       get(row,'winery'),
      producer:     get(row,'winery'),
      qty:          qty,
      cost_display: costRaw,
      cost_value:   costVal,
      country:      get(row,'country'),
      grapes:       get(row,'grapes'),
      type:         get(row,'type'),
      temperature:  get(row,'temperature'),
      tannins:      get(row,'tannins'),
      pairing:      get(row,'pairing'),
      in_stock:     !hasQty || qty > 0,
    });
  }

  return {
    wines: wines,
    meta: { sheetUsed: sheetName, count: wines.length, headers: headers, importedAt: new Date().toISOString() },
  };
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
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS, body:'' };
  if (event.httpMethod !== 'GET') return reply(405, { error:'Metodo nao permitido' });

  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'catalog';

  try {
    const credsRaw = process.env.GOOGLE_CREDENTIALS;
    if (!credsRaw) return reply(503, { error:'GOOGLE_CREDENTIALS nao configurada' });
    const creds = JSON.parse(credsRaw);
    const token = await getToken(creds);

    if (action === 'catalog' || action === 'debug') {
      const sheetId = process.env.GDRIVE_SHEET_ID;
      if (!sheetId) return reply(503, { error:'GDRIVE_SHEET_ID nao configurada' });
      const buf = await downloadFile(sheetId, token);

      if (action === 'debug') {
        const XLSX = require('xlsx');
        const wb   = XLSX.read(buf, { type:'buffer' });
        const shName = wb.SheetNames.find(n => /somente/i.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[shName], { header:1, defval:null });
        const hIdx = rows.findIndex(r => r && r.some(c => /produto/i.test(String(c||''))));
        const headers = rows[hIdx] || [];
        const iNome  = headers.findIndex(h => /produto/i.test(String(h||'')));
        const iTipo  = headers.findIndex(h => /^tipo$/i.test(String(h||'').trim()));
        const iPreco = headers.findIndex(h => /pre/i.test(String(h||'')));
        const iQty   = headers.findIndex(h => /qtd/i.test(String(h||'')));
        // Busca espumantes
        const espRows = [];
        for (let i = hIdx+1; i < rows.length; i++) {
          const r = rows[i];
          if (!r) continue;
          const tipo = String(r[iTipo]||'').toLowerCase();
          const nome = String(r[iNome]||'').toLowerCase();
          if (tipo.includes('espumante')||tipo.includes('brut')||tipo.includes('prosecco')||nome.includes('espumante')||nome.includes('brut')) {
            espRows.push({ row: i, nome: r[iNome], tipo: r[iTipo], preco: r[iPreco], qty: r[iQty] });
            if (espRows.length >= 8) break;
          }
        }
        // Mostra linhas ao redor do "fim" dos vinhos atuais (linha 410-415)
        const sliceRows = rows.slice(408, 420).map((r,i) => ({idx: 408+i, cols: (r||[]).slice(0,6)}));
        return reply(200, {
          sheets:  wb.SheetNames,
          sheetUsed: shName,
          row0:    rows[0],
          row1:    rows[1],
          row2:    rows[2],
          total:   rows.length,
          hIdx:    hIdx,
          bufSize: buf.length,
          espumantes: espRows,
          rows408to420: sliceRows,
        });
      }

      const result = parseXlsx(buf);
      return reply(200, result);
    }

    if (action === 'images') {
      const folderId = process.env.GDRIVE_IMAGES_ID;
      if (!folderId) return reply(503, { error:'GDRIVE_IMAGES_ID nao configurada' });
      const files = await listFolder(folderId, token);
      const imageMap = {};
      for (const f of files) {
        // Chave = nome do arquivo sem extensão (ex: "1.png" → "1")
        const key = f.name.replace(/\.[^.]+$/, '').trim();
        imageMap[key] = '/api/gdrive?action=img&id=' + f.id;
      }
      return reply(200, { images: imageMap, count: files.length });
    }

    // Proxy de imagem — serve o arquivo do Drive autenticado
    if (action === 'img') {
      const fileId = event.queryStringParameters && event.queryStringParameters.id;
      if (!fileId) return reply(400, { error: 'id obrigatorio' });
      try {
        const buf = await driveGet('/drive/v3/files/'+fileId+'?alt=media', token);
        // Detecta formato pelo magic bytes do buffer
        let mime = 'image/jpeg';
        if (buf[0]===0x89 && buf[1]===0x50) mime = 'image/png';
        else if (buf[0]===0x52 && buf[1]===0x49 && buf[8]===0x57) mime = 'image/webp';
        else if (buf[0]===0x47 && buf[1]===0x49) mime = 'image/gif';
        return {
          statusCode: 200,
          headers: {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          },
          body: buf.toString('base64'),
          isBase64Encoded: true,
        };
      } catch(e) {
        return reply(404, { error: 'imagem nao encontrada' });
      }
    }

    if (action === 'ids') {
      const sheetId = process.env.GDRIVE_SHEET_ID;
      if (!sheetId) return reply(503, { error:'GDRIVE_SHEET_ID nao configurada' });
      const buf    = await downloadFile(sheetId, token);
      const result = parseXlsx(buf);
      // Gera CSV: id,nome,tipo,pais
      const lines  = ['id,nome,tipo,pais'];
      for (const w of result.wines) {
        const esc = s => '"' + String(s||'').replace(/"/g,'""') + '"';
        lines.push([w.id, esc(w.name), esc(w.type), esc(w.country)].join(','));
      }
      const csv = lines.join(String.fromCharCode(13,10));
      return {
        statusCode: 200,
        headers: {
          ...CORS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cosmos-ids.csv"',
        },
        body: csv,
      };
    }

    return reply(400, { error:'action invalida. Use: catalog, debug, images ou ids' });

  } catch (err) {
    console.error('[gdrive] ERRO:', err.message, err.stack);
    return reply(500, { error: err.message, stack: err.stack });
  }
};

function reply(s, o) {
  return {
    statusCode: s,
    headers: Object.assign({}, CORS, { 'Content-Type':'application/json; charset=utf-8' }),
    body: JSON.stringify(o),
  };
}