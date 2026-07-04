@echo off
title OpenUI - Local AI Desktop Assistant
echo ==========================================================
echo                Starting OpenUI (Electron)
echo ==========================================================
echo.

:: Check Node.js installation (Electron app — replaces the old Python launcher)
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 20 LTS or later from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies on first run (no node_modules yet)
if not exist "node_modules" (
    echo Installing dependencies (first run)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: Ollama is the ONLY AI engine — it powers all chat, planning and agent runs.
:: The app makes zero cloud calls, so Ollama must be running before we launch.
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Ollama is not installed or not in PATH.
    echo Install it from https://ollama.com/download then run: ollama pull llama3:8b
    pause
    exit /b 1
)

echo Checking local Ollama server...
powershell -Command "try { Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if %errorlevel% neq 0 (
    echo Ollama is not running. Starting "ollama serve" in a new window...
    start "Ollama Server" cmd /c "ollama serve"
    :: Wait for the server to accept connections (up to ~20s).
    for /l %%i in (1,1,10) do (
        timeout /t 2 >nul
        powershell -Command "try { Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
        if not errorlevel 1 goto ollama_ready
    )
    echo [WARNING] Ollama did not respond in time — the app will show a start hint if it's still down.
)
:ollama_ready

:: Ensure the default model is pulled so the first chat doesn't fail.
echo Ensuring the model is available (ollama pull llama3:8b)...
ollama pull llama3:8b

:: Launch OpenUI in development mode (electron-vite watch + Electron window).
echo Launching OpenUI...
call npm run dev
exit /b %errorlevel%
