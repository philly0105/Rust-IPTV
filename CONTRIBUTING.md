# Contributing to Tsrust IPTV

Bug reports, fixes and translations are welcome. For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue. For anything larger than a fix, open an issue first so we can agree on the approach before you spend time on it.

## How the code is organised

The Rust core (`crates/iptv-core`) owns parsing, storage, portals, the guide, downloads, TMDB, remote control and players. The React UI never holds a whole catalog: it pages rows out of SQLite over one `rpc(cmd, args)` call. Two thin hosts run the core: the desktop shell (`crates/iptv-tauri`, Tauri 2, Windows) and the web server (`crates/iptv-server`, axum), which serves the same UI to browsers.

| Path | What is there |
| --- | --- |
| `crates/iptv-core` | The core: sources, catalog, M3U, Xtream, Stalker, EPG, user state, settings, backup, downloads, TMDB, remote control, recording, players |
| `crates/iptv-tauri` | Desktop shell: window, tray, embedded mpv, loopback media proxy |
| `crates/iptv-server` | Server mode: REST and WebSocket API, stream proxy, static UI |
| `crates/iptv-mock` | Mock Xtream, Stalker, M3U and XMLTV servers for development and e2e |
| `crates/iptv-fixtures` | Fixture builders shared by the Rust tests |
| `src/` | The React UI (Vite, TypeScript, Tailwind 4, TanStack Query, Zustand) |
| `e2e/` | Playwright specs and helpers |
| `fixtures/` | Static test inputs: sample playlist, guide, portal answers and media ([fixtures/README.md](fixtures/README.md)) |
| `docs/` | Architecture notes, one per subsystem, starting at [docs/README.md](docs/README.md); the user guide; brand masters |
| `tools/` | Bundle budget check, brand icon renderer, window probe, third-party notices |
| `deploy/` | Docker Compose with Caddy for running the server for other devices |

Start with [docs/README.md](docs/README.md). It links the build spec (`docs/SPEC.md`) and the document for each subsystem.

## Prerequisites

- Rust 1.90 or newer, through rustup. `rust-version` in `Cargo.toml` holds the minimum, and CI checks the workspace with exactly that version (job `msrv`). `rust-toolchain.toml` selects the current stable channel with rustfmt and clippy; it does not pin a version, so builds use whatever stable rustup has. The Docker image builds with `rust:1.96`.
- Node 24 and pnpm 10. Run `corepack enable` once and pnpm comes at the version `package.json` pins.
- Windows with the Microsoft Edge WebView2 runtime (preinstalled on Windows 11) for the desktop app. The core, the server and the mock also build and test on Linux.
- Optional: mpv for embedded and external playback. Put a Windows build in `vendor/mpv/` (so that `vendor/mpv/mpv.exe` exists), install it with WinGet, Scoop or Chocolatey, or set its path in Settings > External players. See [docs/architecture/players.md](docs/architecture/players.md).
- Optional: VLC for external playback.

```
pnpm install
```

## Running it

| What | Command |
| --- | --- |
| Desktop app, dev mode | `pnpm tauri:dev`, or double-click `Start Tsrust IPTV.cmd` |
| Desktop installer (NSIS) | `pnpm tauri:build` (output in `release/bundle/nsis/` under the cargo target dir: `target/` unless a local `.cargo/config.toml` moves it; `cargo metadata --format-version 1 --no-deps` reports it as `target_directory`) |
| Desktop installer with mpv bundled | `pnpm tauri:build:mpv` (needs `vendor/mpv/`; makes the installer much larger; see [Licences](#licences)) |
| Web UI against a server | `pnpm build`, then `pnpm server`, then open http://127.0.0.1:7180 |
| Web UI with hot reload | `pnpm server` in one terminal, `pnpm dev` in another, open http://localhost:5173 (Vite proxies `/api`) |
| Mock Xtream/Stalker/M3U/XMLTV servers | `pnpm mock` (port 7290) |
| Docker (server mode) | `docker build -t tsrust-iptv .` then `docker run --rm -p 127.0.0.1:7180:7180 -v tsrust-iptv-data:/data tsrust-iptv` |

`Start Tsrust IPTV.cmd` starts the installed app if there is one, then a `pnpm tauri:build` output (`release\iptv-tauri.exe` in the `TSRUST_TARGET_DIR` environment variable's folder when that is set, else in the target dir `cargo metadata` reports, else in `target\` or `crates\iptv-tauri\target\`), and otherwise falls back to `pnpm tauri dev`.

Server flags: `iptv-server --port 7180 --data-dir ./.data --static ./dist`. It binds 127.0.0.1 unless you pass `--host`. The user guide's [server mode section](docs/user-guide.md#using-it-in-a-browser-server-mode) lists what differs in the browser, and [docs/architecture/server.md](docs/architecture/server.md) has every flag.

To try the app without a real provider, run `pnpm mock` and add a source:

- M3U URL: `http://127.0.0.1:7290/m3u/sample.m3u`
- Xtream: server `http://127.0.0.1:7290/xtream`, user `demo`, password `secret`
- Stalker: portal `http://127.0.0.1:7290/stalker/c/`, MAC `00:1A:79:00:00:01`

## Checks

```
pnpm check
```

This runs, in order: `pnpm typecheck` (tsc-rs), `pnpm test` (vitest), `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo fmt --all -- --check`. The workspace tests include the desktop crate, so run them on Windows, or run `cargo test -p iptv-core -p iptv-server -p iptv-mock` elsewhere. Also:

- `pnpm build` produces `dist/`. `pnpm size:check` then lists every chunk and fails when the entry chunk (`dist/assets/index-*.js`) is over 268,000 bytes, or when Home's route chunk statically loads player code (`tools/check-bundle.mjs`; see [performance.md](docs/architecture/performance.md)).
- `cargo deny check` (with [cargo-deny](https://github.com/EmbarkStudios/cargo-deny)) checks advisories, licences, banned crates and sources against `deny.toml`. Add a new dependency's licence there only if it allows redistribution with a notice, and keep `about.toml`'s list in step.
- The performance tests run in release mode: `cargo test -p iptv-core --release --test m3u_perf` (50k channels) and `--test epg_perf` (120 MB XMLTV). `--test catalog_perf` checks that live list pages and searches over 50k channels answer in under 100 ms. CI does not run these.
- `tools/window-probe.ps1` checks the real desktop window from outside: frame and fullscreen state, window and monitor rects in physical pixels, the embedded mpv host, and synthetic clicks, double-clicks and PiP drags on the video. Run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-probe.ps1` with the app open (the default `-Action Info` only reads). `-Action SelfTest` needs no running app: it checks offline how the probe picks the mpv IPC pipe (`\\.\pipe\tsrust-iptv-mpv-<pid>-<session>`, a new name for each attach). The script header lists every action.

### End-to-end tests

`pnpm e2e` runs Playwright against `iptv-server` (port 7180) and `iptv-mock` (port 7290). `playwright.config.ts` starts both with `cargo run` and a fresh `./.e2e-data`, and needs `dist/` from `pnpm build` first.

- The browser is installed Microsoft Edge by default. `PW_CHANNEL=chromium` switches to Playwright's bundled Chromium, which cannot play H.264, so every spec that plays the mock's media fails there.
- `E2E_PORT` and `E2E_MOCK_PORT` move the servers (the mock URLs in the specs and fixtures assume 7290), and `E2E_KEEP_DATA=1` keeps the previous `./.e2e-data`.
- Every test fails on console errors, React warnings and uncaught page errors (`e2e/helpers/fixtures.ts`). A spec that provokes an error on purpose allows it with `consoleLog.allow(pattern)`.
- Failed tests keep a trace and a screenshot, and a video when Playwright's ffmpeg is installed (`pnpm exec playwright install ffmpeg`).

### Screenshots

`e2e/screens.spec.ts` captures the main screens (dashboard, live TV, movie detail, player, multi-view, settings, lists, stats, the guide with its search, the tour and What's new) at 1280 x 800 and 390 x 844, in the dark, light and OLED themes, into `test-results/screens/<screen>-<viewport>-<theme>.png`. It also fails when a screen scrolls sideways. Run it alone with `pnpm e2e e2e/screens.spec.ts`; CI uploads the folder as the `screens` artifact. The README's images live in `docs/screenshots/`, whose README lists each file.

`tools/brand-icons.mjs` renders every app, installer and web icon from the SVG masters in `docs/brand/` (see the README there).

## Continuous integration

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | Every push and pull request | Frontend (install, typecheck, test, build, size check) on Ubuntu; Rust fmt, clippy and tests on Windows; core, server and mock tests on Linux; cargo-deny (advisories report without failing; licences, bans and sources must pass) |
| `ci.yml` | Pull requests and pushes to master | `cargo check` with the minimum Rust version; the Docker image built and started (health check, no push); the desktop release build without the installer |
| `e2e.yml` | Pull requests, Mondays, by hand | Playwright in Edge on Ubuntu; uploads `test-results/screens/`, and the report when a test fails |
| `release.yml` | `v*` tags | Draft GitHub Release with the Windows installer and `THIRD_PARTY_NOTICES.md`; server image for amd64 and arm64 on ghcr.io |

Dependabot (`.github/dependabot.yml`) proposes npm, cargo and GitHub Actions updates weekly. It leaves Tauri's minor versions alone, because the npm and Rust Tauri packages have to move together, and `mpegts.js`, which is patched in `patches/`.

## Style

- Rust: rustfmt defaults and clippy with `-D warnings`. Errors cross the RPC boundary as `RpcError` with a code (see `docs/SPEC.md`); log through `tracing` and never log URLs, credentials or MACs unredacted.
- TypeScript: strict mode with `noUncheckedIndexedAccess`; import from `@/` (`src/`).
- UI: build screens from the kit in `src/ui` with the design tokens. [design-system.md](docs/architecture/design-system.md) is the rulebook, and `src/ui/test/kit.test.tsx` fails when a feature draws its own switch, checkbox or radio.
- Text: every user-facing string goes through i18next. Add new keys to the English file in `src/i18n/en/<namespace>.json` and to all 18 other locales; `src/i18n-parity.test.ts` fails on a missing key, plural form or placeholder. Keys are flat camelCase per namespace, and plurals use `_one` / `_other`.
- Comments explain why, in plain words. Some older comments cite audit or run codes (`SH-11`, `Run 3 C7`); new code should say what the code is for instead.
- Docs: when you change behaviour, update the subsystem's document under `docs/architecture/` and, if users see it, the [user guide](docs/user-guide.md).
- Commits: a short subject in the imperative or a plain description, then a body in plain prose that says what changed and why.

## Releases

1. Move the Unreleased entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading.
2. Set that version in `package.json`, the workspace `Cargo.toml` (then `cargo update -w` for Cargo.lock), and `crates/iptv-tauri/tauri.conf.json`, and add a What's new entry to `src/features/onboarding/notes.ts` with its strings in every locale.
3. Tag the commit `vx.y.z` and push the tag. `release.yml` stops if the tag and the three versions disagree, or if the changelog has no section for the version.
4. Check the draft release (installer, notices, notes) and publish it. The images are already on ghcr.io as `x.y.z` and `latest` (`latest` is skipped for pre-release tags such as `v0.3.0-rc.1`).

Two parts are off until the owner decides on them:

- Code signing: the installer is unsigned, so Windows SmartScreen warns on first run. Signing needs a certificate and a `bundle.windows` signing setting or a `signCommand`, plus the matching secrets in the workflow.
- The updater: it is off unless the app is built with `--features updater` (for example `pnpm tauri build --features updater`). `tauri.conf.json` carries `plugins.updater` with a placeholder endpoint (`https://example.invalid/...`) and an empty `pubkey`, so an updater build cannot install anything until both are replaced: generate a key pair with `pnpm tauri signer generate`, put the public key in `pubkey`, point `endpoints` at your `latest.json`, set `bundle.createUpdaterArtifacts`, and sign releases with the private key. `app.info` reports `updaterAvailable`. No signing key or feed exists in this repository.

## Licences

The project licence has not been chosen yet; the `license = "MIT"` in the workspace `Cargo.toml` is a placeholder.

Third-party licences ship as `THIRD_PARTY_NOTICES.md`, which `tools/third-party-notices.mjs` writes from `pnpm licenses list --prod` and from `cargo about generate` with `about.toml` and `about.hbs`. The release workflow generates it; the file is not committed, because every dependency update would change it.

The mpv build bundled by `pnpm tauri:build:mpv` is GPL-2.0-or-later and ships with its licence and source notice in `vendor/mpv/LICENSE.txt`, which is installed beside `mpv.exe`. Tsrust IPTV runs mpv as a separate process and does not link it. That file is the only tracked file in `vendor/mpv/` and describes one specific build: when you replace the mpv build, update its version and commit lines (mpv, FFmpeg, libplacebo) to match the new one before building the installer. Whoever publishes that installer takes on the GPL's source obligation for mpv: attach the matching mpv, FFmpeg and libplacebo sources to the release, or honour the written offer in that file. The release workflow builds only the installer without mpv.
