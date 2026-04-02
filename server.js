const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const sessoes = {};

function genId() { return crypto.randomBytes(6).toString('hex'); }

function fetchUrl(url, timeout) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
        }
      }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(timeout || 20000, () => { req.destroy(); reject(new Error('timeout')); });
    } catch(e) { reject(e); }
  });
}

function stripHtml(h) {
  return (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tirar screenshot da página inteira UMA vez e salvar a URL
async function tirarScreenshotPagina(pageUrl) {
  try {
    const mlUrl = 'https://api.microlink.io/?' + new URLSearchParams({
      url: pageUrl,
      screenshot: 'true',
      meta: 'false',
      embed: 'screenshot.url',
      'viewport.width': '1280',
      'viewport.height': '900',
      'waitFor': '3000',
      'fullPage': 'true'  // screenshot da página INTEIRA
    }).toString();

    console.log('Tirando screenshot full-page de:', pageUrl);
    const response = await fetchUrl(mlUrl, 40000);
    const json = JSON.parse(response);

    if (json.status === 'success' && json.data && json.data.screenshot && json.data.screenshot.url) {
      console.log('Screenshot OK:', json.data.screenshot.url.substring(0, 80));
      return json.data.screenshot.url;
    }
    console.log('Screenshot falhou:', JSON.stringify(json).substring(0, 200));
    return null;
  } catch(e) {
    console.log('Erro screenshot:', e.message);
    return null;
  }
}

function extractElementorTexts(data) {
  const texts = [];
  const seen = new Set();
  const FIELDS = new Set(['title','text','editor','description','button_text','title_text','description_text',
    'acc_title','acc_content','tab_title','ekit_heading_title','ekit_heading_sub_title',
    'ekit_icon_box_title_text','ekit_icon_box_description_text','client_name','designation',
    'review','name','content','label','heading','subtitle','caption','ekit_icon_box_btn_text']);

  function isJunk(v) {
    if (!v || v.length < 2) return true;
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
    if (/^https?:\/\//.test(v)) return true;
    if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw)?$/.test(v)) return true;
    if (/^[a-f0-9]{6,32}$/.test(v)) return true;
    if (/^[a-z0-9_-]+$/.test(v) && v.length <= 20 && !v.includes(' ')) return true;
    if (v.replace(/[^a-zA-ZÀ-ÿ]/g,'').length < 2) return true;
    const junk = new Set(['yes','no','true','false','none','auto','inherit','center','left','right',
      'top','bottom','full','solid','custom','normal','bold','italic','image','recent',
      'fadeIn','fast','slow','shrink','uppercase','lowercase','middle','stretch']);
    return junk.has(v.toLowerCase());
  }

  function walk(els) {
    if (!Array.isArray(els)) return;
    for (const el of els) {
      if (!el || typeof el !== 'object') continue;
      const wt = el.widgetType || '', s = el.settings || {}, eid = el.id || '';
      if (!wt || typeof s !== 'object') { if (el.elements) walk(el.elements); continue; }
      for (const [f, v] of Object.entries(s)) {
        if (!FIELDS.has(f)) continue;
        if (typeof v === 'string') {
          const clean = stripHtml(v), key = eid + ':' + f;
          if (!seen.has(key) && !isJunk(clean)) { seen.add(key); texts.push({ elId: eid, wt, field: f, text: clean, rawHtml: v.includes('<') }); }
        } else if (Array.isArray(v)) {
          v.forEach((item, idx) => {
            if (!item || typeof item !== 'object') return;
            for (const [sf, sv] of Object.entries(item)) {
              if (!FIELDS.has(sf) || typeof sv !== 'string') continue;
              const key2 = eid + ':' + f + ':' + idx + ':' + sf, clean = stripHtml(sv);
              if (!seen.has(key2) && !isJunk(clean)) { seen.add(key2); texts.push({ elId: eid, wt, listKey: f, idx, sub: sf, text: clean, rawHtml: sv.includes('<') }); }
            }
          });
        }
      }
      if (el.elements) walk(el.elements);
    }
  }
  walk(Array.isArray(data) ? data : (data.content || []));
  return texts;
}

// Criar dobras baseadas nos elementos do JSON
// Cada section/container do Elementor vira uma dobra
function extrairDobrasDoJson(data) {
  const dobras = [];
  const root = Array.isArray(data) ? data : (data.content || []);

  function getTextos(el) {
    const texts = [];
    const FIELDS = new Set(['title','text','editor','description','button_text','title_text','description_text','ekit_heading_title','ekit_icon_box_title_text','client_name']);
    function isJunk(v) {
      if (!v || v.length < 2) return true;
      if (/^#[0-9a-fA-F]+$/.test(v) || /^https?:\/\//.test(v)) return true;
      if (/^[a-z0-9_-]+$/.test(v) && v.length <= 15) return true;
      return false;
    }
    function walk(e) {
      if (!e || typeof e !== 'object') return;
      const s = e.settings || {};
      for (const [f, v] of Object.entries(s)) {
        if (!FIELDS.has(f)) continue;
        if (typeof v === 'string') { const c = stripHtml(v); if (!isJunk(c)) texts.push(c); }
      }
      if (Array.isArray(e.elements)) e.elements.forEach(walk);
    }
    walk(el);
    return [...new Set(texts)].slice(0, 8);
  }

  // Cada elemento de nível raiz = uma dobra
  root.forEach((section, i) => {
    if (!section || typeof section !== 'object') return;
    const textos = getTextos(section);
    // Só adicionar se tem algum texto real
    if (textos.length > 0 || i === 0) {
      dobras.push({
        numero: dobras.length + 1,
        titulo: 'Seção ' + (dobras.length + 1),
        textos: textos,
        screenshotUrl: null,
        // Posição estimada: percentual na página
        posicaoPct: (i / Math.max(root.length - 1, 1)) * 100
      });
    }
  });

  if (dobras.length === 0) {
    dobras.push({ numero: 1, titulo: 'Página completa', textos: [], screenshotUrl: null, posicaoPct: 0 });
  }

  return dobras;
}

function applyTexts(jsonData, texts, copies) {
  const adapted = JSON.parse(JSON.stringify(jsonData));
  function applyOne(t, newText) {
    const r = Array.isArray(adapted) ? adapted : (adapted.content || []);
    function w(els) {
      if (!Array.isArray(els)) return false;
      for (const el of els) {
        if (!el || typeof el !== 'object') continue;
        if (el.id === t.elId) {
          const s = el.settings || {};
          if (t.listKey) {
            const lst = s[t.listKey];
            if (Array.isArray(lst) && lst[t.idx] !== undefined) { lst[t.idx][t.sub] = t.rawHtml ? '<p>' + newText + '</p>' : newText; return true; }
          } else if (t.field === 'editor') { s.editor = '<p>' + newText + '</p>'; return true; }
          else if (t.field) { s[t.field] = newText; return true; }
        }
        if (el.elements && w(el.elements)) return true;
      }
      return false;
    }
    return w(r);
  }
  let count = 0;
  for (let i = 0; i < texts.length; i++) {
    if (copies[i] && copies[i] !== texts[i].text && applyOne(texts[i], copies[i])) count++;
  }
  return { adapted, count };
}

function callClaude(system, userMsg) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, system, messages: [{ role: 'user', content: userMsg }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { const r = JSON.parse(data); if (r.error) reject(new Error(r.error.message)); else resolve(r.content[0].text.trim()); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload); req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('JSON inválido')); } });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); return;
  }
  if (req.method === 'GET' && pathname === '/revisao') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'revisao.html'))); return;
  }

  // Criar sessão
  if (req.method === 'POST' && pathname === '/api/criar-sessao') {
    try {
      const { clienteNome, pageUrl, jsonData } = await parseBody(req);
      if (!clienteNome) throw new Error('Nome do cliente obrigatório');

      const sessaoId = genId();
      let dobras = [];
      let textos = [];

      // Extrair dobras e textos do JSON (mais confiável que o HTML)
      if (jsonData) {
        const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        textos = extractElementorTexts(parsed);
        dobras = extrairDobrasDoJson(parsed);
      } else if (pageUrl) {
        // Sem JSON: criar dobra única
        dobras = [{ numero: 1, titulo: 'Página completa', textos: [], screenshotUrl: null, posicaoPct: 0 }];
      } else {
        throw new Error('Informe a URL ou o JSON da página');
      }

      sessoes[sessaoId] = {
        id: sessaoId, clienteNome, pageUrl: pageUrl || '',
        jsonData: jsonData || null, textos, dobras,
        screenshotPaginaUrl: null, // screenshot único da página inteira
        screenshotsReady: false,
        revisoes: [], criadoEm: new Date().toISOString(), status: 'aguardando'
      };

      // Responder imediatamente
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, sessaoId, dobras: dobras.length }));

      // Capturar screenshot em background
      if (pageUrl) {
        tirarScreenshotPagina(pageUrl).then(screenshotUrl => {
          if (screenshotUrl) {
            sessoes[sessaoId].screenshotPaginaUrl = screenshotUrl;
            sessoes[sessaoId].screenshotsReady = true;
            console.log('Screenshot pronto para sessão', sessaoId);
          }
        }).catch(e => console.log('Erro screenshot:', e.message));
      } else {
        sessoes[sessaoId].screenshotsReady = true;
      }

    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessoes') {
    const lista = Object.values(sessoes).map(s => ({
      id: s.id, clienteNome: s.clienteNome, pageUrl: s.pageUrl,
      dobras: s.dobras.length, status: s.status, revisoes: s.revisoes.length,
      criadoEm: s.criadoEm, screenshotsReady: s.screenshotsReady
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, sessoes: lista })); return;
  }

  if (req.method === 'GET' && pathname === '/api/sessao') {
    const id = url.searchParams.get('id');
    const s = sessoes[id];
    if (!s) { res.writeHead(404); res.end(JSON.stringify({ success: false, error: 'Sessão não encontrada' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, sessao: { ...s, jsonData: undefined } })); return;
  }

  if (req.method === 'POST' && pathname === '/api/revisar-dobra') {
    try {
      const { sessaoId, dobraNumero, revisoes } = await parseBody(req);
      const s = sessoes[sessaoId];
      if (!s) throw new Error('Sessão não encontrada');
      s.revisoes = s.revisoes.filter(r => r.dobraNumero !== dobraNumero);
      s.revisoes.push({ dobraNumero, revisoes, enviadoEm: new Date().toISOString() });
      s.status = 'em_revisao';
      res.writeHead(200); res.end(JSON.stringify({ success: true }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false, error: e.message })); }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/finalizar-revisao') {
    try {
      const { sessaoId } = await parseBody(req);
      const s = sessoes[sessaoId];
      if (!s) throw new Error('Sessão não encontrada');
      s.status = 'revisao_concluida';
      res.writeHead(200); res.end(JSON.stringify({ success: true }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false, error: e.message })); }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/aplicar') {
    try {
      const { sessaoId } = await parseBody(req);
      const s = sessoes[sessaoId];
      if (!s) throw new Error('Sessão não encontrada');
      if (!s.jsonData) throw new Error('JSON não disponível');
      if (s.revisoes.length === 0) throw new Error('Nenhuma revisão enviada');

      const resumo = s.revisoes.map(r => {
        const linhas = (r.revisoes || []).map(alt => {
          if (alt.tipo === 'texto') return 'Trocar "' + alt.de + '" por "' + alt.para + '"';
          if (alt.tipo === 'cor') return 'Cor: ' + alt.campo + ' → ' + alt.cor;
          if (alt.tipo === 'imagem') return 'Imagem: ' + alt.descricao;
          return 'Obs: ' + alt.texto;
        });
        return 'SEÇÃO ' + r.dobraNumero + ':\n' + linhas.join('\n');
      }).join('\n\n');

      const parsed = typeof s.jsonData === 'string' ? JSON.parse(s.jsonData) : s.jsonData;
      const texts = s.textos.length > 0 ? s.textos : extractElementorTexts(parsed);
      const textSummary = texts.map((t, i) => '[' + i + '] [' + t.wt + '] "' + t.text.substring(0, 80) + '"').join('\n');
      const sys = 'Aplica revisoes em landing pages. JSON: {"aplicacoes":[{"indice":0,"textoNovo":"texto","motivo":"motivo"}],"pendencias":[{"tipo":"cor|imagem|outro","descricao":"o que fazer","detalhe":"valor"}]}';
      const msg = 'CLIENTE: ' + s.clienteNome + '\n\nREVISOES:\n' + resumo + '\n\nTEXTOS (0 a ' + (texts.length-1) + '):\n' + textSummary;
      const response = await callClaude(sys, msg);
      let resultado = { aplicacoes: [], pendencias: [] };
      try { resultado = JSON.parse(response.replace(/```json|```/gi,'').trim()); } catch(e) {}
      const copies = texts.map(t => t.text);
      (resultado.aplicacoes || []).forEach(ap => { if (ap.indice >= 0 && ap.indice < texts.length && ap.textoNovo) copies[ap.indice] = ap.textoNovo; });
      const { adapted, count } = applyTexts(parsed, texts, copies);
      s.status = 'aplicado';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, aplicados: count, pendencias: resultado.pendencias || [], json: adapted }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false, error: e.message })); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('ElevateLP Revisoes porta ' + PORT));
