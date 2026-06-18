# SmartCare AI — Intelligent Patient Monitoring Platform

SmartCare AI is a single-page, browser-based clinical intelligence platform for hospital ward management, AI-assisted diagnostics, real-time patient monitoring, and automated next-of-kin (NOK) communication. The entire application ships as one self-contained HTML file, with an optional local Node.js proxy that adds authentication, WhatsApp messaging, and local LLM support.

**Live demo:** https://quant80.github.io/SmartCare_AI/

---

## Table of Contents

1. [Repository Structure](#repository-structure)
2. [Getting Started](#getting-started)
3. [Navigation & Modules](#navigation--modules)
4. [AI Model Integrations](#ai-model-integrations)
5. [Autonomous Monitoring Agents](#autonomous-monitoring-agents)
6. [Authentication & Accounts](#authentication--accounts)
7. [Patient Data Model](#patient-data-model)
8. [Settings & Configuration](#settings--configuration)
9. [Reporting & Data Export](#reporting--data-export)
10. [Clinical Scoring & Safety](#clinical-scoring--safety)
11. [Governance, Compliance & Resilience](#governance-compliance--resilience)
12. [sentwa-proxy Backend](#sentwa-proxy-backend)
13. [Theming](#theming)
14. [Known Limitations](#known-limitations)

---

## Repository Structure

| Path | Description |
|---|---|
| `SmartCareAI_v1.html` | Canonical source file — the full application (single file, ~23k lines) |
| `index.html` | Identical copy of `SmartCareAI_v1.html`, served by GitHub Pages as the site root |
| `sentwa-proxy/` | Optional local Node.js backend providing auth, WhatsApp delivery, and local-LLM proxying |
| `.gitignore` | Excludes local secrets (`.env`), the local user database, and log exports from version control |

> `SmartCareAI_v1.html` and `index.html` are kept in sync intentionally — GitHub Pages requires `index.html` at the repository root to serve the site, while `SmartCareAI_v1.html` is the named canonical copy.

---

## Getting Started

### Option A — View only (no backend)
Open `SmartCareAI_v1.html` directly in a browser, or visit the [live demo](https://quant80.github.io/SmartCare_AI/). All patient data, settings, and AI API keys are stored client-side in `localStorage`/`sessionStorage`. Cloud AI providers (Claude, OpenAI, DeepSeek, Qwen, Gemini) work directly from the browser once you supply your own API key in **Settings**.

### Option B — Full functionality (with local backend)
Some features — local account login, Google OAuth, WhatsApp delivery via sentWA, and local LLM inference via Ollama — require the bundled proxy server:

```bash
cd sentwa-proxy
npm install better-sqlite3
node server.js
```

Or double-click `sentwa-proxy/start-proxy.bat` on Windows. The proxy listens on `http://localhost:8787` (see [sentwa-proxy Backend](#sentwa-proxy-backend) for full endpoint details). For Google OAuth, create `sentwa-proxy/.env` with:

```
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
```

For local LLM inference, install and run [Ollama](https://ollama.com) separately (`ollama serve`) and pull a model (default expected: `llama3.2:latest`).

---

## Navigation & Modules

The sidebar groups every page of the application:

**Monitoring & Operations**
- **Dashboard** — central KPI overview and ward summary
- **Monitoring** — live patient vitals feed
- **Analytics** — hospital-wide statistics, cohort trends, AI model performance
- **Patients** — registry, search, admission/discharge management
- **Discharge** — discharge processing and outcome tracking
- **Outpatient** — post-discharge follow-up, 7-day/30-day readmission tracking
- **Wards** — visual bed maps and ward-level turnover analytics
- **Alerts** — critical and informational alert management

**AI & Diagnostics**
- **AI Hub** — multi-model conversational assistant for clinical queries and calculations
- **AI Predictions** — deterioration forecasting and risk analytics
- **AI Clinical** — SOFA/qSOFA scoring and clinical decision support
- **X-ray AI Scanner** — radiology image analysis and structured report generation

**Administration**
- **Admin** — account management, audit logs, governance, FHIR/HL7/OData integration
- **Settings** — AI API keys, WhatsApp/sentWA configuration, user profile, BLE devices, theme

---

## AI Model Integrations

The app routes clinical queries through a unified model router (`callAIModel()`), supporting six interchangeable AI backends. Each requires its own API key (entered in **Settings → AI Model API Keys**), except Phi-3 Local.

| Model | Provider | Endpoint | Primary Use Case |
|---|---|---|---|
| **Claude** | Anthropic | `api.anthropic.com/v1/messages` | Clinical Q&A, risk assessment, differential diagnosis |
| **GPT-4o** | OpenAI | `api.openai.com/v1/chat/completions` | General clinical queries, patient summaries, report generation |
| **DeepSeek** | DeepSeek | `api.deepseek.com/v1/chat/completions` (`deepseek-chat`) | Medical literature analysis and reasoning |
| **Qwen** | Alibaba Cloud DashScope | `dashscope.aliyuncs.com/.../chat/completions` (`qwen-plus`) | Multilingual patient summaries, international communication |
| **Gemini 2.5 Flash** | Google AI Studio | `generativelanguage.googleapis.com` | Default model for X-ray/medical image analysis and text |
| **Phi-3 Local** | Ollama (on-device) | `http://localhost:8787/api/ollama` (configurable) | Offline, privacy-first inference — no API key required |

Notes:
- DeepSeek and Qwen requests may be blocked by browser CORS policy and benefit from being routed through the local proxy.
- Gemini is pre-selected as the default model for X-ray analysis and supports both text and image inputs.
- Phi-3 Local requires Ollama running locally with a pulled model; first responses can take 20–90 seconds on CPU.

---

## Autonomous Monitoring Agents

Beyond the AI chat assistants, SmartCare AI runs background agents that poll patient data on fixed intervals and automatically trigger alerts and NOK notifications without user intervention.

| Agent | Trigger | Interval | Function |
|---|---|---|---|
| **DeteriorationAgent** | Automatic on load | Every 5 min | Calculates NEWS2 score per patient; escalates to continuous monitoring at ≥5, flags urgent review at ≥7 |
| **DischargePlanningAgent** | Automatic on load (staggered) | Every 10 min | Detects patients overdue for discharge and sends pre-notice alerts |
| **NOKLifecycleAgent** | Automatic on load | Every 15 min | Manages the full NOK communication lifecycle: 24-hour check-ins, risk-level change alerts, pre-discharge notices, and extended-stay (>7 day) alerts |
| **ReadmissionRiskAgent** | Automatic on load | Every 20 min | Scores recently discharged patients (age, diagnosis, comorbidities, length of stay) and flags 7-day/30-day readmission risk |
| **MedicationSafetyAgent** | On patient admission | On-demand | Checks drug-allergy, drug-drug, drug-disease, and renal-dosing contraindications; escalates critical/high/moderate/low findings to the care team |
| **AdmissionAgent** | On patient registration | On-demand | Sends an automated welcome/admission notification to the patient's next of kin |
| **BereavementAgent** | On marking a patient deceased | On-demand | Sends a compassionate, auto-formatted bereavement notification to next of kin |

Each automatic agent exposes a live status indicator in the UI and writes every action it takes to the immutable audit trail.

---

## Authentication & Accounts

- **Local accounts** — registration and login (name, email, role, password) handled via the local proxy (`POST /api/auth/register`, `POST /api/auth/login`). Roles: Doctor, Nurse, Radiologist, Admin (Admin is not self-assignable). Includes brute-force protection (account lockout after repeated failed attempts).
- **OAuth2 / Social login** — Google, Microsoft, and GitHub sign-in via the local proxy's OAuth exchange flow (`/api/oauth/start/google`, `/api/oauth/callback/google`, `/api/oauth/exchange`).
- **Password recovery** — administrators can reset user passwords, with every reset recorded in the audit trail.
- **Session management** — session tokens are kept in `sessionStorage`; OAuth tokens in `localStorage`.

---

## Patient Data Model

Patient records are stored client-side in `localStorage` and include:

- **Identity & demographics** — ID, national ID, hospital record number, name, age, gender
- **Clinical assignment** — doctor, ward, bed, diagnosis, risk level/score
- **Live vitals** — heart rate, blood pressure, oxygen saturation, temperature, respiratory rate
- **Stay tracking** — length of stay, admission days, discharge status/date
- **Clinical metadata** — blood type, allergies, admission reason
- **History** — NOK communication log (up to 200 messages), activity log, radiology/imaging records

Patient creation runs full field validation, computes initial clinical scores, triggers the Medication Safety Agent, and sends the automated admission notification.

---

## Settings & Configuration

All configuration lives in **Settings** and persists to `localStorage`:

- **AI Model API Keys** — per-provider key entry, save/test actions for Claude, GPT-4o, DeepSeek, Qwen, and Gemini
- **Phi-3 Local** — configurable endpoint URL and local model name, with a connection test button
- **sentWA WhatsApp** — instance ID, access token, and proxy URL for WhatsApp delivery
- **Twilio (fallback)** — account SID, auth token, and WhatsApp-enabled sender number
- **User Profile** — name, email, mobile/WhatsApp number, last AI scan timestamp
- **BLE Device Configuration** — service/characteristic UUIDs and data format for streaming vitals from Bluetooth devices (Nordic UART or standard Bluetooth SIG Heart Rate Profile), linked to a specific patient
- **Enterprise OAuth2/OData** — identity provider and OData endpoint configuration for connecting to external systems (e.g., SAP, Salesforce, Azure), including token fetch and connection testing
- **Theme** — light/dark mode (defaults to dark for new visitors)

---

## Reporting & Data Export

- **Radiology reports** — AI-generated structured reports (technical quality, findings, impression, diagnosis, differentials, severity, recommendations), exportable as PDF, with support for comparison scans and follow-up Q&A
- **Patient summary PDF** — full patient record export
- **AI Hub response PDF** — exports chat responses including any generated charts
- **Chart exports** — PNG download and full-screen view for any AI-generated chart
- **CSV export** — patient table export from the Admin panel
- **FHIR bundle export/import** — interoperability with external health systems, including a dry-run preview before committing imported data
- **HL7 v2.5 export** — per-patient export
- **System logs export** — JSON export of the full audit/activity log
- **WhatsApp / Email report delivery** — send generated PDF reports directly to a patient's next of kin

---

## Clinical Scoring & Safety

- **NEWS2** (National Early Warning Score 2) — respiratory rate, oxygen saturation, temperature, systolic BP, heart rate, and mental status, driving the Deterioration Agent's escalation logic
- **qSOFA** (Quick Sequential Organ Failure Assessment) — altered mental status, systolic BP, and respiratory rate, used for sepsis risk triage
- **Sepsis bundle timers** — tracks elapsed time since sepsis is suspected and flags overdue protocol steps
- **Medication safety checks** — contraindication detection across allergies, drug-drug interactions, renal dosing, and disease state

---

## Governance, Compliance & Resilience

- **Immutable audit trail** — append-only, chain-verified log of all clinical and administrative actions
- **System health checks** — storage usage, API error rates, and rendering error monitoring
- **Critical patient locks** — edits to critical-risk patients require doctor-level authorization with an auditable override reason
- **Encrypted snapshots & restore drills** — built-in backup creation and integrity verification
- **Internationalization** — nationality picker and multilingual AI summaries (via Qwen)

---

## sentwa-proxy Backend

A lightweight Node.js HTTP server (`sentwa-proxy/server.js`, no external framework) that runs locally on **port 8787** and backs the features that the browser cannot perform alone — authentication, OAuth, WhatsApp delivery, and local LLM proxying. It persists users to a local SQLite database (`smartcare_users.db`, created automatically via `better-sqlite3`; falls back to an in-memory database if the file can't be opened).

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Service health check |
| `GET` | `/` , `/app` | Serves the application |
| `POST` | `/api/auth/register` | Create a local account |
| `POST` | `/api/auth/login` | Authenticate a local account |
| `GET` | `/api/oauth/start/google` | Begins the Google OAuth flow |
| `GET` | `/api/oauth/callback/google` | Google OAuth redirect handler |
| `POST` | `/api/oauth/exchange` | Exchanges an OAuth code for a session token/user object |
| `POST` | `/api/ollama` | Proxies chat completions to a local Ollama instance |
| `POST` | `/api/sentwa/send` | Forwards WhatsApp messages to the sentWA API (`new.sentwa.com`) |

**Requirements:** Node.js, the `better-sqlite3` package, and a `.env` file with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` if Google OAuth is used. The `.env` file and the SQLite database are intentionally excluded from version control via `.gitignore`.

---

## Theming

The application defaults to **dark mode** for new visitors. The active theme is stored in `localStorage` and persists across sessions; users can switch via the theme toggle button or the preference checkbox in Settings.

---

## Known Limitations

- Features that depend on `sentwa-proxy` (local login, Google OAuth, WhatsApp delivery, local LLM inference) only work when the proxy is running on `localhost:8787`. On a statically hosted deployment (GitHub Pages, Netlify, etc.), these features are inactive unless a visitor runs the proxy locally and points the app at it.
- Cloud AI provider keys (Claude, OpenAI, DeepSeek, Qwen, Gemini) are entered and stored client-side; each visitor must supply their own key.
- All patient and application data is stored in browser `localStorage`/`sessionStorage` — there is no server-side persistence for patient records outside of the optional local proxy's user/auth database.
