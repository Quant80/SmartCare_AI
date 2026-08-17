# SmartCare AI — WhatsApp delivery proxy (production)

Relays outbound WhatsApp sends from SmartCare AI to SentWA's API, since a browser can't call it directly (CORS). This is the **production** version — deployed and always-on, unlike `../sentwa-proxy/server.js` which is a local-dev-only server (also carries a dead OAuth system and a local Phi-3/Ollama proxy that can never be generally deployed).

## Live deployment

- **URL**: `https://smartcare-whatsapp-proxy-production.up.railway.app`
- **Platform**: Railway, project `smartcare-whatsapp-proxy`
- **Routes**: `GET /health`, `POST /api/sentwa/send`, `POST /api/sentwa/send-document`

No SentWA credentials are configured on Railway — `instance_id`/`access_token` are sent per-request by the client (from Settings → WhatsApp Configuration in the main app). This server has nothing secret to hold.

## The one real gotcha: certificate chain

`new.sentwa.com` sends an incomplete certificate chain (missing its Let's Encrypt "YR1" intermediate). Windows silently works around this via automatic AIA fetching; Node's TLS stack on Linux does not, so **every deploy that skips this will fail with a generic "fetch failed" / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**, with no useful indication why.

Fixed by `sentwa-ca-bundle.pem` (the missing YR1 intermediate + its own issuer "ISRG Root YR", itself cross-signed by the already-trusted "ISRG Root X1") plus the `NODE_EXTRA_CA_CERTS` environment variable on the Railway service pointing at it:

```
NODE_EXTRA_CA_CERTS=/app/sentwa-ca-bundle.pem
```

If `new.sentwa.com` ever rotates to a different intermediate, this will start failing again — re-run the same diagnosis: `openssl s_client -connect new.sentwa.com:443 -servername new.sentwa.com -showcerts` to see the chain it's actually sending, find the missing intermediate's AIA URL (`openssl x509 -in <leaf>.pem -noout -text | grep -A2 "Authority Information"`), fetch it (`curl <aia-url> -o intermediate.der && openssl x509 -inform DER -in intermediate.der -out intermediate.pem`), and repeat one level up if needed until the chain terminates at something already trusted.

## Redeploying

```
cd whatsapp-proxy
railway up --service smartcare-whatsapp-proxy
```

(Requires the Railway CLI logged in with access to this project.) A redeploy is only needed when `server.js`/`package.json`/the cert bundle change — the SentWA credentials themselves live client-side, never here.

## Local testing

```
PORT=8790 node --use-system-ca server.js
```

`--use-system-ca` is enough to fix the cert chain issue locally on Windows (the OS cache picks up the missing intermediate), which is why this didn't surface until the first real deploy to a fresh Linux container.
