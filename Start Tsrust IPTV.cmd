@echo off
setlocal
rem Starts Tsrust IPTV.
rem 1. The installed app (NSIS per-user install), if present.
rem 2. The release build from `pnpm tauri:build` (target\release), if the bundle step ran.
rem    A plain `cargo build --release` is skipped: without the Tauri build it points at the dev server.
rem 3. Otherwise the desktop dev build: `pnpm tauri dev` (Vite + cargo, first run takes a few minutes).

cd /d "%~dp0"

set "INSTALLED=%LOCALAPPDATA%\Tsrust IPTV\Tsrust IPTV.exe"
if exist "%INSTALLED%" (
  start "" "%INSTALLED%"
  exit /b 0
)

if exist "target\release\bundle\nsis\" if exist "target\release\iptv-tauri.exe" (
  start "" "target\release\iptv-tauri.exe"
  exit /b 0
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Install Node 24 and pnpm 10, then run this again.
  echo   https://nodejs.org/   then:   corepack enable
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call pnpm install || (pause & exit /b 1)
)

echo Starting Tsrust IPTV in development mode...
call pnpm tauri dev
if errorlevel 1 pause
endlocal
