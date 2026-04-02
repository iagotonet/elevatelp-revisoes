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
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ElevateLP/2.0)' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout || 20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function stripHtml(h) {
  return (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Capturar screenshot de uma URL numa posição específica usando Playwright via API
// Como não temos Playwright, usamos o serviço headless do browserless.io ou
// a API do screenshotone.com que é gratuita com limitações
// Melhor abordagem: usar o puppeteer via API externa gratuita
async function tirarScreenshot(pageUrl, scrollY) {
  // Usar screenshotone API (gratuita, sem chave para uso básico)
  // ou usar a API do htmlcsstoimage
  // Melhor: usar o endpoint do microlink com o parâmetro de scroll/clip

  // Abordagem: usar a API do microlink com viewport e scroll
  const params = new URLSearchParams({
    url: pageUrl,
    screenshot: 'true',
    meta: 'false',
    embed: 'screenshot.url',
    'viewport.width': '1280',
    'viewport.height': '800',
    'waitFor': '3000', // esperar 3s após carregar
  });

  if (scrollY > 0) {
    params.set('scroll', scrollY.toString());
  }

  const apiUrl = 'https://api.microlink.io/?' + params.toString();

  try {
    const response = await fetchUrl(apiUrl, 30000);
    const json = JSON.parse(response);
    if (json.status === 'success' && json.data && json.data.screenshot && json.data.screenshot.url) {
      return json.data.screenshot.url;
    }
  } catch(e) {}
  return null;
}

// Extrair dobras da página HTML
function extrairDobras(html, pageUrl) {
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  const dobras = [];
  // Tentar seções do Elementor
  const secPattern = /<section[^>]*class="[^"]*elementor-section[^"]*"[^>]*>([\s\S]*?)<\/section>/gi;
  let m, idx = 0;
  while ((m = secPattern.exec(html)) !== null && dobras.length < 15) {
    const textos = extrairTextos(m[1]).slice(0, 8);
    if (textos.length > 0) {
      idx++;
      dobras.push({ numero: idx, titulo: 'Seção ' + idx, textos, screenshotUrl: null });
    }
  }
  // Fallback por H2/H3
  if (dobras.length < 2) {
    const parts = html.split(/<h[23][^>]*>/gi);
    parts.forEach((sec, i) => {
      if (i === 0 || dobras.length >= 12) return;
      const textos = extrairTextos(sec).slice(0, 8);
      if (textos.length > 0) {
        dobras.push({ numero: i, titulo: 'Seção ' + i, textos, screenshotUrl: null });
      }
    });
  }
  // Mínimo 1
  if (dobras.length === 0) {
    dobras.push({ numero: 1, titulo: 'Página completa', textos: [], screenshotUrl: null });
  }
  return dobras;
}

function extrairTextos(html) {
  const textos = [];
  const pat = /<(h[1-6]|p|span|a|button)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = pat.exec(html)) !== null) {
    const t = stripHtml(m[2]).trim();
    if (t.length > 3 && t.length < 300 && !/^https?:/.test(t)) textos.push(t);
  }
  return [...new Set(textos)];
}

function extractElementorTexts(data) {
  const texts = [];
  const seen = new Set();
  const FIELDS = new Set(['title','text','editor','description','button_text','title_text','description_text','acc_title','acc_content','tab_title','ekit_heading_title','ekit_heading_sub_title','ekit_icon_box_title_text','ekit_icon_box_description_text','client_name','designation','review','name','content','label','heading','subtitle','caption']);

  function isJunk(v) {
    if (!v || v.length < 2) return true;
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
    if (/^https?:\/\//.test(v)) return true;
    if (/^\d+(\.\d+)?(px|em|rem|%)?$/.test(v)) return true;
    if (/^[a-f0-9]{6,32}$/.test(v)) return true;
    if (/^[a-z0-9_-]+$/.test(v) && v.length <= 20) return true;
    if (v.replace(/[^a-zA-ZÀ-ÿ]/g,'').length < 2) return true;
    const junk = new Set(['yes','no','true','false','none','auto','inherit','center','left','right','top','bottom','full','solid','custom','normal','bold','italic','image','recent','fadeIn','fast','slow']);
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
      res.on('end', () => {
        try { const r = JSON.parse(data); if (r.error) reject(new Error(r.error.message)); else resolve(r.content[0].text.trim()); } catch(e) { reject(e); }
      });
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

// Tirar screenshots de cada dobra com scroll correto
async function capturarScreenshots(pageUrl, dobras) {
  if (!pageUrl || dobras.length === 0) return;

  // Primeiro: tirar screenshot do topo para estimar altura total
  // Depois: calcular scroll por dobra e tirar screenshot de cada uma
  console.log('Capturando screenshots para', dobras.length, 'dobras...');

  // Usar microlink com parâmetro waitFor para cada dobra
  // Estimativa: cada dobra tem ~700px de altura em média
  const alturaEstimadaPorDobra = 700;

  for (let i = 0; i < dobras.length; i++) {
    const scrollY = i === 0 ? 0 : Math.round(i * alturaEstimadaPorDobra);
    try {
      // Montar URL do microlink com scroll correto
      const encodedUrl = encodeURIComponent(pageUrl);
      // Usar JavaScript injection para scroll via microlink
      const mlUrl = 'https://api.microlink.io/?url=' + encodedUrl +
        '&screenshot=true&meta=false&embed=screenshot.url' +
        '&viewport.width=1280&viewport.height=800' +
        '&waitFor=3000' +
        (scrollY > 0 ? '&scroll=' + scrollY : '');

      console.log('Screenshot dobra', i+1, 'scroll:', scrollY);
      const response = await fetchUrl(mlUrl, 30000);
      const json = JSON.parse(response);
      if (json.status === 'success' && json.data?.screenshot?.url) {
        dobras[i].screenshotUrl = json.data.screenshot.url;
        console.log('OK dobra', i+1, dobras[i].screenshotUrl.substring(0,60));
      } else {
        console.log('Falhou dobra', i+1, JSON.stringify(json).substring(0, 100));
      }
      // Delay entre requests para não ser bloqueado
      if (i < dobras.length - 1) await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.log('Erro screenshot dobra', i+1, e.message);
    }
  }
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

      // Extrair dobras da URL
      if (pageUrl) {
        try {
          const html = await fetchUrl(pageUrl, 20000);
          dobras = extrairDobras(html, pageUrl);
        } catch(e) {
          console.log('Erro ao buscar página:', e.message);
          dobras = [{ numero: 1, titulo: 'Página completa', textos: [], screenshotUrl: null }];
        }
      }

      // Extrair textos do JSON
      if (jsonData) {
        const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        textos = extractElementorTexts(parsed);
        // Distribuir textos pelas dobras
        if (dobras.length > 0) {
          textos.forEach((t, i) => {
            const dobraIdx = Math.min(Math.floor(i / Math.ceil(textos.length / dobras.length)), dobras.length - 1);
            if (!dobras[dobraIdx].textos) dobras[dobraIdx].textos = [];
            if (!dobras[dobraIdx].textos.includes(t.text)) dobras[dobraIdx].textos.push(t.text);
          });
        }
      }

      sessoes[sessaoId] = {
        id: sessaoId, clienteNome, pageUrl: pageUrl || '', jsonData: jsonData || null,
        textos, dobras, revisoes: [], criadoEm: new Date().toISOString(), status: 'aguardando',
        screenshotsReady: false
      };

      // Responder imediatamente com a sessão criada
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, sessaoId, dobras: dobras.length }));

      // Capturar screenshots em background (não bloqueia a resposta)
      if (pageUrl && dobras.length > 0) {
        capturarScreenshots(pageUrl, sessoes[sessaoId].dobras).then(() => {
          sessoes[sessaoId].screenshotsReady = true;
          console.log('Screenshots prontos para sessão', sessaoId);
        }).catch(e => console.log('Erro screenshots:', e.message));
      }

    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Listar sessões
  if (req.method === 'GET' && pathname === '/api/sessoes') {
    const lista = Object.values(sessoes).map(s => ({
      id: s.id, clienteNome: s.clienteNome, pageUrl: s.pageUrl,
      dobras: s.dobras.length, status: s.status, revisoes: s.revisoes.length,
      criadoEm: s.criadoEm, screenshotsReady: s.screenshotsReady
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, sessoes: lista })); return;
  }

  // Buscar sessão
  if (req.method === 'GET' && pathname === '/api/sessao') {
    const id = url.searchParams.get('id');
    const s = sessoes[id];
    if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Sessão não encontrada' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, sessao: { ...s, jsonData: undefined } })); return;
  }

  // Revisar dobra
  if (req.method === 'POST' && pathname === '/api/revisar-dobra') {
    try {
      const { sessaoId, dobraNumero, revisoes } = await parseBody(req);
      const s = sessoes[sessaoId];
      if (!s) throw new Error('Sessão não encontrada');
      s.revisoes = s.revisoes.filter(r => r.dobraNumero !== dobraNumero);
      s.revisoes.push({ dobraNumero, revisoes, enviadoEm: new Date().toISOString() });
      s.status = 'em_revisao';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Finalizar revisão
  if (req.method === 'POST' && pathname === '/api/finalizar-revisao') {
    try {
      const { sessaoId } = await parseBody(req);
      const s = sessoes[sessaoId];
      if (!s) throw new Error('Sessão não encontrada');
      s.status = 'revisao_concluida';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Aplicar alterações com IA
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
          if (alt.tipo === 'cor') return 'Mudar cor: ' + alt.campo + ' para ' + alt.cor;
          if (alt.tipo === 'imagem') return 'Imagem: ' + alt.descricao;
          return 'Obs: ' + alt.texto;
        });
        return 'DOBRA ' + r.dobraNumero + ':\n' + linhas.join('\n');
      }).join('\n\n');

      const parsed = typeof s.jsonData === 'string' ? JSON.parse(s.jsonData) : s.jsonData;
      const texts = s.textos.length > 0 ? s.textos : extractElementorTexts(parsed);
      const textSummary = texts.map((t, i) => '[' + i + '] [' + t.wt + '] "' + t.text.substring(0, 80) + '"').join('\n');

      const sys = 'Aplica revisoes de clientes em landing pages. JSON: {"aplicacoes":[{"indice":0,"textoNovo":"texto","motivo":"motivo"}],"pendencias":[{"tipo":"cor|imagem|outro","descricao":"o que fazer","detalhe":"valor"}]}';
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
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('ElevateLP Revisoes porta ' + PORT));
