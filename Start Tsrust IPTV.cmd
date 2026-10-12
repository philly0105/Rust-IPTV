@echo off
setlocal EnableExtensions
rem Starts Tsrust IPTV.
rem 1. The installed app (NSIS per-user install). The install folder comes from the
rem    uninstall registry key (InstallLocation), falling back to %LOCALAPPDATA%\Tsrust IPTV.
rem    The NSIS build installs iptv-tauri.exe; "Tsrust IPTV.exe" is checked too in case a
rem    later build sets mainBinaryName.
rem 2. A release build from `pnpm tauri build` (with or without --no-bundle), looked up in the
rem    cargo target dir: %TSRUST_TARGET_DIR% when set, else the one cargo reports (`cargo metadata`,
rem    which follows a local .cargo\config.toml), then target\ and crates\iptv-tauri\target\.
rem    Build it with the Tauri CLI: a plain `cargo build --release` exe points at the dev server.
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

rem An optional TSRUST_TARGET_DIR environment variable names the cargo target dir directly (for
rem a target dir moved by a local .cargo\config.toml when cargo is not on PATH); it is tried first.
rem Otherwise ask cargo. RUSTUP_AUTO_INSTALL=0 keeps rustup from downloading the pinned toolchain
rem just to answer; without cargo this stays empty and the default paths are used.
set "TARGET_ROOT="
if defined TSRUST_TARGET_DIR if exist "%TSRUST_TARGET_DIR%\release\iptv-tauri.exe" (
  start "" "%TSRUST_TARGET_DIR%\release\iptv-tauri.exe"
  exit /b 0
)
where cargo >nul 2>nul
if not errorlevel 1 (
  for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "$env:RUSTUP_AUTO_INSTALL='0'; (cargo metadata --format-version 1 --no-deps 2>$null | ConvertFrom-Json).target_directory" 2^>nul`) do set "TARGET_ROOT=%%D"
)
if defined TARGET_ROOT set "TARGET_ROOT=%TARGET_ROOT:/=\%"

for %%T in ("%TARGET_ROOT%" "target" "crates\iptv-tauri\target") do (
  if not "%%~T"=="" if exist "%%~T\release\iptv-tauri.exe" (
    start "" "%%~T\release\iptv-tauri.exe"
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
