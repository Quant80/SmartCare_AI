# SmartCare OAuth Login Setup Guide

SmartCare now supports login with Google, Microsoft, and GitHub. The system is ready to use, but to enable real OAuth (instead of development mock mode), you need to register your app with each provider.

## Current Status
- ✅ OAuth UI added (login buttons in sidebar)
- ✅ Backend OAuth handlers in sentwa-proxy
- ✅ Mock authentication for development
- ⏳ Production OAuth requires credential registration

## Development Mode
Currently, you can click any login button and it will simulate a successful login with that provider. This is perfect for testing the UI.

## Production Setup (Optional)

### 1. Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Go to **APIs & Services** → **OAuth consent screen**
4. Set up consent (User Type: External)
5. Go to **Credentials** → **Create OAuth 2.0 Client ID**
   - Application type: Web application
   - Authorized redirect URIs: `http://localhost:8787/api/oauth/google/callback`
6. Copy Client ID and Client Secret
7. Add to `sentwa-proxy/.env`:
   ```
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   ```

### 2. Microsoft OAuth Setup

1. Go to [Azure Portal](https://portal.azure.com/)
2. Go to **Azure Active Directory** → **App registrations** → **New registration**
3. Name: SmartCare
4. Redirect URI: `http://localhost:8787/api/oauth/microsoft/callback`
5. Go to **Certificates & secrets** → Create a new client secret
6. Copy Application ID and Client Secret
7. Add to `sentwa-proxy/.env`:
   ```
   MICROSOFT_CLIENT_ID=your_app_id
   MICROSOFT_CLIENT_SECRET=your_secret
   MICROSOFT_TENANT=common
   ```

### 3. GitHub OAuth Setup

1. Go to [GitHub Settings](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in:
   - Application name: SmartCare
   - Homepage URL: `http://localhost:8787`
   - Authorization callback URL: `http://localhost:8787/api/oauth/github/callback`
4. Copy Client ID and Client Secret
5. Add to `sentwa-proxy/.env`:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

### 4. Update sentwa-proxy

After creating your `.env` file in the `sentwa-proxy/` folder:

```bash
cd sentwa-proxy
npm install dotenv   # Install if not already present
# Restart proxy: npm start or double-click start-proxy.bat
```

Then update `server.js` to read credentials from `.env` and perform real OAuth exchanges instead of mock mode.

## How to Use (Development Mode)

1. Hard refresh SmartCare (Ctrl+F5)
2. Look at the sidebar bottom - you'll see three login buttons
3. Click any provider button to login
4. You'll see your user info in the sidebar
5. Click the user menu to logout

## Features

✅ Login with Google, Microsoft, or GitHub
✅ User profile stored locally (name, email, provider)
✅ Session persists across page reloads
✅ Logout clears session
✅ Login is optional - SmartCare works without it
✅ No need for admin features to be locked - all features available to authenticated and non-authenticated users

## For Production Deployment

When deploying to production:
1. Register your app URLs with each OAuth provider (not localhost)
2. Update callback URLs to match production domain
3. Store OAuth secrets securely (use environment variables, not in code)
4. Implement proper JWT token management
5. Add user profile database if you need to store user history

---

For now, enjoy testing with the mock OAuth! 🎉
