// Diagnostic: does SentWA's send.php accept document/media sends, and if
// so, what parameter name does it expect? Tries several real, live calls
// against the same endpoint the app already uses successfully for text,
// each with a different candidate document-parameter convention, and
// reports SentWA's actual raw response for each — no guessing after this.
//
// Usage: fill in SENTWA_INSTANCE_ID / SENTWA_ACCESS_TOKEN in .env, then:
//   node test-sentwa-document.js
//
// Sends to your OWN number only (reads TEST_NUMBER below or prompts via
// the instance's linked number) — no patient data is touched.

const fs = require('fs');
const path = require('path');

// Minimal .env loader (matches server.js's own approach — no dependency).
try {
  const envPath = path.join(__dirname, '.env');
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
} catch (e) { /* .env optional */ }

const INSTANCE_ID = process.env.SENTWA_INSTANCE_ID || '';
const ACCESS_TOKEN = process.env.SENTWA_ACCESS_TOKEN || '';
const TEST_NUMBER = process.env.TEST_NUMBER || ''; // e.g. 27821234567 — digits only, international format

// A small, public, well-known dummy PDF — safe to reference in a live test.
const TEST_PDF_URL = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';

if (!INSTANCE_ID || !ACCESS_TOKEN) {
  console.error('✗ Set SENTWA_INSTANCE_ID and SENTWA_ACCESS_TOKEN in sentwa-proxy/.env first, then re-run.');
  process.exit(1);
}
if (!TEST_NUMBER) {
  console.error('✗ Set TEST_NUMBER=<your WhatsApp number, digits only e.g. 27821234567> in .env or as an env var, then re-run.');
  process.exit(1);
}

// Candidate payload conventions, most-likely-first based on common
// WhatsApp-gateway API shapes (Wablas/Fonnte/UltraMsg/GreenAPI-style
// resellers commonly used across this market segment).
const candidates = [
  { label: 'type=document + url= + caption=',        extra: { type: 'document', url: TEST_PDF_URL, caption: 'SmartCare AI test document', filename: 'test.pdf' } },
  { label: 'type=document + media_url=',              extra: { type: 'document', media_url: TEST_PDF_URL, caption: 'SmartCare AI test document' } },
  { label: 'type=media + media=',                      extra: { type: 'media', media: TEST_PDF_URL, caption: 'SmartCare AI test document' } },
  { label: 'type=file + document=',                    extra: { type: 'file', document: TEST_PDF_URL, caption: 'SmartCare AI test document' } },
  { label: 'type=image + url= (as a control/baseline)',extra: { type: 'image', url: TEST_PDF_URL, caption: 'SmartCare AI test document' } },
];

async function trySend(label, extra) {
  const params = new URLSearchParams({
    number: TEST_NUMBER,
    message: 'SmartCare AI document-send diagnostic',
    instance_id: INSTANCE_ID,
    access_token: ACCESS_TOKEN,
    ...extra
  });
  const target = `https://new.sentwa.com/api/send.php?${params.toString()}`;
  try {
    const res = await fetch(target, { method: 'GET' });
    const text = await res.text();
    console.log(`\n── ${label} ──`);
    console.log(`HTTP ${res.status}`);
    console.log(text.slice(0, 500));
  } catch (e) {
    console.log(`\n── ${label} ──`);
    console.log('Request failed:', e.message);
  }
}

(async () => {
  console.log(`Testing ${candidates.length} document-send conventions against SentWA's live API...`);
  console.log(`Target number: ${TEST_NUMBER.replace(/^(\d{4}).*(\d{2})$/, '$1***$2')} (your own — safe to check your WhatsApp after this runs)\n`);
  for (const c of candidates) {
    await trySend(c.label, c.extra);
    await new Promise(r => setTimeout(r, 1500)); // avoid rate-limiting
  }
  console.log('\nDone. Check your WhatsApp for any of these arriving as an actual document — that tells us which (if any) convention SentWA honors. Also check each raw response above for an explicit error message (e.g. "invalid type", "unsupported parameter").');
})();
