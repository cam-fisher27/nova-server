#!/usr/bin/env node
/**
 * ClinicOS Server v3 — Multi-tenant
 *
 * Environment variables (set in Railway):
 *   CLOUDRX_CLIENT_ID       — your master CloudRx client ID
 *   CLOUDRX_CLIENT_SECRET   — your master CloudRx secret
 *   CLOUDRX_ENV             — sandbox | production
 *   SUPABASE_URL            — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY    — service_role key (from Supabase Settings > API)
 *   PORT                    — auto-set by Railway
 *   ALLOWED_ORIGINS         — * or comma-separated domains
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

const C = {
  CLOUDRX_CLIENT_ID:     process.env.CLOUDRX_CLIENT_ID     || '',
  CLOUDRX_CLIENT_SECRET: process.env.CLOUDRX_CLIENT_SECRET || '',
  CLOUDRX_ENV:           process.env.CLOUDRX_ENV           || 'sandbox',
  SUPABASE_URL:          process.env.SUPABASE_URL          || '',
  SUPABASE_SERVICE_KEY:  process.env.SUPABASE_SERVICE_KEY  || '',
  PORT:                  parseInt(process.env.PORT)        || 3131,
  ALLOWED_ORIGINS:       process.env.ALLOWED_ORIGINS       || '*',
};

const CLOUDRX = {
  sandbox:    { order: 'sandbox-orderservice.cloudrx.co.uk', identity: 'sandbox-is4.cloudrx.co.uk' },
  production: { order: 'orderservice.cloudrx.co.uk',         identity: 'is4.cloudrx.co.uk' },
};

// ── CloudRx master token cache ───────────────────────────
let masterToken = null, masterTokenExpiry = 0;

async function getMasterToken() {
  if (masterToken && Date.now() < masterTokenExpiry) return masterToken;
  const host = CLOUDRX[C.CLOUDRX_ENV].identity;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: C.CLOUDRX_CLIENT_ID,
    client_secret: C.CLOUDRX_CLIENT_SECRET,
    scope: 'cloudrx_orderservice cloudrx_productservice cloudrx_courierservice',
  }).toString();
  const raw = await httpsStr({
    hostname: host, port: 443, path: '/connect/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  const d = JSON.parse(raw);
  if (!d.access_token) throw new Error('CloudRx auth failed: ' + raw);
  masterToken = d.access_token;
  masterTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  console.log('[Auth] CloudRx token refreshed');
  return masterToken;
}

// ── Supabase ─────────────────────────────────────────────
async function supa(method, path, query = '', body = null) {
  if (!C.SUPABASE_URL) throw new Error('Supabase not configured');
  const u = new URL(C.SUPABASE_URL);
  const p = `/rest/v1/${path}${query ? '?' + query : ''}`;
  const b = body ? JSON.stringify(body) : '';
  const raw = await httpsStr({
    hostname: u.hostname, port: 443, path: p, method,
    headers: {
      'apikey': C.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + C.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': (method === 'POST' || method === 'PATCH') ? 'return=representation' : '',
      'Content-Length': Buffer.byteLength(b),
    }
  }, b);
  try { return JSON.parse(raw); } catch { return raw; }
}

// Validate a Supabase JWT and return the user's clinic info
async function getClinicFromJWT(jwt) {
  if (!jwt) throw new Error('No token');
  const u = new URL(C.SUPABASE_URL);
  const raw = await httpsStr({
    hostname: u.hostname, port: 443, path: '/auth/v1/user', method: 'GET',
    headers: { 'apikey': C.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + jwt }
  });
  const user = JSON.parse(raw);
  if (!user.id) throw new Error('Invalid token');

  // Get user's clinic
  const rows = await supa('GET', 'clinic_users', `id=eq.${user.id}&select=clinic_id,role,first_name,last_name,reg_number`);
  if (!rows || !rows[0]) throw new Error('User not found');
  const cu = rows[0];

  const clinics = await supa('GET', 'clinics', `id=eq.${cu.clinic_id}`);
  if (!clinics || !clinics[0]) throw new Error('Clinic not found');

  return { user, clinicUser: cu, clinic: clinics[0] };
}

// ── HTTPS helpers ────────────────────────────────────────
function httpsStr(opts, body = '') {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsRaw(opts, bodyBuf) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

function readBody(req) {
  return new Promise(r => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
}

// ── CORS ─────────────────────────────────────────────────
function cors(origin) {
  const allow = C.ALLOWED_ORIGINS === '*' ? '*' : (C.ALLOWED_ORIGINS.split(',').map(s=>s.trim()).includes(origin) ? origin : '*');
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '86400' };
}

function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(data));
}

function logReq(method, path, status) {
  const t = new Date().toISOString().split('T')[1].slice(0,8);
  const c = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
  console.log(`[${t}] ${c}${status}\x1b[0m ${method} ${path}`);
}

// ── Server ───────────────────────────────────────────────
const ALLOWED_TABLES = ['patients','appointments','consultations','prescriptions','invoices','clinic_users','clinics'];

const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'] || '';
  const ch = cors(origin);

  if (req.method === 'OPTIONS') { res.writeHead(204, ch); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const method = req.method;

  // ── Public endpoints ──────────────────────────────────
  if (path === '/health') {
    json(res, 200, { status: 'ok', env: C.CLOUDRX_ENV, ts: new Date().toISOString() }, ch);
    logReq(method, path, 200); return;
  }

  // ── Auth required below this point ────────────────────
  const authHeader = req.headers['authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // ── CloudRx proxy ─────────────────────────────────────
  // POST/PUT to CloudRx — injects clinic info from DB automatically
  if (path.startsWith('/cloudrx/')) {
    const body = await readBody(req);
    try {
      const { clinic } = await getClinicFromJWT(jwt);
      const token = await getMasterToken();
      const host = CLOUDRX[C.CLOUDRX_ENV].order;
      // Strip /cloudrx prefix, keep /api/v2/...
      const targetPath = path.replace('/cloudrx', '') + (parsed.search || '');

      // For order creation, inject clinic info from DB
      let reqBody = body;
      if (path.includes('/Order/create') && body.length > 0) {
        try {
          const payload = JSON.parse(body.toString());
          // Always inject clinic info from DB — clinic never needs to configure this
          payload.clinicInformation = {
            clinicCode:     clinic.clinic_code,
            name:           clinic.name,
            address1:       clinic.addr1 || null,
            address2:       clinic.addr2 || null,
            postcode:       clinic.postcode || null,
            countryCode:    clinic.country || 'GBR',
            contactEmail:   clinic.contact_email || null,
            contactNumber:  clinic.contact_tel || null,
          };
          reqBody = Buffer.from(JSON.stringify(payload));

          // Mark clinic as registered in CloudRx after first successful Rx
          if (!clinic.cloudrx_registered) {
            // Will update after successful response below
          }
        } catch(e) { /* not JSON, pass through */ }
      }

      const result = await httpsRaw({
        hostname: host, port: 443, path: targetPath, method,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Content-Length': reqBody.length,
        }
      }, reqBody);

      // On first successful order creation, mark clinic as registered
      if (path.includes('/Order/create') && result.status === 200 && !clinic.cloudrx_registered) {
        supa('PATCH', 'clinics', `id=eq.${clinic.id}`, { cloudrx_registered: true }).catch(() => {});
        console.log(`[CloudRx] Clinic ${clinic.clinic_code} registered in CloudRx`);
      }

      res.writeHead(result.status, { ...ch, 'Content-Type': result.headers['content-type'] || 'application/json' });
      res.end(result.body);
      logReq(method, path, result.status);
    } catch(e) {
      console.error('[CloudRx]', e.message);
      json(res, e.message === 'No token' || e.message === 'Invalid token' ? 401 : 502, { error: e.message }, ch);
    }
    return;
  }

  // ── Database proxy ────────────────────────────────────
  // /db/<table>[/<id>] — automatically scoped to user's clinic
  const dbMatch = path.match(/^\/db\/([a-z_]+)(\/([^/]+))?$/);
  if (dbMatch) {
    const table = dbMatch[1];
    const id    = dbMatch[3];

    if (!ALLOWED_TABLES.includes(table)) {
      json(res, 400, { error: 'Unknown table' }, ch); return;
    }

    try {
      const { clinic, clinicUser } = await getClinicFromJWT(jwt);
      const clinicId = clinic.id;
      const body = await readBody(req);

      let result, status = 200;
      const needsClinicScope = !['clinics'].includes(table);
      const baseQuery = needsClinicScope ? `clinic_id=eq.${clinicId}` : `id=eq.${clinicId}`;

      if (method === 'GET' && !id) {
        // List — merge clinic scope with any additional filters from query string
        const extra = parsed.search ? parsed.search.slice(1) : '';
        const q = needsClinicScope
          ? (extra ? `${baseQuery}&${extra}` : `${baseQuery}&order=created_at.desc`)
          : baseQuery;
        result = await supa('GET', table, q);

      } else if (method === 'GET' && id) {
        const q = needsClinicScope ? `id=eq.${id}&clinic_id=eq.${clinicId}` : `id=eq.${clinicId}`;
        const rows = await supa('GET', table, q);
        result = Array.isArray(rows) ? rows[0] : rows;

      } else if (method === 'POST') {
        const data = JSON.parse(body.toString());
        // Always stamp clinic_id on inserts (except clinics table)
        if (needsClinicScope) data.clinic_id = clinicId;
        result = await supa('POST', table, '', data);
        status = 201;

      } else if (method === 'PATCH' && id) {
        const data = JSON.parse(body.toString());
        // Prevent changing clinic_id
        delete data.clinic_id;
        const q = needsClinicScope ? `id=eq.${id}&clinic_id=eq.${clinicId}` : `id=eq.${clinicId}`;
        result = await supa('PATCH', table, q, data);

      } else if (method === 'DELETE' && id) {
        // Only admins can delete
        if (clinicUser.role !== 'admin') {
          json(res, 403, { error: 'Admin role required' }, ch); return;
        }
        const q = needsClinicScope ? `id=eq.${id}&clinic_id=eq.${clinicId}` : '';
        await supa('DELETE', table, q);
        result = { deleted: true };

      } else {
        json(res, 405, { error: 'Method not allowed' }, ch); return;
      }

      json(res, status, result, ch);
      logReq(method, path, status);

    } catch(e) {
      const isAuth = e.message === 'No token' || e.message === 'Invalid token' || e.message === 'User not found';
      console.error('[DB]', e.message);
      json(res, isAuth ? 401 : 500, { error: e.message }, ch);
    }
    return;
  }

  // ── POST /invite ──────────────────────────────────────────────────────────
  // Sends a Supabase magic-link invite email via the admin API.
  if (method === 'POST' && path === '/invite') {
    try {
      const jwt = (req.headers['authorization']||'').replace('Bearer ','');
      if (!jwt) { json(res, 401, { error: 'No token' }, ch); return; }
      await validateJwt(jwt); // throws if invalid

      const body = await getBody(req);
      const { email, role, firstName, lastName } = JSON.parse(body);
      if (!email) { json(res, 400, { error: 'email required' }, ch); return; }

      // Supabase Admin invite — sends a real email with magic link
      const inviteRes = await fetch(`${C.SUPABASE_URL}/auth/v1/invite`, {
        method: 'POST',
        headers: {
          'apikey': C.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${C.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          data: { role: role||'practitioner', first_name: firstName||'', last_name: lastName||'', invited: true }
        }),
      });

      const inviteData = await inviteRes.json();
      if (!inviteRes.ok) {
        const msg = inviteData.msg || inviteData.error_description || inviteData.error || 'Invite failed';
        json(res, inviteRes.status, { error: msg }, ch);
        return;
      }

      json(res, 200, { ok: true, userId: inviteData.id }, ch);
      logReq(method, path, 200);
    } catch(e) {
      console.error('[INVITE]', e.message);
      json(res, 500, { error: e.message }, ch);
    }
    return;
  }

  json(res, 404, { error: 'Not found' }, ch);
  logReq(method, path, 404);
});

server.listen(C.PORT, () => {
  const okCRx  = !!(C.CLOUDRX_CLIENT_ID && C.CLOUDRX_CLIENT_SECRET);
  const okSupa = !!(C.SUPABASE_URL && C.SUPABASE_SERVICE_KEY);
  console.log('\n\x1b[36m╔══════════════════════════════════╗');
  console.log('║    ClinicOS Server v3             ║');
  console.log('║    Multi-tenant                   ║');
  console.log('╚══════════════════════════════════╝\x1b[0m');
  console.log(`\x1b[32m✓\x1b[0m Port:     ${C.PORT}`);
  console.log(`${okCRx  ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m CloudRx:  ${okCRx  ? C.CLOUDRX_ENV.toUpperCase() : 'NOT SET'}`);
  console.log(`${okSupa ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m Supabase: ${okSupa ? C.SUPABASE_URL : 'NOT SET'}`);
  if (!okCRx || !okSupa) {
    console.log('\n\x1b[33m  Set environment variables in Railway:\x1b[0m');
    if (!okCRx)  { console.log('  CLOUDRX_CLIENT_ID, CLOUDRX_CLIENT_SECRET, CLOUDRX_ENV'); }
    if (!okSupa) { console.log('  SUPABASE_URL, SUPABASE_SERVICE_KEY'); }
  }
  console.log('');
});

server.on('error', err => { console.error('\x1b[31m' + err.message + '\x1b[0m'); process.exit(1); });
