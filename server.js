// Uso: node server.js (Node 18+)
const http = require('http');

const MARKETS = [
  "2857c51e-ffc9-4365-b39a-0156cfc032b9", "14ae828b-491f-42fc-8247-5089f6613750",
  "78b01f0d-8954-495a-a4c0-817618f41eb2", "966edfff-4c07-4d7c-a73b-38dfca4e224e",
  "e0eb5184-8da4-43da-9632-aa3a8c1bde79", "4d2a874d-ba7f-4f7e-bc1b-31ac43e80226",
  "aecc010b-a588-4fcb-8b1d-1a22062aea67", "6927aeda-cbd2-4ac4-b858-7e0b5bba0da8",
  "8c890986-ad2c-4463-b4ea-9953121a855a"
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const TIMEOUT_MS = 8000; // 8 segundos de limite para as requisições externas

// ---- Configuração de cache / rate limit ----
const CACHE_TTL_MS = 5 * 60 * 1000;      // buscas normais: 5 min
const DEFAULT_TTL_MS = 30 * 60 * 1000;   // term vazio (produtos padrão): 30 min
const CACHE_MAX_ENTRIES = 500;           // evita crescer memória sem limite
const MAX_TERM_LENGTH = 100;
const RATE_LIMIT = 60;                   // requisições por IP...
const RATE_WINDOW_MS = 60 * 1000;        // ...por minuto

/**
 * Utilitário de fetch com Timeout automático usando AbortController
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function atacadao(term) {
  const variables = {
    first: 20,
    after: "0",
    sort: "score_desc",
    term,
    selectedFacets: [
      { key: "region-id", value: "U1cjYXRhY2FkYW9icjc0Nw==" },
      { key: "channel", value: JSON.stringify({ salesChannel: "1", seller: "atacadaobr747", regionId: "U1cjYXRhY2FkYW9icjc0Nw==" }) },
      { key: "locale", value: "pt-BR" }
    ]
  };
  
  const url = `https://www.atacadao.com.br/api/graphql?operationName=ProductsQuery&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  
  return fetchWithTimeout(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "*/*",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Referer": `https://www.atacadao.com.br/s?q=${encodeURIComponent(term)}`
    }
  });
}

async function mateus(term) {
  const facetFilters = JSON.stringify([
    MARKETS.map(m => `market_id:${m}`),
    ["for_sale:true"]
  ]);

  const params = `page=0&hitsPerPage=20&clickAnalytics=true&facetFilters=${encodeURIComponent(facetFilters)}&query=${encodeURIComponent(term)}`;

  return fetchWithTimeout("https://app.mateusmais.com.br/api/products/internal/v1/service/priority", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Origin": "https://mateusmais.com.br",
      "Referer": "https://mateusmais.com.br/"
    },
    body: JSON.stringify({
      facets: ["specification.*", "brand", "nodes"],
      params,
      index: "SHOWCASE_catalog_product_api_index_PROD_total_quantity_sold_desc",
      service: "meilisearch",
      market_priority: { market_ids: MARKETS }
    })
  });
}

// ---- Cache em memória + deduplicação de requisições em andamento ----
const cache = new Map();    // key -> { expires, status, body }
const inflight = new Map(); // key -> Promise<{ status, body, cacheable }>

function cacheSet(key, status, body, ttl) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value); // remove a entrada mais antiga
  }
  cache.set(key, { expires: Date.now() + ttl, status, body });
}

async function fetchUpstream(route, term) {
  const r = await (route === "atacadao" ? atacadao(term) : mateus(term));
  const text = await r.text();

  // Validação de tipo de conteúdo para prevenir envio de HTML bruto (ex: Cloudflare 403) como JSON
  const contentType = r.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return {
      status: 502,
      body: JSON.stringify({
        error: "A API de origem retornou uma resposta inválida (não-JSON/HTML).",
        status: r.status
      }),
      cacheable: false
    };
  }

  // Só cacheia respostas de sucesso
  return { status: r.status, body: text, cacheable: r.status === 200 };
}

/**
 * Retorna { status, body, hit }. Usa cache; se já existe uma busca igual em
 * andamento, reaproveita a mesma Promise em vez de chamar a origem de novo.
 */
async function getData(route, term) {
  const key = `${route}:${term.toLowerCase()}`;

  const cached = cache.get(key);
  if (cached) {
    if (cached.expires > Date.now()) return { status: cached.status, body: cached.body, hit: true };
    cache.delete(key);
  }

  let promise = inflight.get(key);
  if (!promise) {
    const ttl = term === "" ? DEFAULT_TTL_MS : CACHE_TTL_MS;
    promise = fetchUpstream(route, term)
      .then(result => {
        if (result.cacheable) cacheSet(key, result.status, result.body, ttl);
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
  }

  const result = await promise;
  return { status: result.status, body: result.body, hit: false };
}

// ---- Rate limit por IP (janela fixa) ----
const hits = new Map(); // ip -> { count, reset }

function getIp(req) {
  // Atrás de proxy de hospedagem (Render, Railway...) o IP real vem no x-forwarded-for
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Retorna 0 se liberado, ou quantos segundos faltam para liberar
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return 0;
  }
  entry.count++;
  return entry.count > RATE_LIMIT ? Math.ceil((entry.reset - now) / 1000) : 0;
}

// Limpa IPs antigos para o Map não crescer indefinidamente
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (now > entry.reset) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

// Servidor HTTP
const server = http.createServer(async (req, res) => {
  // Headers CORS para liberação no frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Trata requisições Preflight do navegador
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // Health check (fora do rate limit)
    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", uptime: Math.round(process.uptime()) }));
    }

    if (u.pathname === "/api/atacadao" || u.pathname === "/api/mateus") {
      const retryAfter = checkRateLimit(getIp(req));
      if (retryAfter > 0) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
        return res.end(JSON.stringify({ error: "Muitas requisições. Tente novamente em instantes." }));
      }

      // term vazio é válido: retorna os produtos padrão (cacheados por mais tempo)
      const term = (u.searchParams.get("term") || "").trim().slice(0, MAX_TERM_LENGTH);
      const route = u.pathname === "/api/atacadao" ? "atacadao" : "mateus";

      const { status, body, hit } = await getData(route, term);

      res.writeHead(status, { "Content-Type": "application/json", "X-Cache": hit ? "HIT" : "MISS" });
      return res.end(body);
    }

    // Rota 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Rota não encontrada" }));

  } catch (e) {
    const isTimeout = e.name === 'AbortError';
    res.writeHead(isTimeout ? 504 : 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      error: isTimeout ? "Tempo limite excedido ao consultar o mercado (Timeout)." : String(e.message || e)
    }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});