'use strict';

/**
 * wines-db.js — Módulo central de banco de dados de vinhos
 * Empório Cosmopolita · Sommelier Digital
 *
 * Responsabilidades:
 *   - Receber upload de .xlsx via POST /api/wines-db
 *   - Parsear, validar e filtrar por estoque > 0
 *   - Persistir o catálogo em /tmp/wines-catalog.json (memória do processo Netlify)
 *   - Servir o catálogo via GET /api/wines-db
 *   - Detectar automaticamente colunas relevantes
 *   - Reportar erros com mensagens claras em pt-BR
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

/* ── CORS ───────────────────────────────────────────── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/* ── Caminho de persistência em /tmp ────────────────── */
const CATALOG_PATH = '/tmp/wines-catalog.json';

/* ══════════════════════════════════════════════════════
   MAPEAMENTO DE COLUNAS
   Detecta automaticamente os cabeçalhos do Excel e
   mapeia para os campos internos.
══════════════════════════════════════════════════════ */

/** Variantes aceitas para cada campo interno */
const COLUMN_ALIASES = {
  name:        ['produto', 'nome', 'name', 'item', 'descricao', 'description'],
  qty:         ['qtd atual', 'quantidade', 'qty', 'estoque', 'stock', 'qtd', 'saldo', 'disponivel'],
  cost:        ['custo medio', 'custo médio', 'preco', 'preço', 'price', 'valor', 'custo'],
  total_stock: ['total em estoque', 'total estoque', 'valor estoque', 'total stock'],
  country:     ['pais de origem', 'país de origem', 'pais', 'país', 'country', 'origem'],
  grapes:      ['uva / casta', 'uva/casta', 'uva', 'casta', 'grape', 'uvas', 'castas', 'varietal'],
  type:        ['tipo', 'type', 'categoria', 'category', 'estilo'],
  temperature: ['temperatura de servico', 'temperatura de serviço', 'temperatura', 'temp', 'service temp'],
  tannins:     ['taninos', 'tannins', 'taninhos'],
  pairing:     ['harmonizacao', 'harmonização', 'harmoniza', 'pairing', 'combinacoes', 'combinações'],
};

/**
 * Normaliza string para comparação:
 * remove acentos, lowercase, colapsa espaços
 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recebe array de cabeçalhos do Excel e devolve
 * um Map: campo_interno → índice_coluna
 */
function detectColumns(headers) {
  const map = {};
  const normHeaders = headers.map(h => norm(h));

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = normHeaders.indexOf(norm(alias));
      if (idx !== -1) { map[field] = idx; break; }
    }
  }
  return map;
}

/* ══════════════════════════════════════════════════════
   PARSER DE QUANTIDADE
   Lida com "9 un.", "-197 un.", "150 l", "1.253,50"
══════════════════════════════════════════════════════ */
function parseQty(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const s = String(raw)
    .replace(/[^\d\-.,]/g, '')   // mantém só dígitos, sinal, vírgula, ponto
    .replace(/\.(?=\d{3})/g, '') // remove ponto de milhar
    .replace(',', '.');
  if (!s || s === '-') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/* ══════════════════════════════════════════════════════
   PARSER DE PREÇO
   "R$ 249,00" → "R$ 249,00"  (mantém formato original)
   Extrai valor numérico quando necessário
══════════════════════════════════════════════════════ */
function parsePrice(raw) {
  if (!raw) return { display: '', value: 0 };
  const s = String(raw).trim();
  // Extrai número
  const m = s.match(/([\d.,]+)/);
  if (!m) return { display: s, value: 0 };
  const num = parseFloat(m[1].replace('.', '').replace(',', '.'));
  return { display: s, value: isNaN(num) ? 0 : num };
}

/* ══════════════════════════════════════════════════════
   CONVERSOR DE LINHA → OBJETO DE VINHO
══════════════════════════════════════════════════════ */
function rowToWine(row, colMap, rowIndex) {
  const get = (field, fallback = '') => {
    const idx = colMap[field];
    if (idx === undefined) return fallback;
    return row[idx] !== null && row[idx] !== undefined ? String(row[idx]).trim() : fallback;
  };

  const name = get('name');
  if (!name) return null;                          // linha vazia

  const qty      = parseQty(get('qty', '0'));
  const cost     = parsePrice(get('cost'));
  const type     = get('type');
  const country  = get('country');
  const grapes   = get('grapes');
  const temp     = get('temperature');
  const tannins  = get('tannins');
  const pairing  = get('pairing');

  // Extrai safra do nome (ex: "Alma Negra Tinto 2021 - 750ml")
  const vintageMatch = name.match(/\b(19|20)\d{2}\b/);
  const vintage = vintageMatch ? parseInt(vintageMatch[0]) : null;

  // Extrai volume do nome (ex: "- 750ml", "- 375ml")
  const volumeMatch = name.match(/[-–]\s*(\d+)\s*ml/i);
  const volume = volumeMatch ? `${volumeMatch[1]}ml` : '';

  // Nome limpo (sem "- 750ml" no final, sem safra no nome)
  const cleanName = name
    .replace(/\s*[-–]\s*\d+\s*ml\s*$/i, '')
    .trim();

  // Determina cor/categoria a partir do tipo
  const color = detectColor(type);

  return {
    id:          `row_${rowIndex}`,
    name:        cleanName,
    name_full:   name,
    vintage,
    volume,
    qty,
    cost_display: cost.display,
    cost_value:   cost.value,
    country,
    grapes,
    type,
    color,
    temperature:  temp,
    tannins,
    pairing,
    in_stock:     qty > 0,
  };
}

/** Mapeia tipo textual para categoria de cor */
function detectColor(type) {
  const t = norm(type);
  if (t.includes('espumante') || t.includes('champagne') || t.includes('prosecco') || t.includes('brut') || t.includes('frisante')) return 'Espumante';
  if (t.includes('rose') || t.includes('rosé')) return 'Rosé';
  if (t.includes('branco') || t.includes('white') || t.includes('verde')) return 'Branco';
  if (t.includes('tinto') || t.includes('red') || t.includes('red blend')) return 'Tinto';
  return 'Outro';
}

/* ══════════════════════════════════════════════════════
   PARSER XLSX
   Usa a lib xlsx (SheetJS) disponível no ambiente Node.
   Se não disponível, usa fallback via API externa.
══════════════════════════════════════════════════════ */
async function parseXlsx(base64Data) {
  // Tenta importar xlsx (SheetJS) — disponível como dep Netlify
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    throw new Error('Biblioteca xlsx não disponível no servidor. Instale: npm install xlsx');
  }

  const buffer = Buffer.from(base64Data, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const sheetNames = workbook.SheetNames;
  if (!sheetNames.length) throw new Error('Planilha vazia ou corrompida.');

  // Prefere aba com "vinho" ou "espumante" no nome; senão usa a primeira
  const preferredSheet = sheetNames.find(n =>
    /vinho|espumante|wine|estoque/i.test(n)
  ) || sheetNames[0];

  const ws      = workbook.Sheets[preferredSheet];
  const rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  if (rawData.length < 2) throw new Error('Planilha não contém dados suficientes.');

  // Detecta linha de cabeçalho (primeira linha não-vazia)
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, rawData.length); i++) {
    if (rawData[i].some(c => c !== null && c !== '')) { headerRowIdx = i; break; }
  }

  const headers = rawData[headerRowIdx].map(h => String(h || ''));
  const colMap  = detectColumns(headers);

  // Valida campo obrigatório: nome
  if (colMap.name === undefined) {
    throw new Error(
      `Coluna de produto não encontrada. Certifique-se de que a planilha tem uma coluna "Produto" ou "Nome".\n` +
      `Colunas encontradas: ${headers.filter(Boolean).join(', ')}`
    );
  }

  // Avisa se coluna de estoque não foi encontrada
  const hasQty = colMap.qty !== undefined;

  const wines    = [];
  const skipped  = [];
  const noStock  = [];

  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const row  = rawData[i];
    if (!row || row.every(c => c === null || c === '')) continue;

    const wine = rowToWine(row, colMap, i);
    if (!wine) continue;

    if (!wine.type) {
      // Produto sem tipo de vinho (cerveja, cachaça, acessório…)
      skipped.push(wine.name_full);
      continue;
    }

    if (!wine.in_stock) {
      noStock.push(wine.name_full);
      continue;
    }

    wines.push(wine);
  }

  return {
    wines,
    meta: {
      sheetUsed:       preferredSheet,
      allSheets:       sheetNames,
      totalRows:       rawData.length - headerRowIdx - 1,
      imported:        wines.length,
      skippedNoType:   skipped.length,
      skippedNoStock:  noStock.length,
      hasQtyColumn:    hasQty,
      columnsDetected: Object.keys(colMap),
      importedAt:      new Date().toISOString(),
    },
  };
}

/* ══════════════════════════════════════════════════════
   PERSISTÊNCIA EM /tmp
   Netlify Functions compartilham /tmp dentro do mesmo
   processo (warm invocation). Ao fazer cold start o
   arquivo é perdido — o cliente detecta isso e exibe
   botão de re-importação.
══════════════════════════════════════════════════════ */
function saveCatalog(catalog) {
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog), 'utf8');
}

function loadCatalog() {
  try {
    if (fs.existsSync(CATALOG_PATH)) {
      return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    }
  } catch { /* ignora erros de leitura */ }
  return null;
}

/* ══════════════════════════════════════════════════════
   HANDLER NETLIFY
══════════════════════════════════════════════════════ */
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

  /* ── GET: devolve catálogo atual ── */
  if (event.httpMethod === 'GET') {
    const catalog = loadCatalog();
    if (!catalog) {
      return reply(404, { error: 'Nenhum catálogo carregado. Importe um arquivo .xlsx primeiro.' });
    }
    return reply(200, catalog);
  }

  /* ── POST: recebe xlsx em base64, processa e salva ── */
  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return reply(400, { error: 'Payload JSON inválido.' });
    }

    const { file, filename } = payload;

    if (!file) {
      return reply(400, { error: 'Campo "file" (base64) obrigatório.' });
    }

    if (filename && !/\.(xlsx|xlsm|xls)$/i.test(filename)) {
      return reply(400, {
        error: `Formato inválido: "${filename}". Apenas arquivos .xlsx são aceitos.`,
      });
    }

    if (file.length > 10 * 1024 * 1024 * 1.34) { // ~10MB em base64
      return reply(400, { error: 'Arquivo muito grande. Limite: 10MB.' });
    }

    try {
      const result = await parseXlsx(file);

      if (result.wines.length === 0) {
        return reply(422, {
          error: 'Nenhum vinho com estoque disponível encontrado na planilha.',
          meta:  result.meta,
        });
      }

      saveCatalog(result);

      return reply(200, {
        success:  true,
        message:  `${result.wines.length} vinhos importados com sucesso.`,
        meta:     result.meta,
        wines:    result.wines,
      });

    } catch (err) {
      console.error('[wines-db] Erro ao processar xlsx:', err.message);
      return reply(422, {
        error: `Erro ao processar planilha: ${err.message}`,
      });
    }
  }

  return reply(405, { error: 'Método não permitido.' });
};

/* ─── helper ─────────────────────────────────────────── */
function reply(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}
