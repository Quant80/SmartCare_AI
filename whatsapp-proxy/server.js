// SmartCare AI — WhatsApp (SentWA) delivery proxy, production version.
//
// Why this exists as its own small server, separate from
// sentwa-proxy/server.js: that file also carries a legacy OAuth/login
// system (dead — nothing in the app calls it anymore) and a SQLite
// dependency tied to it, plus a local-only Phi-3/Ollama LLM proxy that
// can never be "deployed" in a general sense (it forwards to Ollama
// running on that SAME machine — every user would need their own local
// Ollama install regardless of where any proxy lives). Neither belongs
// in a public deployment. This file is only the part that genuinely
// needs to be a real, always-on public server: relaying WhatsApp sends
// to SentWA's API, which the browser can't call directly (CORS).
//
// No SentWA credentials live here — instance_id/access_token are sent
// per-request by the client (from Settings > WhatsApp Configuration),
// exactly as the local dev version already worked. This server has
// nothing secret to configure; it's a pure relay.
//
// Zero npm dependencies — only Node built-ins (http, plus native
// fetch/FormData/Blob, available in Node 18+), so there's nothing to
// `npm install` and nothing that needs native compilation on deploy.
//
// IMPORTANT — requires NODE_EXTRA_CA_CERTS to be set (see sentwa-ca-
// bundle.pem, package.json's start script also passes --use-system-ca
// as a second line of defense): new.sentwa.com's server sends only its
// leaf certificate, not the full chain — it's missing the Let's Encrypt
// "YR1" intermediate. Confirmed live: this made outbound fetch() calls
// fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE on a fresh Linux container
// (Railway) even though the exact same code worked fine on Windows,
// where the OS transparently fetches missing intermediates via AIA — a
// Windows-only behavior Node's TLS stack doesn't replicate. Without
// NODE_EXTRA_CA_CERTS pointing at sentwa-ca-bundle.pem (the missing YR1
// intermediate + its own issuer, "ISRG Root YR", which is itself
// cross-signed by the already-universally-trusted "ISRG Root X1"),
// every WhatsApp send here will fail on a fresh deployment with no
// clear indication why beyond a generic "fetch failed".

const http = require('http');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

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
// PDF HOSTING FOR WHATSAPP DOCUMENT SENDS
// Two independent anonymous, no-account, auto-expiring hosts. Neither is
// SLA-backed — tries both in true parallel (Promise.any — resolves the
// instant the first one succeeds, doesn't wait for a slower loser to
// also finish) so a single flaky third party can't take down PDF
// delivery, and a hanging one can't stack its full timeout on top of a
// fast one that already worked.
// ═══════════════════════════════════════════════════════
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function uploadToLitterbox(pdfBuffer, fileName) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '1h');
  form.append('fileToUpload', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  const res = await fetchWithTimeout('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form }, 12000);
  const url = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(url)) throw new Error(`unexpected response (HTTP ${res.status}): ${url.slice(0, 200)}`);
  return url;
}

async function uploadToTmpfiles(pdfBuffer, fileName) {
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  const res = await fetchWithTimeout('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form }, 12000);
  const json = await res.json().catch(() => null);
  const landingUrl = json?.data?.url;
  if (!res.ok || !landingUrl) throw new Error(`unexpected response (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  // tmpfiles.org's returned URL is an HTML landing page, not the raw file —
  // the actual direct-download link (with a timestamp.hash segment) has to
  // be pulled out of that page's markup.
  const landingRes = await fetchWithTimeout(landingUrl, {}, 8000);
  const landingHtml = await landingRes.text();
  const match = landingHtml.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+)"/i);
  if (!match) throw new Error('could not find a direct download link on the tmpfiles.org landing page');
  return match[1];
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
    sendJson(res, 200, { ok: true, service: 'whatsapp-proxy', status: 'healthy', port: PORT });
    return;
  }

  // ═══ WHATSAPP DOCUMENT SEND (real PDF attachments — invoices, discharge
  // summaries, ID cards, etc.) ═══
  // Two-step process, both server-side so the browser never needs direct
  // CORS access to a third-party file host: (1) upload the PDF bytes the
  // client already generated to a short-lived public host so SentWA's
  // servers can fetch it, (2) call SentWA with type=document + that URL.
  // Confirmed against SentWA's live API: the correct parameter is
  // media_url (not url/media/document — those silently fall back to a
  // plain text send), and filename= controls the name WhatsApp displays
  // (otherwise it uses the host's random file id).
  if (req.method === 'POST' && req.url === '/api/sentwa/send-document') {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');

      const number = String(payload.number || '').replace(/\D/g, '');
      const instanceId = String(payload.instance_id || '');
      const accessToken = String(payload.access_token || '');
      const pdfBase64 = String(payload.pdfBase64 || '');
      const fileName = String(payload.fileName || 'SmartCare-Document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
      const caption = String(payload.caption || '');

      if (!number || !instanceId || !accessToken || !pdfBase64) {
        sendJson(res, 400, { ok: false, error: 'Missing required fields: number, instance_id, access_token, pdfBase64' });
        return;
      }

      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      if (pdfBuffer.length === 0) {
        sendJson(res, 400, { ok: false, error: 'pdfBase64 decoded to an empty file' });
        return;
      }

      const providers = [uploadToLitterbox, uploadToTmpfiles];
      const attempts = providers.map(provider => provider(pdfBuffer, fileName).then(url => ({ provider: provider.name, url })));
      attempts.forEach((p, i) => p.catch(e => console.log(`[whatsapp-proxy] PDF upload attempt failed — ${providers[i].name}: ${e.message}`)));

      let winner = null, uploadErrors = [];
      try {
        winner = await Promise.any(attempts);
      } catch (aggErr) {
        uploadErrors = (aggErr.errors || []).map((e, i) => `${providers[i].name}: ${e.message}`);
      }
      const uploadedUrl = winner?.url || null;
      if (uploadedUrl) console.log(`[whatsapp-proxy] Uploaded PDF via ${winner.provider}: ${uploadedUrl}`);
      if (!uploadedUrl) {
        sendJson(res, 502, { ok: false, error: 'PDF upload failed on all providers', detail: uploadErrors.join(' | ') });
        return;
      }

      const params = new URLSearchParams({
        number,
        type: 'document',
        media_url: uploadedUrl,
        filename: fileName,
        caption,
        message: caption,
        instance_id: instanceId,
        access_token: accessToken
      });
      const target = `https://new.sentwa.com/api/send.php?${params.toString()}`;
      const upstream = await fetch(target, { method: 'GET' });
      const text = await upstream.text();
      console.log(`[whatsapp-proxy] Document send response ${upstream.status}: ${text.slice(0, 300)}`);

      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      const delivered = json && json.status === 'success' && json.data?.message?.documentMessage;

      sendJson(res, upstream.ok ? 200 : 502, {
        ok: !!delivered,
        upstreamStatus: upstream.status,
        uploadedUrl,
        sentwa: json || text
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Unexpected proxy error during document send' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sentwa/send') {
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
      console.log(`[whatsapp-proxy] Sending to: ${target}`);
      const upstream = await fetch(target, { method: 'GET' });
      const text = await upstream.text();
      console.log(`[whatsapp-proxy] Response ${upstream.status}: ${text}`);

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
      // Log the full cause server-side (not just err.message) — this is
      // how the "new.sentwa.com sends an incomplete cert chain, missing
      // the Let's Encrypt YR1 intermediate" issue got diagnosed in the
      // first place. See sentwa-ca-bundle.pem / NODE_EXTRA_CA_CERTS.
      console.error('[whatsapp-proxy] send error:', err.message, err.cause || '');
      sendJson(res, 500, { ok: false, error: err.message || 'Unexpected proxy error' });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         SmartCare WhatsApp Proxy (production) ✓            ║
║  Port: ${PORT}                                              ║
║                                                              ║
║  • GET  /health                    - Health check           ║
║  • POST /api/sentwa/send           - WhatsApp text messages  ║
║  • POST /api/sentwa/send-document  - WhatsApp PDF documents  ║
╚════════════════════════════════════════════════════════════╝
  `);
});
