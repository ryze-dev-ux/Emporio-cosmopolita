'use strict';

/* ═══════════════════════════════════════════════════════════
   Empório Cosmopolita · Sommelier Digital · app.js
   Módulos: auth · authUI · winesDB · ui + código original
   ═══════════════════════════════════════════════════════════ */

const API_ENDPOINT  = '/api/chat';
const API_WINES_DB  = '/api/wines-db';
const API_GDRIVE    = '/api/gdrive';
const API_AUTH      = '/api/auth';
const HISTORY_TURNS = 12;

const state = { history: [], sessions: [], currentId: null, thinking: false };

const SYSTEM_PROMPT = `Você é o Cosmos, assistente de vinhos do Empório Cosmopolita, adega especializada em vinhos finos, espumantes e cervejas especiais.

Profissional experiente. Sem nome. Sem IA. Fale diretamente, com elegância. Sem saudações genéricas.

## REGRAS
- Recomende SEMPRE exatamente 3 rótulos — nem mais, nem menos.
- A 3ª opção DEVE ser explicitamente a de melhor custo-benefício do acervo.
- Use SOMENTE vinhos presentes no ACERVO fornecido abaixo. Jamais invente rótulos.
- Se nenhum vinho do acervo se encaixar, diga isso claramente e sugira o mais próximo disponível.
- Linguagem sensorial: frutas, especiarias, textura, corpo.
- Não repita rótulos já sugeridos na conversa.
- Se o pedido for ambíguo, pergunte antes de recomendar.

## FORMATO OBRIGATÓRIO para cada vinho — use exatamente estas linhas, nesta ordem:

**[Nome exato do vinho conforme o acervo]** — [Produtor]
🍇 Uva: [Uva(s) principal(is) — ex: Malbec, Cabernet Sauvignon]
🔴 Tipo: [Tinto Seco / Branco Seco / Espumante Brut / Rosé / etc]
🌡️ Temperatura: [ex: 16–18°C]
🍽️ Harmoniza: [prato 1, prato 2, prato 3 — seja específico e detalhado]
🌸 Aromas: [3 aromas principais detalhados — ex: frutas vermelhas maduras, especiarias, tabaco]
💰 Custo-benefício: [somente na 3ª opção — uma frase explicando por que é a melhor escolha de valor]
💵 Preço: [copie exatamente o CUSTO_MEDIO do acervo — não calcule, não invente]
✅ [motivo em 1 frase direta conectando o vinho ao pedido do cliente]

Finalize com uma linha começando com 💡 — dica de serviço ou curiosidade. Uma frase.`;

/* ═══════════════════════════════════════════════════════════
   MÓDULO auth
   ═══════════════════════════════════════════════════════════ */

/* ── Helper: parse JSON seguro ── */
async function _safeJson(res) {
  try {
    const text = await res.text();
    if (!text || !text.trim()) return {};
    return JSON.parse(text);
  } catch { return {}; }
}

const auth = (() => {
  const KEY   = 'ec_session';
  const ROLES = { ADMIN: 'admin', CLIENT: 'client' };
  let _s = null;

  function _load() {
    try {
      const r = sessionStorage.getItem(KEY);
      if (!r) return null;
      const s = JSON.parse(r);
      if (!s.token || Date.now() > s.expiresAt) { sessionStorage.removeItem(KEY); return null; }
      return s;
    } catch { return null; }
  }
  function _save(s) {
    try { s ? sessionStorage.setItem(KEY, JSON.stringify(s)) : sessionStorage.removeItem(KEY); } catch {}
  }

  async function login(username, password) {
    const res  = await fetch(API_AUTH, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'login', username:username.trim(), password }) });
    const data = await _safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Erro ao fazer login.');
    _s = { token:data.token, role:data.role, username:data.username, name:data.name, expiresAt:data.expiresAt };
    _save(_s);
    return _s;
  }

  async function logout() {
    const token = _s && _s.token;
    _s = null; _save(null);
    if (token) {
      try { await fetch(API_AUTH, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'logout', token }) }); } catch {}
    }
  }

  async function restoreSession() {
    const p = _load();
    if (!p) return false;
    try {
      const res  = await fetch(API_AUTH, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'verify', token:p.token }) });
      const data = await _safeJson(res);
      if (!res.ok || !data.valid) { _s = null; _save(null); return false; }
      _s = Object.assign({}, p, { role:data.role, name:data.name });
      _save(_s);
      return true;
    } catch { _s = p; return true; }
  }

  function authHeaders() {
    const t = _s && _s.token;
    return t ? { 'Content-Type':'application/json', 'Authorization':'Bearer '+t } : { 'Content-Type':'application/json' };
  }

  return {
    login, logout, restoreSession, authHeaders, ROLES,
    isLoggedIn:     () => !!(_s && _s.token),
    isAdmin:        () => !!(  _s && _s.role === ROLES.ADMIN),
    getDisplayName: () => (_s && (_s.name || _s.username)) || null,
    getRole:        () => (_s && _s.role) || null,
  };
})();

/* ═══════════════════════════════════════════════════════════
   MÓDULO authUI
   ═══════════════════════════════════════════════════════════ */
const authUI = (() => {

  function _styles() {
    if (document.getElementById('_auSt')) return;
    const s = document.createElement('style');
    s.id = '_auSt';
    s.textContent =
      '@keyframes auFI{from{opacity:0}to{opacity:1}}' +
      '@keyframes auSU{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}' +
      '@keyframes auSh{0%,100%{transform:none}25%,75%{transform:translateX(-5px)}50%{transform:translateX(5px)}}' +
      '@keyframes _sp{to{transform:rotate(360deg)}}' +
      '.au-shake{animation:auSh .4s ease!important}';
    document.head.appendChild(s);
  }

  function renderRailAuth() {
    _styles();
    const old = document.getElementById('_railAuth');
    if (old) old.remove();
    const footer = document.querySelector('.rail-footer');
    if (!footer) return;
    const wrap = document.createElement('div');
    wrap.id = '_railAuth';
    wrap.style.cssText = 'padding:10px 0 0;margin-top:4px;';

    if (auth.isLoggedIn()) {
      const name      = auth.getDisplayName();
      const isAdmin   = auth.isAdmin();
      const roleLabel = isAdmin ? 'Administrador' : 'Cliente';
      const roleColor = isAdmin ? 'var(--wine)' : 'var(--gold)';
      wrap.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line);">' +
          '<div style="width:28px;height:28px;border-radius:50%;background:var(--bg-2);border:1px solid var(--line-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;">👤</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:12px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(name) + '</div>' +
            '<div style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:' + roleColor + ';margin-top:1px;">' + roleLabel + '</div>' +
          '</div>' +
          '<button id="_logoutBtn" title="Sair" style="background:none;border:none;cursor:pointer;padding:4px 6px;color:var(--ink-3);border-radius:4px;transition:color .15s;flex-shrink:0;">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
          '</button>' +
        '</div>';
      wrap.querySelector('#_logoutBtn').addEventListener('click', async () => {
        await auth.logout(); onAuthChange();
      });
    } else {
      wrap.innerHTML =
        '<div style="padding-top:10px;border-top:1px solid var(--line);">' +
          '<button id="_loginLink" style="background:none;border:none;cursor:pointer;padding:0;font-family:var(--sans);font-size:11px;color:var(--ink-3);letter-spacing:.04em;display:flex;align-items:center;gap:5px;transition:color .15s;">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>' +
            'Área restrita' +
          '</button>' +
        '</div>';
      wrap.querySelector('#_loginLink').addEventListener('click', () => openLoginModal());
    }
    footer.parentNode.insertBefore(wrap, footer);
  }

  function onAuthChange() {
    renderRailAuth();
    const b = document.getElementById('_importBanner');
    if (b) b.style.display = auth.isAdmin() ? '' : 'none';
  }

  function openLoginModal(errMsg) {
    closeLoginModal(); _styles();
    const modal = document.createElement('div');
    modal.id = '_loginModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(26,20,16,.6);backdrop-filter:blur(4px);animation:auFI .18s ease;';
    const errBlock = errMsg
      ? '<div id="_lErr" style="display:block;padding:9px 14px;border-radius:8px;background:#fde8e8;border:1px solid #f5c6c6;color:#c0392b;font-size:12px;margin-bottom:14px;line-height:1.45;">' + esc(errMsg) + '</div>'
      : '<div id="_lErr" style="display:none;padding:9px 14px;border-radius:8px;background:#fde8e8;border:1px solid #f5c6c6;color:#c0392b;font-size:12px;margin-bottom:14px;line-height:1.45;"></div>';
    modal.innerHTML =
      '<div id="_loginBox" style="background:var(--paper);border-radius:var(--r);padding:32px 32px 28px;width:min(380px,92vw);box-shadow:0 24px 60px rgba(26,20,16,.28);animation:auSU .22s cubic-bezier(.2,.8,.2,1);border:1px solid var(--line);">' +
        '<div style="text-align:center;margin-bottom:24px;">' +
          '<img src="logo.png" alt="EC" style="width:52px;height:52px;border-radius:50%;object-fit:cover;margin:0 auto 12px;">' +
          '<h2 style="font-family:var(--serif);font-size:21px;font-weight:600;color:var(--ink);letter-spacing:-.01em;">Área Restrita</h2>' +
          '<p style="font-size:12px;color:var(--ink-3);margin-top:5px;">Empório Cosmopolita</p>' +
        '</div>' +
        errBlock +
        '<div style="display:flex;flex-direction:column;gap:12px;">' +
          '<div><label style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);display:block;margin-bottom:5px;">Usuário</label>' +
          '<input id="_lUser" type="text" autocomplete="username" placeholder="Digite seu usuário" style="width:100%;height:40px;padding:0 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);font-family:var(--sans);font-size:13.5px;color:var(--ink);background:var(--bg);outline:none;transition:border-color .18s;" onfocus="this.style.borderColor=\'var(--wine)\'" onblur="this.style.borderColor=\'var(--line-2)\'"></div>' +
          '<div><label style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);display:block;margin-bottom:5px;">Senha</label>' +
          '<input id="_lPass" type="password" autocomplete="current-password" placeholder="Digite sua senha" style="width:100%;height:40px;padding:0 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);font-family:var(--sans);font-size:13.5px;color:var(--ink);background:var(--bg);outline:none;transition:border-color .18s;" onfocus="this.style.borderColor=\'var(--wine)\'" onblur="this.style.borderColor=\'var(--line-2)\'"></div>' +
        '</div>' +
        '<button id="_lBtn" style="width:100%;height:42px;margin-top:18px;background:var(--wine);color:#fff;border:none;border-radius:var(--r-sm);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:background .17s;">' +
          '<span id="_lLabel">Entrar</span>' +
          '<span id="_lSpin" style="display:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:_sp .7s linear infinite;"></span>' +
        '</button>' +
        '<button id="_lClose" style="display:block;margin:14px auto 0;background:none;border:none;cursor:pointer;font-family:var(--sans);font-size:11px;color:var(--ink-3);">Fechar</button>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeLoginModal(); });
    modal.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') _doLogin(); }));
    modal.querySelector('#_lBtn').addEventListener('click', _doLogin);
    modal.querySelector('#_lClose').addEventListener('click', closeLoginModal);
    setTimeout(() => { const u = document.getElementById('_lUser'); if (u) u.focus(); }, 50);
  }

  async function _doLogin() {
    const uEl = document.getElementById('_lUser'), pEl = document.getElementById('_lPass');
    const bEl = document.getElementById('_lBtn'),  lEl = document.getElementById('_lLabel');
    const sEl = document.getElementById('_lSpin'), eEl = document.getElementById('_lErr');
    if (!uEl || !pEl) return;
    const username = uEl.value.trim(), password = pEl.value;
    if (!username || !password) { if (eEl) { eEl.textContent = 'Preencha usuário e senha.'; eEl.style.display = 'block'; } return; }
    if (bEl) { bEl.disabled = true; bEl.style.opacity = '.75'; }
    if (lEl) lEl.textContent = 'Entrando\u2026';
    if (sEl) sEl.style.display = 'inline-block';
    if (eEl) eEl.style.display = 'none';
    try {
      await auth.login(username, password);
      closeLoginModal();
      onAuthChange();
    } catch (err) {
      if (eEl) { eEl.textContent = err.message || 'Erro ao fazer login.'; eEl.style.display = 'block'; }
      const box = document.getElementById('_loginBox');
      if (box) { box.classList.add('au-shake'); setTimeout(() => box.classList.remove('au-shake'), 450); }
      if (pEl) { pEl.value = ''; pEl.focus(); }
      if (bEl) { bEl.disabled = false; bEl.style.opacity = '1'; }
      if (lEl) lEl.textContent = 'Entrar';
      if (sEl) sEl.style.display = 'none';
    }
  }

  function closeLoginModal() {
    const m = document.getElementById('_loginModal');
    if (!m) return;
    m.style.opacity = '0'; m.style.transition = 'opacity .15s';
    setTimeout(() => m.remove(), 160);
  }

  function requireAdmin(onSuccess) {
    if (auth.isAdmin()) return onSuccess();
    if (auth.isLoggedIn()) _showDenied();
    else openLoginModal();
  }

  function _showDenied() {
    _styles();
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(26,20,16,.5);backdrop-filter:blur(3px);animation:auFI .18s ease;';
    d.innerHTML = '<div style="background:var(--paper);border-radius:var(--r);padding:28px 32px;width:min(360px,90vw);text-align:center;box-shadow:0 20px 50px rgba(26,20,16,.25);border:1px solid var(--line);animation:auSU .2s cubic-bezier(.2,.8,.2,1);"><div style="font-size:36px;margin-bottom:12px;">🔒</div><h3 style="font-family:var(--serif);font-size:19px;font-weight:600;color:var(--ink);margin-bottom:8px;">Acesso negado</h3><p style="font-size:13px;color:var(--ink-3);line-height:1.55;margin-bottom:20px;">Esta funcionalidade requer perfil de administrador.</p><button style="padding:9px 22px;background:var(--wine);color:#fff;border:none;border-radius:var(--r-sm);font-family:var(--sans);font-size:13px;font-weight:500;cursor:pointer;">Fechar</button></div>';
    d.querySelector('button').addEventListener('click', () => d.remove());
    d.addEventListener('click', e => { if (e.target === d) d.remove(); });
    document.body.appendChild(d);
    setTimeout(() => { if (d.parentNode) d.remove(); }, 5000);
  }

  return { renderRailAuth, onAuthChange, openLoginModal, closeLoginModal, requireAdmin };
})();

window.authUI = authUI;

/* ═══════════════════════════════════════════════════════════
   MÓDULO winesDB
   ═══════════════════════════════════════════════════════════ */
const winesDB = (() => {
  let _catalog = null;

  /* ─── Detecção de colunas ─────────────────────────────── */
  const ALIASES = {
    name:        ['produto','nome','name','item'],
    qty:         ['qtd atual','quantidade','qty','estoque','stock','qtd','saldo'],
    cost:        ['custo medio','custo médio','preco','preço','price','custo'],
    country:     ['pais de origem','país de origem','pais','país','country'],
    grapes:      ['uva / casta','uva/casta','uva','casta','grape','uvas','varietal'],
    type:        ['tipo','type','categoria','estilo'],
    temperature: ['temperatura de servico','temperatura de serviço','temperatura','temp'],
    tannins:     ['taninos','tannins'],
    winery:      ['vinícola','vinicola','produtor','winery','producer'],
    pairing:     ['harmonizacao','harmonização','harmoniza','pairing'],
  };

  function _norm(s) {
    return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  }

  function _detectCols(headers) {
    const map = {}, normH = headers.map(h => _norm(h));
    for (const [field, aliases] of Object.entries(ALIASES)) {
      for (const a of aliases) {
        const idx = normH.indexOf(_norm(a));
        if (idx !== -1) { map[field] = idx; break; }
      }
    }
    return map;
  }

  function _parseQty(raw) {
    if (raw == null || raw === '') return 0;
    const s = String(raw).replace(/[^\d\-.,]/g,'').replace(/\.(?=\d{3})/g,'').replace(',','.');
    if (!s || s === '-') return 0;
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function _detectColor(type) {
    const t = _norm(type);
    if (/espumante|brut|prosecco|champagne|frisante/.test(t)) return 'Espumante';
    if (/ros[eé]/.test(t)) return 'Rosé';
    if (/branco|white|verde/.test(t)) return 'Branco';
    if (/tinto|red/.test(t)) return 'Tinto';
    return 'Outro';
  }

  // Stop words para extração de vinícola
  const _PROD_STOP = new Set([
    'tinto','branco','rose','rosé','seco','doce','suave','meio','demi','frisante',
    'reserva','gran','grande','especial','superior','premium','colheita','vintage',
    'doc','dop','igp','vdp','aoc','crianza','joven','roble','riserva','lote',
    'cabernet','sauvignon','merlot','malbec','syrah','shiraz','pinot','noir',
    'blanc','gris','grigio','chardonnay','riesling','gewurztraminer','viognier',
    'tempranillo','carmenere','carmenère','carménère','tannat','alvarinho',
    'bonarda','sangiovese','nebbiolo','primitivo','barbera','montepulciano',
    'blend','red','white','mix','cuvee','cuvée','varietal','classico','classic',
    'encruzado','regional','elegance','nuances','origins','origem','florao',
    'chaski','fausto','indra','periplo','felino','queulat','secreto',
    'ombú','ombu','garden','spritz','midnight','celebration',
    'alentejo','lisboa','alentejano','dao','dão','douro','rioja','bordeaux',
    'barossa','puglia','chianti','bardolino','toscana','prestige','cotês',
    'pequenas','partilhas','verde','vinho','espumante',
    'natural','organico','orgânico','biodinamico','biodynamic',
    'barbaresco','barolo','brunello','amarone','ripasso','valpolicella',
    'cotes','rhone','languedoc','muscadet','alsace','bourgogne','beaujolais'
  ]);

  function _extractProducer(rawName) {
    let name = rawName
      .replace(/\s*[-–]\s*\d+\s*(ml|l|lt)\s*$/i, '')
      .replace(/\b(19|20)\d{2}\b/g, '')
      .trim();
    name = name.replace(/^(Vinho|Espumante)\s+/i, '').trim();
    const words = name.split(/\s+/);
    const producer = [];
    for (let i = 0; i < words.length; i++) {
      const w  = words[i];
      const wl = w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      if (_PROD_STOP.has(wl)) break;
      const isConnector = /^(da|de|do|das|dos|del|di|des|com|e|y|&)$/i.test(w);
      producer.push(w);
      if (isConnector) continue;
      const nonConn = producer.filter(p => !/^(da|de|do|das|dos|del|di|des|com|e|y|&)$/i.test(p));
      if (nonConn.length >= 3) break;
    }
    return producer.join(' ').trim() || words[0] || rawName;
  }

  function _titleCase(str) {
    if (!str) return str;
    const upper = str.replace(/[^A-Za-z]/g, '');
    if (upper.length > 3 && upper === upper.toUpperCase()) {
      return str.toLowerCase().replace(/(^|[\s-])([a-záàãâéêíóôõúüçñ])/gi,
        (_, sep, c) => sep + c.toUpperCase());
    }
    return str;
  }

  function _rowToWine(row, map, idx) {
    const get = (f, fb) => {
      const i = map[f];
      if (i === undefined) return fb !== undefined ? fb : '';
      const v = row[i];
      return (v !== null && v !== undefined) ? String(v).trim() : (fb !== undefined ? fb : '');
    };

    const rawName = get('name');
    if (!rawName) return null;

    // Nome formatado — remove volume, corrige caixa alta
    const name = _titleCase(
      rawName.replace(/\s*[-–]\s*\d+\s*(ml|l|lt)\s*$/i, '').trim()
    );

    // Vinícola extraída do nome
    const producer = _extractProducer(rawName);

    // Quantidade
    const qty = _parseQty(get('qty', '0'));

    // Custo Médio — valor exato da planilha ex: "R$ 249,00"
    const costRaw = get('cost');
    const costNum = parseFloat(
      String(costRaw).replace(/[^\d,]/g, '').replace(',', '.') || '0'
    ) || 0;

    const type = get('type');

    return {
      id:           'r' + idx,
      name,
      producer,
      qty,
      cost_display: costRaw,
      cost_value:   costNum,
      country:      get('country'),
      grapes:       get('grapes'),
      type,
      color:        _detectColor(type),
      temperature:  get('temperature'),
      tannins:      get('tannins'),
      pairing:      get('pairing'),
      in_stock:     qty > 0,
    };
  }

  /* ─── Parse XLSX no browser via SheetJS ──────────────── */
  function _loadSheetJS() {
    return new Promise((resolve, reject) => {
      if (window.XLSX) { resolve(window.XLSX); return; }
      const s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload  = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error('Falha ao carregar SheetJS. Verifique sua conexão.'));
      document.head.appendChild(s);
    });
  }

  async function _parseXlsx(file) {
    const XLSX = await _loadSheetJS();

    const buf  = await file.arrayBuffer();
    const wb   = XLSX.read(buf, { type: 'array' });

    if (!wb.SheetNames.length) throw new Error('Planilha vazia ou corrompida.');

    // Prefere aba "Somente Vinhos e Espumantes" — já filtrada, sem acessórios
    const sheetName = wb.SheetNames.find(n => /somente/i.test(n))
      || wb.SheetNames.find(n => /vinho.*espumante|espumante.*vinho/i.test(n))
      || wb.SheetNames.find(n => /vinho|espumante/i.test(n))
      || wb.SheetNames[0];
    const ws        = wb.Sheets[sheetName];
    const rawData   = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    if (rawData.length < 2) throw new Error('Planilha sem dados suficientes.');

    let hIdx = 0;
    for (let i = 0; i < Math.min(5, rawData.length); i++) {
      if (rawData[i].some(c => c !== null && c !== '')) { hIdx = i; break; }
    }

    const headers = rawData[hIdx].map(h => String(h || ''));
    const map     = _detectCols(headers);

    if (map.name === undefined)
      throw new Error('Coluna "Produto" não encontrada. Colunas: ' + headers.filter(Boolean).join(', '));

    const wines = [], noStock = [], noType = [];
    for (let i = hIdx + 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.every(c => c === null || c === '')) continue;
      const wine = _rowToWine(row, map, i);
      if (!wine) continue;
      if (!wine.type) { noType.push(wine.name_full); continue; }
      if (!wine.in_stock) { noStock.push(wine.name_full); continue; }
      wines.push(wine);
    }

    return {
      wines,
      meta: {
        sheetUsed:      sheetName,
        allSheets:      wb.SheetNames,
        imported:       wines.length,
        skippedNoType:  noType.length,
        skippedNoStock: noStock.length,
        importedAt:     new Date().toISOString(),
      },
    };
  }

  /* ─── Validação ───────────────────────────────────────── */
  function validateFile(file) {
    if (!file) return 'Nenhum arquivo selecionado.';
    if (file.size > 10 * 1024 * 1024) return 'Arquivo muito grande (máx. 10MB).';
    if (!/\.(xlsx|xlsm|xls)$/i.test(file.name)) return 'Apenas arquivos .xlsx são aceitos.';
    return null;
  }

  /* ─── Importação: parse no browser + envia JSON ──────── */
  async function importFile(file) {
    if (!auth.isAdmin()) throw new Error('Permissão insuficiente. Faça login como administrador.');
    const err = validateFile(file);
    if (err) throw new Error(err);

    // 1. Parse do Excel no navegador (sem depender de pacote no servidor)
    const result = await _parseXlsx(file);

    if (result.wines.length === 0)
      throw new Error('Nenhum vinho com estoque disponível encontrado na planilha.');

    // 2. Envia o JSON processado para o servidor
    const payload = JSON.stringify(result);




    const res = await fetch(API_WINES_DB, {
      method:  'POST',
      headers: auth.authHeaders(),
      body:    payload,
    });

    const data = await _safeJson(res);

    if (res.status === 401 || res.status === 403) {
      await auth.logout(); authUI.onAuthChange();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    if (!res.ok) throw new Error(data.error || 'Erro HTTP ' + res.status);

    _catalog = { wines: data.wines, meta: data.meta };
    _persist();
    return data;
  }

  // Salva catálogo no localStorage para persistir entre sessões
  function _persist() {
    try {
      if (_catalog) localStorage.setItem('ec_catalog', JSON.stringify(_catalog));
    } catch {}
  }
  function _loadLocal() {
    try {
      const raw = localStorage.getItem('ec_catalog');
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (d.wines && d.wines.length) { _catalog = d; return true; }
    } catch {}
    return false;
  }

  async function fetchCatalog() {
    // 1. Google Drive (fonte primária)
    try {
      const res = await fetch(API_GDRIVE + '?action=catalog');
      if (res.ok) {
        const d = await res.json();
        if (d.wines && d.wines.length) {
          _catalog = { wines: d.wines, meta: d.meta };
          _persist();
          return true;
        }
      }
    } catch (e) { console.warn('[catalog] Drive:', e.message); }

    // 2. Fallback: servidor (Blobs)
    try {
      const res = await fetch(API_WINES_DB);
      if (res.ok) {
        const d = await res.json();
        if (d.wines && d.wines.length) {
          _catalog = { wines: d.wines, meta: d.meta };
          _persist();
          return true;
        }
      }
    } catch {}

    // 3. Fallback: localStorage
    return _loadLocal();
  }

  async function fetchImageMap() {
    try {
      const res = await fetch(API_GDRIVE + '?action=images');
      if (res.ok) {
        const d = await res.json();
        return d.images || {};
      }
    } catch {}
    return {};
  }

  return {
    importFile, fetchCatalog, validateFile,
    getCatalog: () => _catalog,
    getCount:   () => (_catalog && _catalog.wines && _catalog.wines.length) || 0,
    getMeta:    () => (_catalog && _catalog.meta) || null,
  };
})();


/* ═══════════════════════════════════════════════════════════
   MÓDULO ui — banner + modal de importação Excel
   ═══════════════════════════════════════════════════════════ */
const ui = (() => {
  let _file = null;

  function _anims() {
    if (document.getElementById('_ecSt')) return;
    const s = document.createElement('style');
    s.id = '_ecSt';
    s.textContent =
      '@keyframes ecFI{from{opacity:0}to{opacity:1}}' +
      '@keyframes ecSU{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}' +
      '@keyframes _sp{to{transform:rotate(360deg)}}' +
      '.ec-dov{border-color:var(--wine)!important;background:rgba(139,0,0,.04)!important;}';
    document.head.appendChild(s);
  }

  function injectImportBanner() {
    if (document.getElementById('_importBanner')) return;
    const footer = document.querySelector('.rail-footer');
    if (!footer) return;
    _anims();
    const wrap = document.createElement('div');
    wrap.id = '_importBanner';
    wrap.style.cssText = 'padding:12px 0 14px;border-top:1px solid var(--line);margin-bottom:14px;' +
      (auth.isAdmin() ? '' : 'display:none;');
    wrap.innerHTML =
      '<p style="font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px;">Banco de Dados</p>' +
      '<div id="_dbBadge" style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-3);margin-bottom:10px;font-style:italic;line-height:1.4;">' +
        '<span id="_dbDot" style="width:7px;height:7px;border-radius:50%;background:#cfc0a5;flex-shrink:0;"></span>' +
        '<span id="_dbTxt">Nenhum catálogo carregado</span>' +
      '</div>' +
      '<button id="_importBtn" style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:8px 14px;background:var(--paper);color:var(--ink-2);border:1px solid var(--line-2);border-radius:var(--r-sm);font-family:var(--sans);font-size:12px;font-weight:500;cursor:pointer;transition:background .18s,border-color .18s;">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
        '<span id="_importLbl">Importar Banco de Dados</span>' +
      '</button>' +
      '<input type="file" id="_xlsxInput" accept=".xlsx,.xlsm,.xls" style="display:none">';
    footer.parentNode.insertBefore(wrap, footer);
    wrap.querySelector('#_importBtn').addEventListener('click', () => authUI.requireAdmin(() => openModal()));
    wrap.querySelector('#_xlsxInput').addEventListener('change', e => onFileChange(e.target.files[0]));
  }

  function openModal() {
    closeModal(); _anims();
    const m = document.createElement('div');
    m.id = '_importModal';
    m.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(26,20,16,.55);backdrop-filter:blur(3px);animation:ecFI .18s ease;';
    m.innerHTML =
      '<div style="background:var(--paper);border-radius:var(--r);padding:28px 32px;width:min(480px,92vw);box-shadow:0 24px 60px rgba(26,20,16,.25);animation:ecSU .22s cubic-bezier(.2,.8,.2,1);border:1px solid var(--line);">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;">' +
          '<div><h2 style="font-family:var(--serif);font-size:20px;font-weight:600;color:var(--ink);letter-spacing:-.01em;">Importar Banco de Dados</h2>' +
          '<p style="font-size:12px;color:var(--ink-3);margin-top:4px;">Selecione um arquivo <strong>.xlsx</strong> com o estoque de vinhos</p></div>' +
          '<button id="_mClose" style="background:none;border:none;cursor:pointer;padding:4px;color:var(--ink-3);font-size:18px;line-height:1;">&#x2715;</button>' +
        '</div>' +
        '<div id="_drop" style="border:2px dashed var(--line-2);border-radius:var(--r);padding:28px 20px;text-align:center;cursor:pointer;background:var(--bg);transition:all .2s;margin-bottom:14px;" ondragover="event.preventDefault();this.classList.add(\'ec-dov\')" ondragleave="this.classList.remove(\'ec-dov\')" ondrop="event.preventDefault();this.classList.remove(\'ec-dov\');ui.onFileChange(event.dataTransfer.files[0])">' +
          '<div style="font-size:32px;margin-bottom:10px;opacity:.5;">📊</div>' +
          '<p style="font-size:13px;color:var(--ink-2);line-height:1.5;"><strong style="color:var(--wine);">Clique para selecionar</strong><br>ou arraste o arquivo aqui</p>' +
          '<p style="font-size:11px;color:var(--ink-3);margin-top:6px;">Formato: .xlsx · Máx. 10 MB</p>' +
        '</div>' +
        '<div id="_fInfo" style="display:none;padding:10px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--line);margin-bottom:12px;font-size:12.5px;color:var(--ink-2);align-items:center;gap:10px;">' +
          '<span style="font-size:16px;flex-shrink:0;">📄</span>' +
          '<div style="flex:1;min-width:0;"><div id="_fName" style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>' +
          '<div id="_fSize" style="font-size:11px;color:var(--ink-3);margin-top:1px;"></div></div>' +
          '<button id="_fClear" style="background:none;border:none;cursor:pointer;color:var(--ink-3);font-size:14px;padding:2px 6px;flex-shrink:0;">&#x2715;</button>' +
        '</div>' +
        '<div id="_fb" style="display:none;padding:10px 14px;border-radius:8px;font-size:12.5px;margin-bottom:12px;line-height:1.5;"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button id="_mCancel" style="padding:9px 18px;border-radius:8px;border:1px solid var(--line);background:var(--paper);color:var(--ink-2);font-family:var(--sans);font-size:13px;font-weight:500;cursor:pointer;">Cancelar</button>' +
          '<button id="_mOk" style="padding:9px 20px;border-radius:8px;border:none;background:var(--wine);color:#fff;font-family:var(--sans);font-size:13px;font-weight:500;cursor:pointer;opacity:.4;pointer-events:none;display:flex;align-items:center;gap:7px;">' +
            '<span id="_mOkLbl">Importar</span>' +
            '<span id="_mSpin" style="display:none;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:_sp .7s linear infinite;"></span>' +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) closeModal(); });
    m.querySelector('#_mClose').addEventListener('click', closeModal);
    m.querySelector('#_mCancel').addEventListener('click', closeModal);
    m.querySelector('#_drop').addEventListener('click', () => document.getElementById('_xlsxInput').click());
    m.querySelector('#_fClear').addEventListener('click', clearFile);
    m.querySelector('#_mOk').addEventListener('click', confirm);
  }

  function onFileChange(file) {
    if (!file) return;
    const err = winesDB.validateFile(file);
    if (err) { _fb(err, 'error'); return; }
    _file = file;
    const info = document.getElementById('_fInfo');
    if (info) { info.style.display = 'flex'; document.getElementById('_fName').textContent = file.name; document.getElementById('_fSize').textContent = _fmt(file.size); }
    const btn = document.getElementById('_mOk');
    if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; }
    const f = document.getElementById('_fb'); if (f) f.style.display = 'none';
  }

  function clearFile() {
    _file = null;
    const info = document.getElementById('_fInfo'); if (info) info.style.display = 'none';
    const btn  = document.getElementById('_mOk');   if (btn)  { btn.style.opacity = '.4'; btn.style.pointerEvents = 'none'; }
    const inp  = document.getElementById('_xlsxInput'); if (inp) inp.value = '';
    const f = document.getElementById('_fb'); if (f) f.style.display = 'none';
  }

  async function confirm() {
    if (!_file) return;
    if (!auth.isAdmin()) { closeModal(); authUI.openLoginModal('Sessão expirada. Faça login novamente.'); return; }
    const btn = document.getElementById('_mOk'), lbl = document.getElementById('_mOkLbl'), spn = document.getElementById('_mSpin');
    if (btn) { btn.style.opacity = '.7'; btn.style.pointerEvents = 'none'; }
    if (lbl) lbl.textContent = 'Importando…';
    if (spn) spn.style.display = 'inline-block';
    try {
      const result = await winesDB.importFile(_file);
      const mm = result.meta;
      _fb('<strong>' + mm.imported + ' vinhos importados</strong> com estoque. Aba: <em>' + mm.sheetUsed + '</em> · ' + mm.skippedNoStock + ' sem estoque · ' + mm.skippedNoType + ' sem tipo.', 'ok');
      updateBadge();
      setTimeout(() => { closeModal(); _notice(mm.imported); }, 2400);
    } catch (e) {
      _fb(e.message, 'error');
      if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; }
      if (lbl) lbl.textContent = 'Tentar novamente';
      if (spn) spn.style.display = 'none';
      if (/sess|login|expirou|permiss/i.test(e.message))
        setTimeout(() => { closeModal(); authUI.openLoginModal(e.message); }, 1500);
    }
  }

  function closeModal() {
    const m = document.getElementById('_importModal');
    if (m) { m.style.opacity = '0'; m.style.transition = 'opacity .15s'; setTimeout(() => m.remove(), 150); }
    _file = null;
  }

  function _fb(msg, type) {
    const el = document.getElementById('_fb'); if (!el) return;
    const C = { ok:['#d8f3dc','#a8d5b5','#2d6a4f'], error:['#fde8e8','#f5c6c6','#c0392b'] };
    const c = C[type] || C.error;
    el.style.cssText = 'display:block;padding:10px 14px;border-radius:8px;font-size:12.5px;margin-bottom:12px;line-height:1.5;background:' + c[0] + ';border:1px solid ' + c[1] + ';color:' + c[2] + ';';
    el.innerHTML = msg;
  }

  function updateBadge() {
    const dot = document.getElementById('_dbDot'), txt = document.getElementById('_dbTxt'), lbl = document.getElementById('_importLbl');
    if (!dot || !txt) return;
    const n = winesDB.getCount(), meta = winesDB.getMeta();
    if (n > 0) {
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#3a8c5a;box-shadow:0 0 0 3px rgba(58,140,90,.15);flex-shrink:0;';
      txt.style.fontStyle = 'normal';
      txt.innerHTML = '<strong style="color:var(--ink)">' + n + ' rótulos</strong><br><span style="font-size:11px">' + ((meta && meta.sheetUsed) || 'Excel') + ((meta && meta.importedAt) ? ' · ' + new Date(meta.importedAt).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'}) : '') + '</span>';
      if (lbl) lbl.textContent = 'Atualizar catálogo';
    } else {
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#cfc0a5;flex-shrink:0;';
      txt.style.fontStyle = 'italic'; txt.innerHTML = 'Nenhum catálogo carregado';
      if (lbl) lbl.textContent = 'Importar Banco de Dados';
    }
  }

  function _notice(count) {
    const thread = document.getElementById('thread'); if (!thread) return;
    const old = document.getElementById('_ecNotice'); if (old) old.remove();
    const el = document.createElement('div'); el.id = '_ecNotice';
    el.style.cssText = 'max-width:680px;margin:0 auto 18px;padding:12px 16px;border-radius:10px;background:#f5edd9;border:1px solid #e8d9b5;border-left:3px solid var(--gold);font-size:13px;color:var(--ink-2);display:flex;align-items:center;gap:10px;animation:ecSU .3s cubic-bezier(.2,.8,.2,1);';
    el.innerHTML = '<span style="font-size:18px;flex-shrink:0;">📚</span><div><strong style="color:var(--ink);">Catálogo atualizado</strong> — ' + count + ' vinhos carregados. O Cosmos recomenda exclusivamente do nosso estoque.</div><button id="_nClose" style="background:none;border:none;cursor:pointer;color:var(--ink-3);font-size:14px;padding:2px 6px;border-radius:4px;margin-left:auto;flex-shrink:0;">✕</button>';
    el.querySelector('#_nClose').addEventListener('click', () => el.remove());
    thread.appendChild(el); thread.scrollTop = thread.scrollHeight;
    setTimeout(() => { if (el.parentNode) el.remove(); }, 8000);
  }

  function _fmt(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : (b/1048576).toFixed(1) + ' MB'; }

  return { injectImportBanner, openModal, closeModal, onFileChange, clearFile, confirm, updateBadge };
})();

window.ui = ui;

/* ═══════════════════════════════════════════════════════════
   INICIALIZAÇÃO
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  startNewSession({ silent: true });
  document.getElementById('msgInput').focus();
  await auth.restoreSession();
  authUI.renderRailAuth();
  ui.injectImportBanner();
  const loaded = await winesDB.fetchCatalog();
  if (loaded) ui.updateBadge();
});

/* ═══════════════════════════════════════════════════════════
   CÓDIGO ORIGINAL — PRESERVADO
   ═══════════════════════════════════════════════════════════ */

/* ── Toggle da barra lateral ─────────────────────────────── */
function toggleRail() {
  const shell     = document.getElementById('shell');
  const icon      = document.getElementById('railToggleIcon');
  const collapsed = shell.classList.toggle('rail-collapsed');

  if (collapsed) {
    icon.innerHTML = '<polyline points="13 17 18 12 13 7"/><line x1="6" y1="12" x2="18" y2="12"/>';
    document.getElementById('railToggle').title = 'Expandir menu';
  } else {
    icon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>';
    document.getElementById('railToggle').title = 'Recolher menu';
  }
}

function startNewSession({ silent = false } = {}) {
  const id = Date.now();
  state.currentId = id;
  state.history = [];
  state.sessions.push({ id, title: 'Nova conversa', messages: state.history });
  renderOpener();
  renderThreadList();
  if (!silent) document.getElementById('msgInput').focus();
}

function newChat() { startNewSession(); }

function loadSession(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  state.currentId = id;
  state.history = s.messages;
  const thread = document.getElementById('thread');
  thread.innerHTML = '';
  if (!state.history.length) renderOpener();
  else { state.history.forEach(m => appendMessage(m.role, m.content, { instant: true })); thread.scrollTop = thread.scrollHeight; }
  renderThreadList();
}

function renderThreadList() {
  const el = document.getElementById('threadList');
  el.innerHTML = '';
  if (!state.sessions.length) { el.innerHTML = '<p class="thread-empty">Nenhuma conversa ainda.</p>'; return; }
  [...state.sessions].reverse().forEach(s => {
    const d = document.createElement('div');
    d.className = 'thread-item' + (s.id === state.currentId ? ' active' : '');
    d.textContent = s.title;
    d.onclick = () => loadSession(s.id);
    el.appendChild(d);
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: searchWizard — Pesquisa guiada de vinhos por filtros (v2)
   ═══════════════════════════════════════════════════════════════════════ */

const searchWizard = (() => {

  /* ── Etapas ────────────────────────────────────────────────────────── */
  const STEPS = [
    {
      key: 'price', label: 'Faixa de Preço', icon: '💰',
      options: [
        { label: 'Até R$ 80',        min: 0,   max: 80        },
        { label: 'R$ 80 a R$ 130',   min: 80,  max: 130       },
        { label: 'R$ 130 a R$ 200',  min: 130, max: 200       },
        { label: 'R$ 200 a R$ 250',  min: 200, max: 250       },
        { label: 'R$ 250 a R$ 300',  min: 250, max: 300       },
        { label: 'Acima de R$ 300',  min: 300, max: Infinity  },
      ],
    },
    {
      key: 'tipo', label: 'Tipo de Vinho', icon: '🍷',
      options: [
        { label: 'Vinho Tinto'  },
        { label: 'Vinho Branco' },
        { label: 'Espumante'    },
      ],
    },
    {
      key: 'estilo', label: 'Estilo', icon: '✨',
      options: [
        { label: 'Suave'    },
        { label: 'Meio Seco'},
        { label: 'Seco'     },
      ],
    },
    {
      key: 'uva', label: 'Tipo de Uva', icon: '🍇',
      options: [
        { label: 'Blend de Uvas'      },
        { label: 'Cabernet Sauvignon' },
        { label: 'Malbec'             },
        { label: 'Carmenere'          },
        { label: 'Merlot'             },
        { label: 'Shiraz / Syrah'     },
        { label: 'Tannat'             },
        { label: 'Viognier'           },
        { label: 'Sangiovese'         },
        { label: 'Sauvignon Blanc'    },
        { label: 'Gewürztraminer'     },
        { label: 'Chardonnay'         },
        { label: 'Savagnin Blanc'     },
        { label: 'Cabernet Franc'     },
        { label: 'Petit Verdot'       },
        { label: 'Pinotage'           },
        { label: 'Pinot Noir'         },
        { label: 'Pinot Grigio'       },
      ],
    },
    {
      key: 'pais', label: 'País de Origem', icon: '🌍',
      options: [
        { label: 'Sem preferência', any: true },
        { label: 'Argentina',    flag: 'ar' },
        { label: 'Chile',        flag: 'cl' },
        { label: 'Brasil',       flag: 'br' },
        { label: 'França',       flag: 'fr' },
        { label: 'Itália',       flag: 'it' },
        { label: 'Portugal',     flag: 'pt' },
        { label: 'Espanha',      flag: 'es' },
        { label: 'Uruguai',      flag: 'uy' },
        { label: 'África do Sul',flag: 'za' },
        { label: 'Austrália',    flag: 'au' },
        { label: 'Estados Unidos',flag:'us' },
      ],
    },
    {
      key: 'harmonizacao', label: 'Harmonização', icon: '🍽️',
      options: [
        { label: 'Carnes Vermelhas'      },
        { label: 'Carnes Brancas'        },
        { label: 'Massas e Risotos'      },
        { label: 'Queijos e Frios'       },
        { label: 'Peixes e Frutos do Mar'},
        { label: 'Sem preferência', any: true },
      ],
    },
  ];

  /* ── Estado ────────────────────────────────────────────────────────── */
  let st = { step: 0, answers: {} };

  /* ── Utilitários ───────────────────────────────────────────────────── */
  function norm(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function fmtPrice(w) {
    const num = w.cost_value || 0;
    if (num > 0) return 'R$ ' + num.toFixed(2).replace('.', ',');
    return '—';
  }

  function flagImg(cc, label) {
    if (!cc) return '';
    return `<img src="https://flagcdn.com/16x12/${cc}.png" width="16" height="12" alt="${label}" class="wc-flag">`;
  }

  const COUNTRY_CC = {
    'argentina':'ar','chile':'cl','brasil':'br','franca':'fr',
    'italia':'it','portugal':'pt','espanha':'es','uruguai':'uy',
    'africa do sul':'za','australia':'au','estados unidos':'us',
  };

  /* ── Filtros ───────────────────────────────────────────────────────── */
  function applyFilters(wines, ans, relaxed) {
    return wines.filter(w => {
      // Preço
      const pr = ans.price;
      if (pr) {
        const cv = w.cost_value || 0;
        if (cv < pr.min || cv > pr.max) return false;
      }
      // Tipo — mapeia "Vinho Tinto" → "tinto", "Vinho Branco" → "branco", "Espumante" → "espumante"
      if (ans.tipo && w.type) {
        const wt  = norm(w.type);
        const map = { 'vinho tinto': 'tinto', 'vinho branco': 'branco', 'espumante': 'espumante' };
        const keyword = map[norm(ans.tipo)] || norm(ans.tipo).replace('vinho ', '');
        if (!wt.startsWith(keyword) && !wt.includes(keyword)) return false;
      }
      // Estilo — "Seco", "Suave", "Meio Seco" — busca no campo type
      if (ans.estilo && w.type) {
        const wt = norm(w.type);
        const es = norm(ans.estilo);
        if (!wt.includes(es)) return false;
      }
      // Uva — só filtra se o vinho tem o campo preenchido
      if (ans.uva && norm(ans.uva) !== 'blend de uvas' && w.grapes) {
        const wg = norm(w.grapes);
        const terms = norm(ans.uva).replace('shiraz  syrah','syrah shiraz').split(' ').filter(t => t.length > 2);
        if (!terms.some(t => wg.includes(t))) return false;
      }
      // País (ignorado se relaxado)
      if (!relaxed && ans.pais && !STEPS[4].options.find(o => o.label === ans.pais)?.any) {
        if (norm(w.country || '') !== norm(ans.pais)) return false;
      }
      // Harmonização — só filtra se o vinho tem pairing preenchido
      if (!relaxed && ans.harmonizacao && !STEPS[5].options.find(o => o.label === ans.harmonizacao)?.any && w.pairing) {
        const wp = norm(w.pairing);
        const hterms = norm(ans.harmonizacao).split(' e ').flatMap(t => t.split(' ')).filter(t => t.length > 3);
        if (!hterms.some(t => wp.includes(t))) return false;
      }
      return true;
    });
  }

  /* ── Card de resultado ─────────────────────────────────────────────── */
  function renderCard(w) {
    let imgUrl = null;
    try { imgUrl = wineImageUrl(w.name); } catch {}

    const imgHtml = imgUrl
      ? `<img src="${imgUrl}" alt="${esc(w.name)}" class="wc-bottle-img" loading="lazy" onerror="this.style.display='none'">`
      : '';

    const cc       = COUNTRY_CC[norm(w.country || '')];
    const flagHtml = cc ? `<img src="https://flagcdn.com/16x12/${cc}.png" width="16" height="12" alt="${esc(w.country)}" class="wc-flag">` : '';
    const preco    = fmtPrice(w);

    const infoLines = [
      w.type    ? `<div class="wc-line"><span class="wc-line-icon">🍷</span><span class="wc-line-label">Tipo</span><span class="wc-line-val">${esc(w.type)}</span></div>` : '',
      w.grapes  ? `<div class="wc-line"><span class="wc-line-icon">🍇</span><span class="wc-line-label">Uva</span><span class="wc-line-val">${esc(w.grapes)}</span></div>` : '',
      w.temperature ? `<div class="wc-line"><span class="wc-line-icon">🌡️</span><span class="wc-line-label">Temperatura</span><span class="wc-line-val">${esc(w.temperature)}</span></div>` : '',
      w.pairing ? `<div class="wc-line"><span class="wc-line-icon">🍽️</span><span class="wc-line-label">Harmoniza</span><span class="wc-line-val">${esc(w.pairing)}</span></div>` : '',
    ].filter(Boolean).join('');

    return `
      <div class="wine-card">
        <div class="wc-header">
          ${imgHtml}
          <div class="wc-header-info">
            <div class="wc-name">${esc(w.name)}</div>
            ${w.winery || w.producer ? `<div class="wc-maker">${esc(w.winery || w.producer)}</div>` : ''}
            ${w.country ? `<div class="wc-country">${flagHtml}<span>${esc(w.country)}</span></div>` : ''}
          </div>
        </div>
        ${infoLines ? `<div class="wc-lines">${infoLines}</div>` : ''}
        <div class="wc-footer">
          <div class="wc-price-tag wc-line-val">${preco}</div>
        </div>
      </div>`;
  }

  /* ── Resumo de filtros ─────────────────────────────────────────────── */
  function renderSummary() {
    const tags = [];
    if (st.answers.price)        tags.push(st.answers.price.label);
    if (st.answers.tipo)         tags.push(st.answers.tipo);
    if (st.answers.estilo)       tags.push(st.answers.estilo);
    if (st.answers.uva)          tags.push(st.answers.uva);
    if (st.answers.pais && !STEPS[4].options.find(o => o.label === st.answers.pais)?.any)
      tags.push(st.answers.pais);
    if (st.answers.harmonizacao && !STEPS[5].options.find(o => o.label === st.answers.harmonizacao)?.any)
      tags.push(st.answers.harmonizacao);
    if (!tags.length) return '';
    return `<div class="sw-summary">${tags.map(t => `<span class="sw-tag">${esc(t)}</span>`).join('')}</div>`;
  }

  /* ── Ordenação ─────────────────────────────────────────────────────── */
  function sortWines(wines, order) {
    const sorted = [...wines];
    if (order === 'cb')   return sorted.sort((a, b) => (a.cost_value || 0) - (b.cost_value || 0));
    if (order === 'med')  return sorted.sort((a, b) => (a.cost_value || 0) - (b.cost_value || 0));
    if (order === 'caro') return sorted.sort((a, b) => (b.cost_value || 0) - (a.cost_value || 0));
    return sorted;
  }

  /* ── Resultados ────────────────────────────────────────────────────── */
  function renderResults(wines, relaxed, relaxNote) {
    const thread = document.getElementById('thread');

    // Se ainda assim não houver resultados, mostra botão de nova pesquisa
    if (!wines.length) {
      thread.innerHTML = `
        <div class="sw-wrap" style="text-align:center;padding:48px 0">
          <p style="color:var(--ink-2);font-size:15px;margin-bottom:20px">Nenhum vinho encontrado na faixa selecionada.</p>
          <button class="sw-btn-ghost" id="swRestart">↺ Nova pesquisa</button>
        </div>`;
      document.getElementById('swRestart').addEventListener('click', start);
      return;
    }

    let currentOrder = 'cb';
    let currentWines = sortWines(wines, currentOrder);

    function rebuildCards() {
      const container = document.getElementById('swCards');
      if (container) container.innerHTML = sortWines(wines, currentOrder).map(renderCard).join('');
    }

    thread.innerHTML = `
      <div class="sw-wrap">
        <div class="sw-cards wc-grid" id="swCards">${currentWines.map(renderCard).join('')}</div>
        <div class="sw-results-footer">
          <button class="sw-btn-ghost" id="swRestart">↺ Nova pesquisa</button>
        </div>
      </div>`;

    document.getElementById('swRestart').addEventListener('click', start);
  }

  /* ── Renderiza etapa ───────────────────────────────────────────────── */
  function renderStep() {
    const thread = document.getElementById('thread');
    const step   = STEPS[st.step];
    if (!step) { finish(); return; }

    const pct = Math.round((st.step / STEPS.length) * 100);

    const cards = step.options.map(opt => {
      const iconHtml = opt.flag
        ? `<img src="https://flagcdn.com/24x18/${opt.flag}.png" srcset="https://flagcdn.com/48x36/${opt.flag}.png 2x" width="24" height="18" class="wz-flag" alt="${opt.label}">`
        : '';
      // Marca a opção já selecionada
      const currentAns = st.answers[step.key];
      const isSelected = currentAns && (
        (step.key === 'price' ? currentAns.label === opt.label : currentAns === opt.label)
      );
      return `<button class="prompt-card wz-option${isSelected ? ' sw-selected' : ''}" data-label="${esc(opt.label)}">
        ${iconHtml}
        <span class="prompt-text wz-opt-label">${esc(opt.label)}</span>
      </button>`;
    }).join('');

    const backBtn = st.step > 0
      ? `<button class="wz-back" id="swBack">← Voltar</button>` : '';

    thread.innerHTML = `
      <div class="opener" id="opener">
        <img src="logo.png" alt="Empório Cosmopolita" class="opener-logo">
        <h1 class="opener-title">${step.label}</h1>
        <div class="prompt-grid">${cards}</div>
        ${backBtn}
      </div>`;

    // Listeners dos cards
    thread.querySelectorAll('.wz-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const label = btn.querySelector('.wz-opt-label').textContent.trim();
        const opt   = step.options.find(o => o.label === label);
        if (step.key === 'price') st.answers.price = opt;
        else st.answers[step.key] = label;

        st.step++;
        if (st.step >= STEPS.length) { finish(); return; }
        else renderStep();
      });
    });

    // Voltar
    document.getElementById('swBack')?.addEventListener('click', () => {
      st.step = Math.max(0, st.step - 1);
      renderStep();
    });
  }

  /* ── Finaliza e filtra ─────────────────────────────────────────────── */
  async function finish() {
    const thread = document.getElementById('thread');
    thread.innerHTML = '<div class="sw-wrap" style="text-align:center;padding:40px"><p style="color:var(--ink-2)">🍷 Buscando vinhos...</p></div>';

    // Aguarda catálogo
    let catalog = winesDB.getCatalog();
    if (!catalog || !catalog.wines || !catalog.wines.length) {
      try { await winesDB.fetchCatalog(); catalog = winesDB.getCatalog(); } catch(e) {}
    }
    const wines = catalog?.wines || [];

    // Tenta com todos os filtros
    let result = applyFilters(wines, st.answers, false);
    let relaxNote = '';

    // Relaxa progressivamente até ter ao menos 3 resultados
    if (result.length < 3) {
      // 1. Remove harmonização
      const a1 = Object.assign({}, st.answers, { harmonizacao: null });
      result = applyFilters(wines, a1, false);
      relaxNote = 'Mostrando sugestões próximas ao seu perfil.';
    }
    if (result.length < 3) {
      // 2. Remove país também
      const a2 = Object.assign({}, st.answers, { harmonizacao: null, pais: null });
      result = applyFilters(wines, a2, false);
      relaxNote = 'Não encontramos exatamente, mas aqui estão os mais próximos.';
    }
    if (result.length < 3) {
      // 3. Remove uva também
      const a3 = Object.assign({}, st.answers, { harmonizacao: null, pais: null, uva: null });
      result = applyFilters(wines, a3, false);
      relaxNote = 'Sugestões baseadas no tipo e faixa de preço escolhidos.';
    }
    if (result.length < 3) {
      // 4. Remove estilo — mantém só preço e tipo
      const a4 = Object.assign({}, st.answers, { harmonizacao: null, pais: null, uva: null, estilo: null });
      result = applyFilters(wines, a4, false);
      relaxNote = 'Sugestões baseadas no tipo e faixa de preço escolhidos.';
    }
    if (result.length < 3) {
      // 5. Remove tipo — só preço
      const a5 = Object.assign({}, st.answers, { harmonizacao: null, pais: null, uva: null, estilo: null, tipo: null });
      result = applyFilters(wines, a5, false);
      relaxNote = 'Sugestões disponíveis na faixa de preço escolhida.';
    }

    // Limita a 12 cards e ordena por custo-benefício
    result = result.sort((a,b) => (a.cost_value||0) - (b.cost_value||0)).slice(0, 12);

    renderResults(result, false, relaxNote);
  }

  /* ── Inicia ────────────────────────────────────────────────────────── */
  function start() {
    st = { step: 0, answers: {} };
    renderStep();
  }

  return { start, isActive: () => st.step > 0 };
})();

window.searchWizard = searchWizard;


/* ── Opener ─────────────────────────────────────────────── */
function renderOpener() {
  searchWizard.start();
}

function useSugg(el) {
  document.getElementById('msgInput').value = el.querySelector('.prompt-text').textContent.trim();
  sendMessage();
}

function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }

/* ── Envio ──────────────────────────────────────────────── */
async function sendMessage() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();
  if (!text || state.thinking) return;

  const op = document.getElementById('opener');
  if (op) op.remove();

  input.value = '';
  input.style.height = 'auto';

  state.history.push({ role: 'user', content: text });
  appendMessage('user', text);

  const session = state.sessions.find(s => s.id === state.currentId);
  if (session && session.title === 'Nova conversa')
    session.title = text.length > 44 ? text.slice(0, 44).trimEnd() + '…' : text;
  renderThreadList();

  state.thinking = true;
  document.getElementById('sendBtn').disabled = true;
  showTyping();

  try {
    const reply = await callApi();
    removeTyping();
    state.history.push({ role: 'assistant', content: reply });
    appendMessage('assistant', reply);
  } catch (err) {
    removeTyping();
    const msg = err.message && err.message.length < 200
      ? 'Erro: ' + err.message
      : 'Não consegui me conectar agora. Por favor, tente novamente em instantes.';
    appendMessage('assistant', msg);
    console.error('[emporio]', err);
  } finally {
    state.thinking = false;
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('msgInput').focus();
  }
}

async function callApi() {
  const recent = state.history.slice(-HISTORY_TURNS * 2);

  // Se catálogo ainda não carregou, tenta buscar agora (máx 8s)
  let catalog = winesDB.getCatalog();
  if (!catalog || !catalog.wines || !catalog.wines.length) {
    try { await winesDB.fetchCatalog(); catalog = winesDB.getCatalog(); } catch {}
  }

  const wines = catalog?.wines || [];

  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system:     SYSTEM_PROMPT,
      messages:   recent,
      max_tokens: 1400,
      wines,
    }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  const data = await res.json();
  if (typeof data.reply === 'string') return data.reply;
  throw new Error('Resposta inesperada.');
}

/* ── Render mensagem ────────────────────────────────────── */
function appendMessage(role, content, { instant = false } = {}) {
  const thread = document.getElementById('thread');
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-sommelier');
  if (instant) wrap.style.animation = 'none';
  wrap.innerHTML = role === 'user'
    ? `<div class="bubble">${esc(content)}</div>`
    : `<div class="sig">Cosmos <span class="sig-mark">EC</span></div><div class="body">${formatReply(content)}</div>`;
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

/* ── Parser → cards ─────────────────────────────────────── */

/* ── Imagem do vinho via Drive ──────────────────────────── */
function normWineName(name) {
  return String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
}
function wineImageUrl(name) {
  const map = window._driveImages || {};
  const key = normWineName(name);
  if (map[key]) return map[key];
  // Busca parcial (primeiros 25 chars)
  const k2 = Object.keys(map).find(k => k.startsWith(key.slice(0,25)));
  return k2 ? map[k2] : null;
}

function formatReply(raw) {
  const lines = raw.split('\n');
  let html = '', cards = [], current = null, tip = '';

  const flush = () => {
    if (!current) return;

    // ── HEADER ──
    const header =
      `<div class="wc-header">` +
        `<div class="wc-name">${esc(current.name)}</div>` +
        (current.maker ? `<div class="wc-maker">${esc(current.maker)}</div>` : '') +
        (current.costbenefit ? `<div class="wc-cb-flag">💰 Custo-benefício</div>` : '') +
      `</div>`;

    // ── LINHAS DE INFORMAÇÃO ──
    const infoLines = [
      current.tipo    ? `<div class="wc-line"><span class="wc-line-icon">🍷</span><span class="wc-line-label">Tipo</span><span class="wc-line-val">${esc(current.tipo)}</span></div>`        : '',
      current.grapes  ? `<div class="wc-line"><span class="wc-line-icon">🍇</span><span class="wc-line-label">Uva</span><span class="wc-line-val">${esc(current.grapes)}</span></div>`         : '',
      current.temp    ? `<div class="wc-line"><span class="wc-line-icon">🌡️</span><span class="wc-line-label">Temperatura</span><span class="wc-line-val">${esc(current.temp)}</span></div>`   : '',
      current.pairing ? `<div class="wc-line"><span class="wc-line-icon">🍽️</span><span class="wc-line-label">Harmoniza</span><span class="wc-line-val">${esc(current.pairing)}</span></div>` : '',
      current.aromas  ? `<div class="wc-line"><span class="wc-line-icon">🌸</span><span class="wc-line-label">Aromas</span><span class="wc-line-val wc-italic">${esc(current.aromas)}</span></div>` : '',
    ].filter(Boolean).join('');

    const infoBlock = infoLines
      ? `<div class="wc-lines">${infoLines}</div>`
      : '';

    // ── CUSTO-BENEFÍCIO (só na 3ª opção) ──
    const cb = current.costbenefit
      ? `<div class="wc-cb-row">💡 ${esc(current.costbenefit)}</div>`
      : '';

    // ── RODAPÉ: motivo + preço lado a lado ──
    const footer = (current.why || current.priceDisplay)
      ? `<div class="wc-footer">` +
          (current.why          ? `<div class="wc-why-text">✅ ${esc(current.why)}</div>`            : '') +
          (current.priceDisplay ? `<div class="wc-price-tag">${esc(current.priceDisplay)}</div>` : '') +
        `</div>`
      : '';

    cards.push(`${header}${infoBlock}${cb}${footer}`);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^\*\*(.+?)\*\*\s*[—–-]\s*(.+)/);
    if (match) {
      flush();
      current = {
        name: match[1].trim(), maker: match[2].trim(),
        pills: [], tipo: '', price: '', grapes: '',
        visual: '', temp: '', dec: '', corpo: '', taninos: '',
        pairing: '', aromas: '', notes: '', guarda: '', import_: '',
        costbenefit: '', why: '', priceDisplay: '',
      };
      continue;
    }

    if (current) {
      // Helper: remove prefixo "LABEL: " e retorna só o valor
      const val = line.replace(/^[^\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\w]*[:\s]+/, '')
                      .replace(/^[^:]+:\s*/, '').trim() || line.replace(/^.{1,4}\s*/, '').trim();

      if (/custo.benef/i.test(line) && /^💰/.test(line)) {
        current.costbenefit = val;
      } else if (/^💵|Preço estimado/i.test(line)) {
        current.priceDisplay = val;
      } else if (/^💰/.test(line) && !current.costbenefit) {
        const m = line.match(/R\$[^\n,;]*/i);
        current.price = m ? m[0].trim() : val;
      } else if (/^🍇|^Uva:/i.test(line)) {
        current.grapes = val;
      } else if (/^(🔴|🟢|🍾|🟡|🔵|⚪|🍷|🥂|🍺)|^Tipo:/i.test(line)) {
        current.tipo = val;
      } else if (/^🌡|^Temperatura:/i.test(line)) {
        current.temp = val.replace(/\s*[·|].*$/, '').trim();
      } else if (/^🍽|^Harmoniza:/i.test(line)) {
        current.pairing = val;
      } else if (/^🌸|^Aromas:/i.test(line)) {
        current.aromas = val;
      } else if (/^✅|^Por que/i.test(line)) {
        current.why = val;
      } else if (/^💡/.test(line)) {
        tip = val;
      }
      // Qualquer linha não reconhecida NÃO quebra o card
      continue;
    }

    if (line.startsWith('💡')) { tip = line.replace(/^💡\s*/, '').trim(); continue; }
    html += `<p>${inlineMd(line)}</p>`;
  }

  flush();
  if (cards.length) html += `<div class="wines">${cards.map(c => `<div class="wine">${c}</div>`).join('')}</div>`;
  if (tip) html += `<div class="tip-bar">${esc(tip)}</div>`;
  return html;
}

function inlineMd(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showTyping() {
  const thread = document.getElementById('thread');
  const el = document.createElement('div');
  el.className = 'typing'; el.id = 'typing-el';
  el.innerHTML = `O Cosmos está pensando <span class="typing-dots"><span></span><span></span><span></span></span>`;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}
function removeTyping() { const el = document.getElementById('typing-el'); if (el) el.remove(); }
