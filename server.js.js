const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Banco em memória (persiste enquanto o servidor está rodando)
// Em produção ideal seria um banco de dados, mas para este uso funciona bem
const sessoes = {};

// Gerar ID único
function genId() {
  return crypto.randomBytes(6).toString('hex');
}

// Fetch URL
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ElevateLP/2.0)' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function stripHtml(h) {
  return (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Extrair dobras/seções da página HTML
function extrairDobras(html) {
  // Remove scripts e styles
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  const dobras = [];

  // Tentar detectar sections do Elementor
  const sectionPattern = /<section[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gi;
  let m;
  let sectionIdx = 0;

  while ((m = sectionPattern.exec(html)) !== null) {
    const sectionHtml = m[2];
    const textos = [];
    const textPat = /<(h[1-6]|p|span|a|button|div)[^>]*>([\s\S]*?)<\/\1>/gi;
    let tm;
    while ((tm = textPat.exec(sectionHtml)) !== null) {
      const t = stripHtml(tm[2]).trim();
      if (t.length > 3 && t.length < 400 && !t.match(/^https?:\/\//)) {
        textos.push(t);
      }
    }
    const uniqueTextos = [...new Set(textos)].slice(0, 10);
    if (uniqueTextos.length > 0) {
      sectionIdx++;
      dobras.push({
        numero: sectionIdx,
        titulo: 'Dobra ' + sectionIdx,
        textos: uniqueTextos,
        dataId: m[1]
      });
    }
  }

  // Fallback: se não encontrou sections do Elementor, dividir por H2/H3
  if (dobras.length === 0) {
    const sections = html.split(/<h[23][^>]*>/gi);
    sections.forEach((sec, i) => {
      if (i === 0) return;
      const textos = [];
      const textPat = /<(h[1-6]|p|span|button)[^>]*>([\s\S]*?)<\/\1>/gi;
      let tm;
      while ((tm = textPat.exec(sec)) !== null) {
        const t = stripHtml(tm[2]).trim();
        if (t.length > 3 && t.length < 400) textos.push(t);
      }
      const unique = [...new Set(textos)].slice(0, 8);
      if (unique.length > 0) {
        dobras.push({ numero: i, titulo: 'Seção ' + i, textos: unique });
      }
    });
  }

  return dobras.slice(0, 20); // máximo 20 dobras
}

// Extrair textos do JSON Elementor
function extractElementorTexts(data) {
  const texts = [];
  const seen = new Set();

  const CONTENT_FIELDS = new Set(['title','text','editor','description','button_text','title_text','description_text','acc_title','acc_content','tab_title','tab_content','ekit_heading_title','ekit_heading_sub_title','ekit_icon_box_title_text','ekit_icon_box_description_text','ekit_icon_box_btn_text','client_name','designation','review','name','content','label','heading','subtitle','caption']);

  function isJunk(v) {
    const junk = new Set(['yes','no','true','false','none','auto','inherit','initial','center','left','right','top','bottom','middle','full','stretch','h1','h2','h3','h4','h5','h6','classic','gradient','solid','custom','uppercase','lowercase','normal','bold','italic','image','recent','fadeIn','fadeInUp','fast','slow','shrink']);
    if (junk.has((v||'').toLowerCase())) return true;
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
    if (/^https?:\/\//.test(v)) return true;
    if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw)?$/.test(v)) return true;
    if (/^[a-f0-9]{6,32}$/.test(v)) return true;
    if (/^[a-z0-9_-]+$/.test(v) && v.length <= 20) return true;
    const letters = v.replace(/[^a-zA-ZÀ-ÿ]/g, '');
    if (letters.length < 2) return true;
    return false;
  }

  function walk(els) {
    if (!Array.isArray(els)) return;
    for (const el of els) {
      if (!el || typeof el !== 'object') continue;
      const wt = el.widgetType || '';
      const s = el.settings || {};
      const eid = el.id || '';
      if (!wt || typeof s !== 'object') { if (el.elements) walk(el.elements); continue; }

      for (const [field, val] of Object.entries(s)) {
        if (!CONTENT_FIELDS.has(field)) continue;
        if (typeof val === 'string') {
          const clean = stripHtml(val);
          const key = eid + ':' + field;
          if (!seen.has(key) && !isJunk(clean) && clean.length > 1) {
            seen.add(key);
            texts.push({ elId: eid, wt, field, text: clean, rawHtml: val.includes('<') });
          }
        } else if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            if (!item || typeof item !== 'object') return;
            for (const [sf, sv] of Object.entries(item)) {
              if (!CONTENT_FIELDS.has(sf)) continue;
              const key2 = eid + ':' + field + ':' + idx + ':' + sf;
              if (seen.has(key2) || typeof sv !== 'string') continue;
              const clean = stripHtml(sv);
              if (!isJunk(clean) && clean.length > 1) {
                seen.add(key2);
                texts.push({ elId: eid, wt, listKey: field, idx, sub: sf, text: clean, rawHtml: sv.includes('<') });
              }
            }
          });
        }
      }
      if (el.elements) walk(el.elements);
    }
  }

  const root = Array.isArray(data) ? data : (data.content || []);
  walk(root);
  return texts;
}

// Aplicar textos no JSON
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
            if (Array.isArray(lst) && lst[t.idx] !== undefined) {
              lst[t.idx][t.sub] = t.rawHtml ? '<p>' + newText + '</p>' : newText;
              return true;
            }
          } else if (t.field === 'editor') {
            s.editor = '<p>' + newText + '</p>'; return true;
          } else if (t.field) {
            s[t.field] = newText; return true;
          }
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

// Chamar Claude API
function callClaude(system, userMsg, model) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: userMsg }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.content[0].text.trim());
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('JSON inválido')); }
    });
  });
}

function cleanJson(str) {
  return (str || '').replace(/```json/gi, '').replace(/```/g, '').trim();
}

// ========== SERVER ==========
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // Servir frontend
  if (req.method === 'GET' && pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }

  // Servir página do cliente
  if (req.method === 'GET' && pathname === '/revisao') {
    const html = fs.readFileSync(path.join(__dirname, 'revisao.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }

  // ====== API ======

  // Criar nova sessão de revisão
  if (req.method === 'POST' && pathname === '/api/criar-sessao') {
    try {
      const { clienteNome, pageUrl, jsonData } = await parseBody(req);
      if (!clienteNome) throw new Error('Nome do cliente obrigatório');
      if (!pageUrl && !jsonData) throw new Error('Informe a URL da página ou o JSON');

      const sessaoId = genId();
      const linkCliente = 'LINK_BASE/revisao?s=' + sessaoId;

      // Buscar página e extrair dobras
      let dobras = [];
      let textos = [];

      if (pageUrl) {
        try {
          const html = await fetchUrl(pageUrl);
          dobras = extrairDobras(html);
        } catch(e) {
          dobras = [{ numero: 1, titulo: 'Página completa', textos: [] }];
        }
      }

      if (jsonData) {
        const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        textos = extractElementorTexts(parsed);

        // Associar textos às dobras
        if (dobras.length === 0) {
          // Sem dobras detectadas: criar dobras agrupando textos de 8 em 8
          const chunkSize = 8;
          for (let i = 0; i < textos.length; i += chunkSize) {
            const chunk = textos.slice(i, i + chunkSize);
            dobras.push({
              numero: Math.floor(i / chunkSize) + 1,
              titulo: 'Seção ' + (Math.floor(i / chunkSize) + 1),
              textos: chunk.map(t => t.text),
              textosIdx: chunk.map((_, j) => i + j)
            });
          }
        } else {
          // Associar textos às dobras por proximidade
          dobras = dobras.map((d, di) => {
            const start = Math.floor((di / dobras.length) * textos.length);
            const end = Math.floor(((di + 1) / dobras.length) * textos.length);
            const chunk = textos.slice(start, end);
            return {
              ...d,
              textos: [...new Set([...d.textos, ...chunk.map(t => t.text)])].slice(0, 10),
              textosIdx: chunk.map((_, j) => start + j)
            };
          });
        }
      }

      sessoes[sessaoId] = {
        id: sessaoId,
        clienteNome,
        pageUrl: pageUrl || '',
        jsonData: jsonData || null,
        textos,
        dobras,
        revisoes: [], // preenchido pelo cliente
        criadoEm: new Date().toISOString(),
        status: 'aguardando'
      };

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, sessaoId, linkCliente, dobras: dobras.length }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Listar sessões (painel)
  if (req.method === 'GET' && pathname === '/api/sessoes') {
    const lista = Object.values(sessoes).map(s => ({
      id: s.id,
      clienteNome: s.clienteNome,
      pageUrl: s.pageUrl,
      dobras: s.dobras.length,
      status: s.status,
      revisoes: s.revisoes.length,
      criadoEm: s.criadoEm
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, sessoes: lista }));
    return;
  }

  // Buscar sessão (cliente + painel)
  if (req.method === 'GET' && pathname === '/api/sessao') {
    const id = url.searchParams.get('id');
    const s = sessoes[id];
    if (!s) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Sessão não encontrada' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, sessao: { ...s, jsonData: undefined } })); // não expor JSON raw
    return;
  }

  // Cliente envia revisão de uma dobra
  if (req.method === 'POST' && pathname === '/api/revisar-dobra') {
    try {
      const { sessaoId, dobraNumero, revisoes } = await parseBody(req);
      const s = sessoes[sessaoId];
      if (!s) throw new Error('Sessão não encontrada');

      // Remover revisão anterior desta dobra se existir
      s.revisoes = s.revisoes.filter(r => r.dobraNumero !== dobraNumero);
      // Adicionar nova
      s.revisoes.push({ dobraNumero, revisoes, enviadoEm: new Date().toISOString() });
      s.status = 'em_revisao';

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Cliente finaliza revisão
  if (req.method === 'POST' && pathname === '/api/finalizar-revisao') {
    try {
      const { sessaoId } = await parseBody(req);
      const s = sessoes[sessaoId];
      if (!s) throw new Error('Sessão não encontrada');
      s.status = 'revisao_concluida';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
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
      if (!s.jsonData) throw new Error('JSON da página não disponível nesta sessão');
      if (s.revisoes.length === 0) throw new Error('Nenhuma revisão enviada ainda');

      // Montar resumo de todas as revisões
      const resumoRevisoes = s.revisoes.map(r => {
        const linhas = (r.revisoes || []).map(alt => {
          if (alt.tipo === 'texto') return 'Trocar texto "' + alt.de + '" por "' + alt.para + '"';
          if (alt.tipo === 'cor') return 'Mudar cor: ' + alt.campo + ' para ' + alt.cor;
          if (alt.tipo === 'imagem') return 'Trocar imagem: ' + alt.descricao;
          return 'Observação: ' + alt.texto;
        });
        return 'DOBRA ' + r.dobraNumero + ':\n' + linhas.join('\n');
      }).join('\n\n');

      const parsed = typeof s.jsonData === 'string' ? JSON.parse(s.jsonData) : s.jsonData;
      const texts = s.textos.length > 0 ? s.textos : extractElementorTexts(parsed);

      const textSummary = texts.map((t, i) => '[' + i + '] [' + t.wt + '] "' + t.text.substring(0, 80) + '"').join('\n');

      const sys = 'Voce aplica revisoes de clientes em textos de landing pages.\n' +
        'Responda APENAS em JSON: {"aplicacoes":[{"indice":0,"textoNovo":"texto","motivo":"o que o cliente pediu"}],"pendencias":[{"tipo":"cor|imagem|outro","descricao":"o que fazer","detalhe":"valor especifico"}]}';

      const userMsg = 'CLIENTE: ' + s.clienteNome + '\n\n' +
        'REVISOES DO CLIENTE:\n' + resumoRevisoes +
        '\n\nTEXTOS NA PAGINA (indices 0 a ' + (texts.length - 1) + '):\n' + textSummary +
        '\n\nPara cada revisao de texto, encontre o indice correto e retorne o texto novo. Para cores, imagens e outros, coloque nas pendencias.';

      const response = await callClaude(sys, userMsg);
      let resultado = { aplicacoes: [], pendencias: [] };
      try { resultado = JSON.parse(cleanJson(response)); } catch(e) {}

      // Aplicar textos
      const copies = texts.map(t => t.text);
      (resultado.aplicacoes || []).forEach(ap => {
        if (ap.indice >= 0 && ap.indice < texts.length && ap.textoNovo) {
          copies[ap.indice] = ap.textoNovo;
        }
      });

      const { adapted, count } = applyTexts(parsed, texts, copies);
      s.status = 'aplicado';

      // Gerar relatório de pendências em texto legível
      const relatorio = (resultado.pendencias || []).map((p, i) => {
        const emoji = p.tipo === 'cor' ? '🎨' : p.tipo === 'imagem' ? '🖼️' : '⚙️';
        return (i + 1) + '. ' + emoji + ' [' + (p.tipo || 'manual').toUpperCase() + '] ' + p.descricao + (p.detalhe ? '\n   → ' + p.detalhe : '');
      }).join('\n');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        aplicados: count,
        pendencias: resultado.pendencias || [],
        relatorio,
        json: adapted
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }


  // Screenshot de uma URL via miniatura
  if (req.method === 'GET' && pathname === '/api/screenshot') {
    try {
      const pageUrl = url.searchParams.get('url');
      const scroll = parseInt(url.searchParams.get('scroll') || '0');
      if (!pageUrl) throw new Error('URL obrigatória');

      // Usar API gratuita do Google PageSpeed para obter screenshot
      const apiUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' + encodeURIComponent(pageUrl) + '&strategy=mobile&category=performance';

      let screenshotData = null;
      try {
        const psRes = await fetchUrl(apiUrl);
        const psJson = JSON.parse(psRes);
        const screenshot = psJson?.lighthouseResult?.audits?.['final-screenshot']?.details?.data;
        if (screenshot) {
          screenshotData = screenshot; // data URL base64
        }
      } catch(e) {}

      if (screenshotData) {
        // Converter data URL para buffer e enviar
        const base64 = screenshotData.replace(/^data:image\/[^;]+;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
        res.end(buf);
      } else {
        // Fallback: redirecionar para serviço de miniatura
        const thumbUrl = 'https://api.microlink.io/screenshot?url=' + encodeURIComponent(pageUrl) + '&type=jpeg&quality=80&viewport.width=1280&viewport.height=800&waitFor=2000';
        res.writeHead(302, { 'Location': thumbUrl });
        res.end();
      }
    } catch(e) {
      res.writeHead(302, { 'Location': 'https://via.placeholder.com/800x400/f0f0f8/9090a8?text=Visualização+indisponível' });
      res.end();
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('ElevateLP Revisoes porta ' + PORT));
