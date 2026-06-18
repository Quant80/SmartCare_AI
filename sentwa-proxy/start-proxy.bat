@echo off
setlocal
cd /d "%~dp0"
title SmartCare Local Proxy
echo Starting SmartCare proxy on port 8787
echo   WhatsApp:    http://localhost:8787/api/sentwa/send
echo   Ollama:      http://localhost:8787/api/ollama
echo   Google Auth: http://localhost:8787/api/oauth/start/google
echo.
echo Google OAuth: edit sentwa-proxy\.env with your GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
echo Make sure Ollama is running: ollama serve
echo Press Ctrl+C to stop.
node server.js
pause


