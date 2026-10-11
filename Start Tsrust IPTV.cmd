@echo off
setlocal EnableExtensions
rem Starts Tsrust IPTV.
rem 1. The installed app (NSIS per-user install). The install folder comes from the
rem    uninstall registry key (InstallLocation), falling back to %LOCALAPPDATA%\Tsrust IPTV.
rem    The NSIS build installs iptv-tauri.exe; "Tsrust IPTV.exe" is checked too in case a
rem    later build sets mainBinaryName.
rem 2. A release build from `pnpm tauri build` (target\release or crates\iptv-tauri\target\release).
rem    A plain `cargo build --release` is skipped: without the Tauri build it points at the dev server.
rem 3. Otherwise the desktop dev build: `pnpm tauri dev` (Vite + cargo, first run takes a few minutes).

cd /d "%~dp0"

set "INSTALL_DIR="
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Tsrust IPTV" /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do set "INSTALL_DIR=%%~B"
if not defined INSTALL_DIR set "INSTALL_DIR=%LOCALAPPDATA%\Tsrust IPTV"
rem Strip surrounding quotes and a trailing backslash.
set "INSTALL_DIR=%INSTALL_DIR:"=%"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

for %%E in ("iptv-tauri.exe" "Tsrust IPTV.exe") do (
  if exist "%INSTALL_DIR%\%%~E" (
    start "" "%INSTALL_DIR%\%%~E"
    exit /b 0
  )
)

for %%T in ("target\release" "crates\iptv-tauri\target\release") do (
  if exist "%%~T\bundle\nsis\" if exist "%%~T\iptv-tauri.exe" (
    start "" "%%~T\iptv-tauri.exe"
    exit /b 0
  )
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
