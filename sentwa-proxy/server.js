const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Load .env file (no dotenv dependency needed)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
} catch (e) { /* .env is optional */ }

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// ═══════════════════════════════════════════════════════
// GOOGLE OAUTH CONFIGURATION
// Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as environment variables,
// or create a .env file and load with: node -r dotenv/config server.js
// ═══════════════════════════════════════════════════════
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = `http://localhost:${PORT}/api/oauth/callback/google`;
// In-memory CSRF state store (auto-cleaned after 10 minutes)
const _oauthStates = new Map();

function sanitizeReturnUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  const withoutHash = trimmed.split('#')[0];
  if (withoutHash.startsWith('file:///')) return withoutHash;
  if (withoutHash.startsWith('http://localhost') || withoutHash.startsWith('https://localhost')) return withoutHash;
  return '';
}

function encodeStateReturnUrl(url) {
  if (!url) return '';
  try {
    return Buffer.from(url, 'utf8').toString('base64url');
  } catch {
    return '';
  }
}

function decodeStateReturnUrl(state) {
  try {
    if (!state || typeof state !== 'string') return '';
    const parts = state.split('.');
    if (parts.length < 2 || !parts[1]) return '';
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    return sanitizeReturnUrl(decoded);
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════════════════
// DATABASE INITIALIZATION
// ═══════════════════════════════════════════════════════
const dbPath = path.join(__dirname, 'smartcare_users.db');
let db;

function initializeDatabase() {
  try {
    db = new Database(dbPath);
    
    // Create users and sessions tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT DEFAULT 'credentials',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    
    console.log('✓ Database initialized:', dbPath);
  } catch (e) {
    console.error('Database init error:', e.message);
    db = new Database(':memory:');
    console.log('⚠ Using in-memory database');
  }
}

// Hash password with SHA-256
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'smartcare_salt_2026').digest('hex');
}

// Generate token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validatePasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must include at least 1 uppercase letter';
  }
  if (!/\d{2,}/.test(password)) {
    return 'Password must include at least 2 consecutive numbers';
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return 'Password must include at least 1 special character';
  }
  return null;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════
// AUTHENTICATION HANDLERS
// ═══════════════════════════════════════════════════════

async function handleAuthRegister(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const { email, password, name } = body;
    
    if (!email || !password || !name) {
      return sendJson(res, 400, { ok: false, error: 'Missing email, password, or name' });
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return sendJson(res, 400, { ok: false, error: 'Invalid email format' });
    }
    
    const passwordPolicyError = validatePasswordPolicy(password);
    if (passwordPolicyError) {
      return sendJson(res, 400, { ok: false, error: passwordPolicyError });
    }
    
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return sendJson(res, 409, { ok: false, error: 'Email already registered' });
    }
    
    const passwordHash = hashPassword(password);
    const stmt = db.prepare(`INSERT INTO users (email, password_hash, name, provider) VALUES (?, ?, ?, 'credentials')`);
    const info = stmt.run(email, passwordHash, name);
    
    const userId = Number(info.lastInsertRowid);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
    
    const user = { id: userId, email, name, provider: 'credentials' };
    sendJson(res, 201, { ok: true, user, token });
  } catch (e) {
    console.error('Register error:', e.message);
    sendJson(res, 500, { ok: false, error: 'Registration failed: ' + e.message });
  }
}

async function handleAuthLogin(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const { email, password } = body;
    
    if (!email || !password) {
      return sendJson(res, 400, { ok: false, error: 'Missing email or password' });
    }
    
    const user = db.prepare('SELECT id, name, email, password_hash, provider FROM users WHERE email = ?').get(email);
    
    if (!user) {
      return sendJson(res, 401, { ok: false, error: 'Invalid email or password' });
    }
    
    const passwordHash = hashPassword(password);
    if (passwordHash !== user.password_hash) {
      return sendJson(res, 401, { ok: false, error: 'Invalid email or password' });
    }
    
    const userId = Number(user.id);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
    
    const userData = { id: user.id, email: user.email, name: user.name, provider: user.provider };
    sendJson(res, 200, { ok: true, user: userData, token });
  } catch (e) {
    console.error('Login error:', e.message);
    sendJson(res, 500, { ok: false, error: 'Login failed: ' + e.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, service: 'sentwa-proxy', status: 'healthy', port: PORT });
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/app')) {
    try {
      const appPath = path.join(__dirname, '..', 'SmartCareAI_v15_final (2).html');
      const html = fs.readFileSync(appPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(html);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'Failed to load SmartCare app: ' + e.message });
    }
    return;
  }

  // ═══ AUTHENTICATION ROUTES ═══
  if (req.method === 'POST' && req.url === '/api/auth/register') {
    return handleAuthRegister(req, res);
  }
  
  if (req.method === 'POST' && req.url === '/api/auth/login') {
    return handleAuthLogin(req, res);
  }

  // Ollama / local LLM proxy — forwards to local Ollama API
  // Needed because file:// pages have null origin which Ollama blocks by default
  if (req.method === 'POST' && req.url === '/api/ollama') {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      // Prefer 127.0.0.1 to avoid occasional IPv6 localhost resolution issues on Windows.
      const ollamaBase = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
      const target = `${ollamaBase}/v1/chat/completions`;
      console.log(`[ollama-proxy] → ${target} model=${payload?.model}`);
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(180_000)   // 3-minute timeout for large clinical prompts
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end(text);
    } catch (err) {
      console.error('[ollama-proxy] Error:', err.message);
      sendJson(res, 502, { ok: false, error: `Ollama unreachable: ${err.message}` });
    }
    return;
  }

  // ═══ GOOGLE OAUTH — START (opens in popup, redirects to Google) ═══
  if (req.method === 'GET' && req.url.startsWith('/api/oauth/start/google')) {
    if (!GOOGLE_CLIENT_ID) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<script>window.opener?.postMessage({type:'oauth_error',error:'GOOGLE_CLIENT_ID not configured on proxy server'},'*');window.close();</script>`);
      return;
    }
    const startUrl = new URL(req.url, `http://localhost:${PORT}`);
    const returnUrl = sanitizeReturnUrl(startUrl.searchParams.get('returnUrl') || '');
    // Generate CSRF state token
    const stateNonce = crypto.randomBytes(16).toString('hex');
    const stateReturn = encodeStateReturnUrl(returnUrl);
    const state = stateReturn ? `${stateNonce}.${stateReturn}` : stateNonce;
    _oauthStates.set(state, { ts: Date.now(), returnUrl });
    // Clean up states older than 10 minutes
    for (const [k, entry] of _oauthStates) {
      if (Date.now() - entry.ts > 10 * 60 * 1000) _oauthStates.delete(k);
    }
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account'
    });
    res.writeHead(302, { 'Location': `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    res.end();
    return;
  }

  // ═══ GOOGLE OAUTH — CALLBACK (Google redirects here after user consent) ═══
  if (req.method === 'GET' && req.url.startsWith('/api/oauth/callback/google')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const code = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state');
    const error = urlObj.searchParams.get('error');
    const stateData = state ? _oauthStates.get(state) : null;
    const returnUrl = sanitizeReturnUrl(stateData?.returnUrl || decodeStateReturnUrl(state));

    const sendPopupResult = (html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>SmartCare Auth</title></head><body style="font-family:Segoe UI,Arial,sans-serif;padding:20px;color:#0f172a;">${html}<noscript>Authentication finished. You can close this page and return to SmartCare.</noscript></body></html>`);
    };
    const normalizeTargetUrl = (targetUrl) => {
      if (!targetUrl) return '';
      if (targetUrl.startsWith('file:///')) {
        const hashPart = targetUrl.includes('#') ? targetUrl.slice(targetUrl.indexOf('#')) : '';
        return `http://localhost:${PORT}/app${hashPart}`;
      }
      return targetUrl;
    };
    const buildReturnScript = (targetUrl) => {
      const normalizedTarget = normalizeTargetUrl(targetUrl);
      if (!normalizedTarget) return '';
      const safeTarget = JSON.stringify(normalizedTarget);
      return `try{if(window.opener&&window.opener.location){window.opener.location.replace(${safeTarget});window.close();}else{window.location.replace(${safeTarget});}}catch(e){try{window.location.replace(${safeTarget});}catch(e2){}}`;
    };
    const buildManualOpen = (targetUrl, label = 'Open SmartCare manually') => {
      const normalizedTarget = normalizeTargetUrl(targetUrl);
      if (!normalizedTarget) return '<p>You can close this page and return to SmartCare.</p>';
      const safeHref = String(normalizedTarget).replace(/"/g, '&quot;');
      return `<p>If automatic redirect does not work, click below:</p><p><a href="${safeHref}" style="display:inline-block;padding:10px 14px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;">${label}</a></p>`;
    };

    if (error) {
      const errorTarget = returnUrl ? (returnUrl + '#oauth_status=error&oauth_error=' + encodeURIComponent(error)) : '';
      const returnScript = buildReturnScript(errorTarget);
      sendPopupResult(`<script>window.opener?.postMessage({type:'oauth_error',error:${JSON.stringify(error)}},'*');${returnScript}</script><p>Google sign-in failed: ${error}</p>${buildManualOpen(errorTarget, 'Return to SmartCare')}`);
      return;
    }
    if (!code) {
      const noCodeTarget = returnUrl ? (returnUrl + '#oauth_status=error&oauth_error=' + encodeURIComponent('No authorization code received')) : '';
      const returnScript = buildReturnScript(noCodeTarget);
      sendPopupResult(`<script>window.opener?.postMessage({type:'oauth_error',error:'No authorization code received'},'*');${returnScript}</script><p>No authorization code received from Google.</p>${buildManualOpen(noCodeTarget, 'Return to SmartCare')}`);
      return;
    }
    // Validate CSRF state
    if (!state || !_oauthStates.has(state)) {
      const stateErrorTarget = returnUrl ? (returnUrl + '#oauth_status=error&oauth_error=' + encodeURIComponent('Invalid state parameter (CSRF check failed)')) : '';
      const returnScript = buildReturnScript(stateErrorTarget);
      sendPopupResult(`<script>window.opener?.postMessage({type:'oauth_error',error:'Invalid state parameter (CSRF check failed)'},'*');${returnScript}</script><p>State validation failed. Please retry sign-in.</p>${buildManualOpen(stateErrorTarget, 'Return to SmartCare')}`);
      return;
    }
    _oauthStates.delete(state);

    try {
      // Exchange authorization code for Google access token
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });
      const tokens = await tokenResp.json();
      if (!tokens.access_token) {
        const errMsg = tokens.error_description || tokens.error || 'No access token returned';
        const tokenErrorTarget = returnUrl ? (returnUrl + '#oauth_status=error&oauth_error=' + encodeURIComponent(errMsg)) : '';
        const returnScript = buildReturnScript(tokenErrorTarget);
        sendPopupResult(`<script>window.opener?.postMessage({type:'oauth_error',error:${JSON.stringify(errMsg)}},'*');${returnScript}</script><p>Google token exchange failed: ${errMsg}</p>${buildManualOpen(tokenErrorTarget, 'Return to SmartCare')}`);
        return;
      }

      // Fetch user profile from Google
      const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const profile = await profileResp.json();
      if (!profile.email) {
        const profileErr = 'Could not retrieve Google profile email';
        const profileErrorTarget = returnUrl ? (returnUrl + '#oauth_status=error&oauth_error=' + encodeURIComponent(profileErr)) : '';
        const returnScript = buildReturnScript(profileErrorTarget);
        sendPopupResult(`<script>window.opener?.postMessage({type:'oauth_error',error:${JSON.stringify(profileErr)}},'*');${returnScript}</script><p>${profileErr}</p>${buildManualOpen(profileErrorTarget, 'Return to SmartCare')}`);
        return;
      }

      // Upsert user into SQLite
      let dbUser = db.prepare('SELECT id, name, email, provider FROM users WHERE email = ?').get(profile.email);
      if (!dbUser) {
        const info = db.prepare(
          `INSERT INTO users (email, password_hash, name, provider) VALUES (?, '', ?, 'google')`
        ).run(profile.email, profile.name || profile.email);
        dbUser = { id: Number(info.lastInsertRowid), email: profile.email, name: profile.name || profile.email, provider: 'google' };
      }

      // Create a session token
      const sessionToken = generateToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?,?,?)').run(Number(dbUser.id), sessionToken, expiresAt);

      const safeUser = {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        provider: 'google',
        picture: profile.picture || '',
        role: 'Clinician'
      };

      console.log(`[google-oauth] Login: ${safeUser.email}`);
      const successHash = `#oauth_status=success&oauth_token=${encodeURIComponent(sessionToken)}&oauth_user=${encodeURIComponent(JSON.stringify(safeUser))}`;
      const successTarget = returnUrl ? (returnUrl + successHash) : '';
      const returnScript = buildReturnScript(successTarget);
      sendPopupResult(`<script>window.opener?.postMessage({type:'oauth_success',user:${JSON.stringify(safeUser)},token:${JSON.stringify(sessionToken)}},'*');${returnScript}</script><p>Authentication successful. Returning to SmartCare...</p>${buildManualOpen(successTarget, 'Open SmartCare now')}`);
    } catch (e) {
      console.error('[google-oauth] Callback error:', e.message);
      const callbackErrorTarget = returnUrl ? (returnUrl + '#oauth_status=error&oauth_error=' + encodeURIComponent(e.message)) : '';
      const returnScript = buildReturnScript(callbackErrorTarget);
      sendPopupResult(`<script>window.opener?.postMessage({type:'oauth_error',error:${JSON.stringify(e.message)}},'*');${returnScript}</script><p>Authentication failed: ${e.message}</p>${buildManualOpen(callbackErrorTarget, 'Return to SmartCare')}`);
    }
    return;
  }

  // ═══ OAUTH MOCK EXCHANGE (Microsoft / GitHub — not yet real) ═══
  if (req.method === 'POST' && req.url === '/api/oauth/exchange') {
    try {
      const raw = await readBody(req);
      const { provider, code } = JSON.parse(raw || '{}');

      if (!code || !provider) {
        sendJson(res, 400, { ok: false, error: 'Missing provider or code' });
        return;
      }

      // Mock responses for Microsoft and GitHub (Google now uses real popup flow)
      const mockUsers = {
        microsoft: {
          id: 'ms_' + Math.random().toString(36).slice(2, 9),
          name: 'Demo User (Microsoft)',
          email: 'user@outlook.com',
          picture: '',
          provider: 'microsoft',
          role: 'Clinician'
        },
        github: {
          id: 'gh_' + Math.random().toString(36).slice(2, 9),
          name: 'Demo User (GitHub)',
          email: 'user@github.com',
          picture: '',
          provider: 'github',
          role: 'Clinician'
        }
      };

      const user = mockUsers[provider];
      if (!user) {
        sendJson(res, 400, { ok: false, error: `No mock for provider: ${provider}` });
        return;
      }

      const token = generateToken();
      sendJson(res, 200, { ok: true, token, user });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/sentwa/send') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  try {
    const raw = await readBody(req);
    const payload = JSON.parse(raw || '{}');

    const number = String(payload.number || '').replace(/\D/g, '');
    const message = String(payload.message || '');
    const instanceId = String(payload.instance_id || '');
    const accessToken = String(payload.access_token || '');

    if (!number || !message || !instanceId || !accessToken) {
      sendJson(res, 400, {
        ok: false,
        error: 'Missing required fields: number, message, instance_id, access_token'
      });
      return;
    }

    const params = new URLSearchParams({
      number,
      type: 'text',
      message,
      instance_id: instanceId,
      access_token: accessToken
    });

    const target = `https://new.sentwa.com/api/send.php?${params.toString()}`;
    console.log(`[sentwa-proxy] Sending to: ${target}`);
    const upstream = await fetch(target, { method: 'GET' });
    const text = await upstream.text();
    console.log(`[sentwa-proxy] Response ${upstream.status}: ${text}`);

    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }

    const delivered =
      (json && (json.status === 'success' || json.status === true || json.success === true)) ||
      (upstream.ok && /success|sent|queued|ok/i.test(text) && !/error|fail|invalid/i.test(text));

    sendJson(res, upstream.ok ? 200 : 502, {
      ok: !!delivered,
      upstreamStatus: upstream.status,
      sentwa: json || text
    });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message || 'Unexpected proxy error' });
  }
});

server.listen(PORT, () => {
  initializeDatabase();
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         SmartCare Proxy Server v2 ✓                       ║
║  Port:  ${PORT}                                           ║
║  Database: SQLite (smartcare_users.db)                    ║
║                                                            ║
║  Authentication:                                           ║
║  • POST /api/auth/register  - Register new user            ║
║  • POST /api/auth/login     - Login with credentials       ║
║  • POST /api/oauth/exchange - OAuth provider exchange      ║
║                                                            ║
║  Services:                                                 ║
║  • POST /api/ollama         - Local Ollama LLM             ║
║  • POST /api/sentwa/send    - WhatsApp notifications       ║
╚════════════════════════════════════════════════════════════╝
  `);
});
