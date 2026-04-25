#!/usr/bin/env node
const http = require('http');
const https = require('https');
const url = require('url');

const CONFIG = {
  CLOUDRX_CLIENT_ID:     process.env.CLOUDRX_CLIENT_ID     || '',
  CLOUDRX_CLIENT_SECRET: process.env.CLOUDRX_CLIENT_SECRET || '',
  CLOUDRX_CLINIC_CODE:   process.env.CLOUDRX_CLINIC_CODE   || '',
  CLOUDRX_ENV:           process.env.CLOUDRX_ENV           || 'sandbox',
  SUPABASE_URL:          process.env.SUPABASE_URL          || '',
  SUPABASE_SERVICE_KEY:  process.env.SUPABASE_SERVICE_KEY  || '',
  PORT:                  parseInt(process.env.PORT)        || 3131,
  ALLOWED_ORIGINS:       process.env.ALLOWED_ORIGINS       || '*',
};

const CLOUDRX_HOSTS = {
  sandbox:    { order: 'sandbox-orderservice.cloudrx.co.uk', identity: 'sandbox-is4.cloudrx.co.uk' },
  production: { order: 'orderservice.cloudrx.co.uk',         identity: 'is4.cloudrx.co.uk' },
};

let cachedToken = null, tokenExpiry = 0;

async function getCloudRxToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const host = CLOUDRX_HOSTS[CONFIG.CLOUDRX_ENV].identity;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CONFIG.CLOUDRX_CLIENT_ID, client_secret: CONFIG.CLOUDRX_CLIENT_SECRET, scope: 'cloudrx_orderservice cloudrx_productservice cloudrx_courierservice' }).toString();
  const raw = await httpsReq({ hostname: host, port: 443, path: '/connect/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
  const data = JSON.parse(raw);
  if (!data.access_token) throw new Error('CloudRx auth failed: ' + raw);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[Auth] CloudRx token refreshed');
  return cachedToken;
}

function httpsReq(opts, body = '') {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsReqRaw(opts, bodyBuf) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

async function supabase(method, table, query = '', body = null) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_SERVICE_KEY) throw new Error('Supabase not configured');
  const supaUrl = new URL(CONFIG.SUPABASE_URL);
  const path = `/rest/v1/${table}${query ? '?' + query : ''}`;
  const bodyStr = body ? JSON.stringify(body) : '';
  const prefer = method === 'POST' || method === 'PATCH' ? 'return=representation' : '';
  const raw = await httpsReq({
    hostname: supaUrl.hostname, port: 443, path, method,
    headers: { 'apikey': CONFIG.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': prefer, 'Content-Length': Buffer.byteLength(bodyStr) }
  }, bodyStr);
  try { return JSON.parse(raw); } catch { return raw; }
}

function corsHeaders(origin) {
  const allowed = CONFIG.ALLOWED_ORIGINS;
  const allow = allowed === '*' ? '*' : (allowed.split(',').map(s => s.trim()).includes(origin) ? origin : '*');
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
}

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
}

function logReq(method, path, status) {
  const t = new Date().toISOString().split('T')[1].split('.')[0];
  const c = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
  console.log(`[${t}] ${c}${status}\x1b[0m ${method} ${path}`);
}

const ALLOWED_TABLES = ['patients','appointments','consultations','prescriptions','invoices','practitioners'];

const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'] || '';
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const method = req.method;

  // Health
  if (path === '/health') {
    json(res, 200, { status: 'ok', env: CONFIG.CLOUDRX_ENV, ts: new Date().toISOString() }, cors);
    logReq(method, path, 200); return;
  }

  // Config (non-sensitive info for frontend)
  if (path === '/config') {
    json(res, 200, {
      env: CONFIG.CLOUDRX_ENV,
      clinicCode: CONFIG.CLOUDRX_CLINIC_CODE,
      hasCredentials: !!(CONFIG.CLOUDRX_CLIENT_ID && CONFIG.CLOUDRX_CLIENT_SECRET),
      hasSupabase: !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_SERVICE_KEY),
    }, cors);
    logReq(method, path, 200); return;
  }

  // CloudRx proxy — /api/v2/...
  if (path.startsWith('/api/')) {
    const body = await readBody(req);
    try {
      const token = await getCloudRxToken();
      const host = CLOUDRX_HOSTS[CONFIG.CLOUDRX_ENV].order;
      const targetPath = path + (parsed.search || '');
      const result = await httpsReqRaw({
        hostname: host, port: 443, path: targetPath, method,
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': req.headers['content-type'] || 'application/json', 'Content-Length': body.length }
      }, body.length > 0 ? body : undefined);
      res.writeHead(result.status, { ...cors, 'Content-Type': result.headers['content-type'] || 'application/json' });
      res.end(result.body);
      logReq(method, path, result.status);
    } catch (e) {
      console.error('[CloudRx Error]', e.message);
      json(res, 502, { error: 'CloudRx error: ' + e.message }, cors);
    }
    return;
  }

  // Supabase CRUD — /db/<table>[/<id>]
  const dbMatch = path.match(/^\/db\/([a-z_]+)(\/([^/]+))?$/);
  if (dbMatch) {
    const table = dbMatch[1], id = dbMatch[3];
    if (!ALLOWED_TABLES.includes(table)) { json(res, 400, { error: 'Unknown table' }, cors); return; }
    try {
      const body = await readBody(req);
      let result, status = 200;
      if (method === 'GET' && !id) {
        const q = parsed.search ? parsed.search.slice(1) : 'order=created_at.desc';
        result = await supabase('GET', table, q);
      } else if (method === 'GET' && id) {
        const arr = await supabase('GET', table, `id=eq.${id}`);
        result = Array.isArray(arr) ? arr[0] : arr;
      } else if (method === 'POST') {
        result = await supabase('POST', table, '', JSON.parse(body.toString())); status = 201;
      } else if (method === 'PATCH' && id) {
        result = await supabase('PATCH', table, `id=eq.${id}`, JSON.parse(body.toString()));
      } else if (method === 'DELETE' && id) {
        await supabase('DELETE', table, `id=eq.${id}`); result = { deleted: true };
      } else { json(res, 405, { error: 'Method not allowed' }, cors); return; }
      json(res, status, result, cors);
      logReq(method, path, status);
    } catch (e) {
      console.error('[Supabase Error]', e.message);
      json(res, 500, { error: 'Database error: ' + e.message }, cors);
    }
    return;
  }

  json(res, 404, { error: 'Not found' }, cors);
  logReq(method, path, 404);
});

server.listen(CONFIG.PORT, () => {
  const okCRx = !!(CONFIG.CLOUDRX_CLIENT_ID && CONFIG.CLOUDRX_CLIENT_SECRET);
  const okSupa = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_SERVICE_KEY);
  console.log('\n\x1b[36m╔══════════════════════════╗');
  console.log('║   ClinicOS Server v2     ║');
  console.log('╚══════════════════════════╝\x1b[0m');
  console.log(`\x1b[32m✓\x1b[0m Port      : ${CONFIG.PORT}`);
  console.log(`${okCRx?'\x1b[32m✓':'\x1b[31m✗'}\x1b[0m CloudRx   : ${okCRx ? CONFIG.CLOUDRX_ENV.toUpperCase() : 'NOT SET'}`);
  console.log(`${okSupa?'\x1b[32m✓':'\x1b[31m✗'}\x1b[0m Supabase  : ${okSupa ? CONFIG.SUPABASE_URL : 'NOT SET'}`);
  if (!okCRx || !okSupa) { console.log('\n\x1b[33m  Missing env vars — see README\x1b[0m'); }
  console.log('');
});

server.on('error', err => { console.error('\x1b[31mError:\x1b[0m', err.message); process.exit(1); });
