# Players: detection, external launch, embedded mpv

Code: `crates/iptv-core/src/player/` (core) and `crates/iptv-tauri/src/mpv_window.rs` (Windows child window). RPC: `player.capabilities`, `player.detect`, `player.openExternal`, `mpv.attach`, `mpv.load`, `mpv.command`, `mpv.setProperty`, `mpv.setBounds`, `mpv.detach`, `mpv.state` (SPEC C4). Events: `player.external`, `mpv.state`.

| File | Role |
| --- | --- |
| `player/mod.rs` | Shared contract (`Bounds`, `ChildWindowFactory`, `set_window_factory`, `window_factory`, `DetectedPlayers`, `detect`), `capabilities`, `init` |
| `player/detect.rs` | Finds mpv and VLC. `DetectEnv` holds every environment input so tests can point the search at temp dirs |
| `player/args.rs` | Argument building, header escaping, the quote-aware splitter for `mpvArgs` and `vlcArgs` |
| `player/external.rs` | Detached spawn plus the `player.external` exit watcher |
| `player/ipc.rs` | mpv JSON IPC client. Works over any `AsyncRead + AsyncWrite`: the named pipe in production, `tokio::io::duplex` in tests |
| `player/mpv_state.rs` | Pure reducers from IPC events to `MpvState` |
| `player/embedded.rs` | Embedded session lifecycle, crash handling, `MpvManager` in `AppState.extensions["mpv"]` |
| `player/rpc.rs` | Registrations (`COMMANDS` lists them) |

## Detection

The first existing file wins. mpv and VLC are searched separately:

1. The configured path (`settings.mpvPath` or `settings.vlcPath`). Surrounding quotes are tolerated. A directory is accepted, and the exe is looked up inside it. A configured path that does not exist falls through to the search.
2. mpv only: `vendor/mpv/mpv.exe` beside the running exe, then under the working directory, then under up to four ancestors of each. The ancestor step lets `pnpm tauri dev`, whose exe lives in `target/debug`, find the repo's `vendor/`.
3. Every `PATH` entry, like `where`. Only `mpv.exe` matches; `mpv.com` is skipped because it is the console wrapper.
4. Well-known locations:
   - Program Files and Program Files (x86): `VideoLAN\VLC\vlc.exe`, `mpv\mpv.exe`.
   - scoop: `~/scoop/apps/<name>/current`, `~/scoop/shims`, `$SCOOP`, and the global `ProgramData\scoop`.
   - choco: `C:\ProgramData\chocolatey\bin`.
   - WinGet: `%LOCALAPPDATA%\Microsoft\WinGet\Links`, then `...\WinGet\Packages\<id containing the name>\`.
   - Other OSes: `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/opt/local/bin`, `/snap/bin`, and `/Applications/{mpv,VLC}.app/Contents/MacOS/*` (also under `~/Applications`).

`settings.detectPlayers` (B2) and `player.detect` both call `player::detect(&settings)`.

## External players

`player.openExternal {player, source}` resolves the player through detection and builds argv as in C4:

- mpv: `--title=<t> [--user-agent=<ua>] [--referrer=<ref>] [--http-header-fields=Origin:<o>] --force-media-title=<t> <mpvArgs...> <url>`
- VLC: `--meta-title=<t> [--http-user-agent=<ua>] [--http-referrer=<ref>] <vlcArgs...> <url>` (VLC has no Origin option)

Header flags appear only when they are set and not blank. Each flag is a single argv element, and `std::process::Command` quotes it for the platform, so titles that contain quotes or spaces arrive intact. The `Origin` value is escaped for mpv's string-list syntax (`,` becomes `\,` and `\` becomes `\\`), which is what the old app did for the MAG user agent `(KHTML, like Gecko)`.

`settings.mpvArgs` and `settings.vlcArgs` are split by `args::split_shell_args`:

- Whitespace separates arguments.
- `"..."` groups. Inside it, `\"` is a literal quote and every other backslash is kept.
- `'...'` groups with no escapes at all.
- Outside quotes, a backslash escapes only whitespace or a quote. `C:\path` and `\\server\share` stay intact.
- Quotes can appear mid-argument (`--title="A B"`), and `""` produces an empty argument.

The process runs with null stdio, `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows (its own process group on Unix), its working directory set to the player's folder, and no kill-on-drop, so it outlives the app. `player.external {state: 'started', player, title, pid}` is emitted right away. A watcher task then emits `{state: 'exited', ..., exitCode}`. The URL is never logged because it can contain Xtream credentials.

## Embedded mpv (Windows)

### Why mpv.exe and not libmpv

The old Electron app loaded `libmpv-2.dll` through a native Node addon and passed the HWND through mpv's `wid` option (`embedded_mpv_win32.cc`). On Linux it ran `mpv --wid` out of process over JSON IPC (`embedded_mpv_wid_common.h`). Here the Windows build uses that out-of-process design too:

- A crash inside mpv or a GPU driver cannot take the app down.
- There is no FFI or DLL basename matching. The old app had to keep `libmpv-2.dll` under its exact import name.
- The installer stays small, because mpv is optional and drop-in.
- The whole protocol layer is plain async Rust and runs under `cargo test`.

### Window (HWND) approach

1. `iptv-tauri` registers `MpvWindowFactory` at boot through `iptv_core::player::set_window_factory(&state, Arc::new(MpvWindowFactory::new(handle)))`. This only happens in the desktop shell, so in server mode `player.capabilities` reports `embeddedMpv: false` with a reason.
2. `mpv.attach {bounds}` calls `factory.create(bounds)` from `spawn_blocking`. The factory marshals to the main thread with `AppHandle::run_on_main_thread` and gets the result back over a channel with a 5 s timeout. Tauri runs the closure inline when the caller already is the main thread, so this cannot deadlock. On the main thread the factory:
   - registers the window class `TsrustIptvMpvHost` once (black stock brush, arrow cursor);
   - calls `CreateWindowExW(WS_EX_NOPARENTNOTIFY, ..., WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN, parent = main window HWND)`;
   - calls `SetWindowPos(HWND_TOP, SWP_NOACTIVATE | SWP_SHOWWINDOW)` so the window sits above the WebView2 child without taking focus.

   Its window procedure returns `HTTRANSPARENT` for `WM_NCHITTEST` and lets `DefWindowProc` paint the black brush.
3. Bounds arrive in CSS px relative to the webview, which fills the client area. The factory multiplies them by `window.scale_factor()`, rounds, and clamps width and height to at least 1.
4. mpv is started with the user's `mpvArgs` first, then the C4 flags, so the C4 flags always win:
   `--wid=<hwnd> --input-ipc-server=\\.\pipe\tsrust-iptv-mpv-<our pid> --idle=yes --keep-open=yes --no-osc --no-input-default-bindings --force-window=yes --hwdec=auto-safe --input-vo-keyboard=no --no-terminal --volume=<last volume>`
   mpv creates its own video window inside ours, so moving or destroying our window moves or removes the video. The process runs with `CREATE_NO_WINDOW`, null stdio, and kill-on-drop.
5. The video window is native and sits above the web content. HTML cannot draw on top of it, so player controls must sit outside the reported bounds, or the UI must shrink the bounds while an overlay is open. The old app used a fixed dock for the same reason.

Verified on Windows 11 with a scratch Tauri app that hosts the real factory and plays a 60 s test clip encoded with mpv: the video covered the requested 640x360 CSS rect above the web content, followed `mpv.setBounds`, and disappeared on `mpv.detach`.

### JSON IPC

The client is `ipc::MpvClient` and the wire format is newline-delimited JSON:

- request: `{"command": [...], "request_id": n}`
- reply: `{"request_id": n, "error": "success" | "<reason>", "data": ...}`
- event: `{"event": "...", ...}`

Behaviour:

- A reader task matches replies to callers by `request_id`, so callers may run concurrently. A reply that is not `success` becomes `Invalid("mpv rejected <cmd>: <reason>")`. No reply within 5 s becomes `Timeout`. When the pipe closes, every pending and future call fails with `Conflict("embedded mpv is not running...")`.
- After the connection opens, the client runs `observe_property` on ids 1..7: `pause`, `time-pos`, `duration`, `volume`, `mute`, `track-list`, `fullscreen`. `property-change` events go through `mpv_state::apply_property`; `track-list` becomes `MpvTrack[]` with blank lang and title set to `None`, and unknown track types dropped.
- `start-file` clears the error. `file-loaded` sets `loaded`. `end-file` with `reason: "error"` sets a user-facing error that includes mpv's `file_error`.
- `mpv.state` events are throttled to 4/s: a leading emit, then a 250 ms cooldown, then a trailing emit, so the last state is always delivered. The emitter stops when the pipe closes.
- Connecting: `ClientOptions::new().open(pipe)` is retried every 50 ms for up to 5 s, treating `NotFound` and `ERROR_PIPE_BUSY` as "not yet". It fails early if mpv exits during startup. If a stale mpv of ours still owns the pipe name, it is asked to quit before the new process starts.

### Commands

- `mpv.attach`: idempotent. With a live session it only moves the window.
- `mpv.load {source}`: sends `["loadfile", url, "replace", -1, {force-media-title, user-agent, referrer, http-header-fields: "Origin:<o>", start: "+<resumeSeconds>"}]`. Live sources never seek. If mpv older than 0.38 rejects the 5-argument form, the command is retried as `["loadfile", url, "replace", "k=%len%v,..."]`, where `%len%` quoting keeps commas safe.
- `mpv.command {cmd}`: passes a raw command through. `quit`, `run`, `subprocess`, `load-script` and similar commands are rejected, and object or array arguments are rejected.
- `mpv.setProperty {name, value}`: `set_property`.
- `mpv.setBounds {bounds}`: `factory.set_bounds`.
- `mpv.detach`: sends `quit`, waits 2 s, kills the process if it is still running, destroys the window, and emits a final `{attached: false}` state. It is idempotent.
- `mpv.state`: returns the live state, or the last detached state, which keeps volume, mute, and the last error.
- Crash handling: a watcher notices when mpv exits or the pipe closes without a detach. It waits up to 1 s for the exit code, then sets `error: "mpv stopped unexpectedly (exit code N). Start playback again to restart it."`, tears the session down, destroys the window, and emits the result.
- On other OSes every `mpv.*` command returns `Unsupported`, and the external players still work.
- App exit: call `player::shutdown(&state).await` (graceful) or `player::kill_embedded(&state)` (synchronous) from the Tauri exit hook, so mpv never outlives the app.

## Dropping mpv into vendor/mpv

1. Download a Windows x86_64 build from shinchiro's mpv-winbuild-cmake releases (<https://github.com/shinchiro/mpv-winbuild-cmake/releases>), for example `mpv-x86_64-v3-<date>-git-<hash>.7z`. Use the `x86_64` build instead of `-v3` on CPUs without AVX2. Do not use the `mpv-dev-*` archive, which is libmpv for developers.
2. Extract it so that `mpv.exe` sits directly in `vendor/mpv/`, next to the DLLs and folders shipped with it (`d3dcompiler_43.dll`, `vulkan-1.dll` where present, `mpv.com`, `doc/`). Keep the files together, because mpv loads its DLLs from its own folder and the process starts with that folder as its working directory.

   ```
   vendor/mpv/
     mpv.exe
     mpv.com
     d3dcompiler_43.dll
     ...
   ```
3. `vendor/` is gitignored. For a packaged build, add `vendor/mpv/**` to the Tauri bundle resources so the files land beside the installed exe.
4. Check it: Settings > Players should show the detected path, and `player.capabilities` should return `embeddedMpv: true` in the desktop app.

A system mpv works too (WinGet, scoop, choco, or `PATH`), and so does a path set in Settings > Players.

## Tests

- `tests/player_args.rs`: shell splitting (quotes, escapes, Windows paths), mpv and VLC argv with and without headers, header escaping, embedded flags and their order, `loadfile` options, legacy `%len%` options, raw-command validation.
- `tests/player_ipc.rs`: framing (partial writes, several lines per write), reply and event parsing, concurrent `request_id` correlation, error and timeout paths, observer registration, `property-change` handling, track parsing, close handling, emitter throttling (50 updates produce at most 4 emits and the last state wins). It uses a fake mpv on `tokio::io::duplex`.
- `tests/player_detect.rs`: every search location against temp-dir layouts, plus precedence and fallbacks.
- `tests/player_rpc.rs`: exactly the 10 C4 names are registered; capabilities reasons; errors without a session; `player.openExternal` with `whoami.exe` as a stand-in player (the `started` then `exited` events); and, when an mpv is detectable, a real embedded end-to-end run with `--vo=null --ao=null`. That run covers attach, attach again, loading an mpv-encoded clip with resume and headers, pause, volume, seek, a blocked `quit`, an unknown property, setBounds, a crash via `taskkill` (error state, window destroyed), re-attach, and an idempotent detach.
