'use strict';

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';

/* ── Carrega catálogo do Blobs (fallback) ─────────────────── */
async function loadCatalogFromBlobs() {
  try {
    const { getStore } = require('@netlify/blobs');
    const store   = getStore({ name: 'emporio-catalog', consistency: 'strong' });
    const catalog = await store.get('wines-catalog', { type: 'json' });
    return catalog?.wines || [];
  } catch { return []; }
}

/* ── RAG ──────────────────────────────────────────────────── */
const STOP = new Set(['um','uma','de','da','do','para','com','que','em','no','na','os','as','me','quero','gostaria','preciso','indica','recomende','sugerir','qual','quais','tem','tenho','bom','boa','vinho','vinhos','por','entre','sobre','como','esse','essa','este','esta','ser','ter','mais','muito','bem','e','o','a']);

function tokenize(t) {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
}

const SYNS = {
  'aniversario':['espumante','brut'],'casamento':['espumante'],'presente':['reserva','elegante'],
  'brinde':['espumante'],'festa':['espumante'],'verao':['branco','rose'],
  'churrasco':['tinto','malbec','tannat','cabernet'],'peixe':['branco'],
  'frango':['branco','chardonnay'],'sushi':['branco','riesling'],
  'feijoada':['tinto'],'pizza':['tinto'],'risoto':['tinto'],'massa':['tinto'],
  'cordeiro':['tinto','tannat','malbec'],'malbec':['argentina'],
  'cabernet':['tinto'],'chardonnay':['branco'],'sauvignon':['branco'],
  'carmenere':['chile'],'tannat':['uruguai','brasil'],
  'italiano':['italia'],'frances':['franca'],'argentino':['argentina'],
  'portugues':['portugal'],'chileno':['chile'],'brasileiro':['brasil'],
};

function scoreWine(wt, qt) {
  let s = 0; const ws = new Set(wt);
  for (const q of qt) {
    if (ws.has(q)) { s += 3; continue; }
    for (const w of wt) { if (w.startsWith(q) || q.startsWith(w)) s += 1; }
    for (const syn of (SYNS[q] || [])) {
      if (ws.has(syn)) s += 2;
      else for (const w of wt) { if (w.includes(syn) || syn.includes(w)) s += 1; }
    }
  }
  return s;
}

function retrieve(wines, msg, max) {
  const qt     = tokenize(msg);
  const budget = (() => { const m = msg.match(/R\$\s*([\d.,]+)/i); return m ? parseFloat(m[1].replace(/\./g,'').replace(',','.')) : null; })();
  const idx    = wines.map(w => ({
    wine: w,
    tokens: tokenize([w.name, w.country, w.grapes, w.type, w.tannins, w.pairing, String(w.vintage||'')].filter(Boolean).join(' ')),
  }));
  let cands = budget ? idx.filter(x => x.wine.cost_value <= budget) : idx;
  if (!cands.length) cands = idx;
  const scored = cands.map(x => ({ wine: x.wine, s: scoreWine(x.tokens, qt) }))
    .filter(x => x.s > 0).sort((a,b) => b.s - a.s);
  if (!scored.length) {
    const bt = {};
    for (const w of wines) { if (!bt[w.color]) bt[w.color] = w; }
    return Object.values(bt).slice(0, max);
  }
  return scored.slice(0, max).map(x => x.wine);
}

function wineCtx(w) {
  // Custo médio exato — tenta cost_display, depois monta de cost_value
  let custo = 'consultar';
  if (w.cost_display && w.cost_display !== 'R$ 0,00' && w.cost_display !== '0') {
    custo = w.cost_display;
  } else if (w.cost_value && w.cost_value > 0) {
    custo = 'R$ ' + Number(w.cost_value).toFixed(2).replace('.', ',');
  }

  const winery = w.winery || w.producer || '';

  return [
    '• ' + w.name + (winery ? ' | Vinícola: ' + winery : ''),
    '  Tipo: ' + (w.type || '—') + ' | País: ' + (w.country || '—') + ' | Uva: ' + (w.grapes || '—'),
    '  Temperatura: ' + (w.temperature || '—'),
    '  CUSTO_MEDIO: ' + custo + '  ← copie este valor EXATO na linha 💵, sem alterar',
    '  Harmoniza: ' + (w.pairing || '—'),
  ].join('\n');
}

/* ── Handler ──────────────────────────────────────────────── */
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return reply(503, { error: 'Chave OPENROUTER_API_KEY não configurada.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { error: 'JSON inválido.' }); }

  const { system, messages, max_tokens } = payload;
  if (!Array.isArray(messages) || !messages.length)
    return reply(400, { error: 'Campo messages obrigatório.' });

  // 1. Usa vinhos enviados pelo frontend
  // 2. Fallback: tenta buscar do Netlify Blobs
  let wines = Array.isArray(payload.wines) && payload.wines.length
    ? payload.wines
    : await loadCatalogFromBlobs();

  const lastMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  let finalSystem = system || '';

  if (wines.length) {
    const rel      = retrieve(wines, lastMsg, 12);
    const allNames = wines.map(w => '• ' + w.name).join('\n');

    finalSystem +=
      '\n\n════════════════════════════════════════════════════\n' +
      'ACERVO DO EMPÓRIO COSMOPOLITA\n' +
      '════════════════════════════════════════════════════\n' +
      'REGRA ABSOLUTA: Recomende APENAS vinhos desta lista.\n' +
      'Jamais invente ou sugira rótulos fora do acervo.\n\n' +
      'TODOS OS RÓTULOS DISPONÍVEIS (' + wines.length + '):\n' +
      allNames +
      '\n\n────────────────────────────────────────────────────\n' +
      'DETALHES DOS MAIS RELEVANTES PARA ESTE PEDIDO:\n' +
      '────────────────────────────────────────────────────\n' +
      rel.map(wineCtx).join('\n\n') +
      '\n\n════════════════════════════════════════════════════\n' +
      'INSTRUÇÕES:\n' +
      '- Use o nome EXATO conforme a lista acima\n' +
      '- Exiba o CUSTO_MEDIO exato de cada vinho — nunca invente ou calcule preços\n' +
      '- Preencha TODOS os campos do formato\n' +
      '════════════════════════════════════════════════════';
  }

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: Number.isInteger(max_tokens) && max_tokens > 0 ? max_tokens : 1400,
    messages: [
      { role: 'system', content: finalSystem },
      ...messages.filter(m => m?.role && m?.content)
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    ],
  });

  try {
    const text = await callOpenRouter(apiKey, body);
    return reply(200, { reply: text });
  } catch (err) {
    console.error('[chat]', err.message);
    return reply(502, { error: err.message });
  }
};

function callOpenRouter(apiKey, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai',
      path:     '/api/v1/chat/completions',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  'Bearer ' + apiKey,
        'HTTP-Referer':   'https://sommelier-ec.netlify.app',
        'X-Title':        'Empório Cosmopolita Cosmos',
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) {
            const msg = typeof p.error === 'object' ? (p.error.message || JSON.stringify(p.error)) : String(p.error);
            return reject(new Error(msg));
          }
          const content = p.choices?.[0]?.message?.content?.trim() || '';
          if (!content) return reject(new Error('Resposta vazia do modelo.'));
          resolve(content);
        } catch (e) {
          reject(new Error('Resposta inválida: ' + e.message));
        }
      });
    });
    req.on('error', e => reject(new Error('Conexão: ' + e.message)));
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('Timeout.')); });
    req.write(body);
    req.end();
  });
}

function reply(s, o) {
  return {
    statusCode: s,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(o),
  };
}
