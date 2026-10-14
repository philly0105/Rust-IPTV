# Players: detection, external launch, embedded mpv

Code: `crates/iptv-core/src/player/` (core) and `crates/iptv-tauri/src/mpv_window.rs` (Windows child window). RPC: `player.capabilities`, `player.detect`, `player.openExternal`, `player.stopExternal`, `mpv.attach`, `mpv.load`, `mpv.command`, `mpv.setProperty`, `mpv.setBounds`, `mpv.detach`, `mpv.state`, `mpv.record`, `mpv.stats` (SPEC C4 plus fix wave 1 and the player slice). Events: `player.external`, `mpv.state`.

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

- mpv: `--title=<t> [--user-agent=<ua>] [--referrer=<ref>] [--http-header-fields=Origin:<o>] --force-media-title=<t> <mpvArgs...> -- <url>`
- VLC: `--meta-title=<t> [--http-user-agent=<ua>] [--http-referrer=<ref>] [--one-instance --playlist-enqueue] <vlcArgs...> -- <url>` (VLC has no Origin option)

`--` ends option parsing in both players, so a playlist URL such as `--script=...` stays a URL. Before anything is spawned, `args::validate_play_url` checks the URL for `player.openExternal` and `mpv.load`. It rejects with `Invalid` a URL that is empty, starts with `-`, contains control characters, or has a scheme outside `http`, `https`, `rtmp`, `rtmps`, `rtsp`, `udp`, `rtp`, `mms` and `file`. Sources of kind `file` may also be local absolute paths (`C:\...`, `C:/...`, UNC, or `/...` on Unix).

`settings.playerReuseInstance` (default true): before spawning, the app closes the external player it started last (if that player is still running, it is killed and the app waits up to 3 s for it to exit). VLC also gets `--one-instance --playlist-enqueue`. `player.stopExternal` (no args, returns `{stopped}`) ends that player on demand. Players the user started outside the app are never touched.

Header flags appear only when they are set and not blank. Each flag is a single argv element, and `std::process::Command` quotes it for the platform, so titles that contain quotes or spaces arrive intact. The `Origin` value is escaped for mpv's string-list syntax (`,` becomes `\,` and `\` becomes `\\`), which is what the old app did for the MAG user agent `(KHTML, like Gecko)`.

`settings.mpvArgs` and `settings.vlcArgs` are split by `args::split_shell_args`:

- Whitespace separates arguments.
- `"..."` groups. Inside it, `\"` is a literal quote and every other backslash is kept.
- `'...'` groups with no escapes at all.
- Outside quotes, a backslash escapes only whitespace or a quote. `C:\path` and `\\server\share` stay intact.
- Quotes can appear mid-argument (`--title="A B"`), and `""` produces an empty argument.

The process runs with null stdio, `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows (its own process group on Unix), its working directory set to the player's folder, and no kill-on-drop, so it outlives the app. `player.external {state: 'started', player, title, pid}` is emitted right away, and the pid is kept for reuse and `player.stopExternal`. A watcher task then emits `{state: 'exited', ..., exitCode}`. The URL is never logged because it can contain Xtream credentials.

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
   `--wid=<hwnd> --input-ipc-server=\\.\pipe\tsrust-iptv-mpv-<our pid>-<session> --idle=yes --keep-open=yes --no-osc --no-input-default-bindings --force-window=yes --hwdec=auto-safe --input-vo-keyboard=no --no-terminal --volume=<last volume>`
   mpv creates its own video window inside ours, so moving or destroying our window moves or removes the video. The process runs with `CREATE_NO_WINDOW`, null stdio, and kill-on-drop. It is also assigned to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; the job handle is never closed, so Windows ends mpv when the app process dies, even after a crash or a Task Manager kill.
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

- `mpv.attach {bounds, volume?, muted?}`: idempotent. With a live session it only moves the window. The optional volume (clamped to 0..100) and mute are passed as `--volume` and `--mute` and stored before mpv starts, so the first `mpv.state` already carries them.
- `mpv.load {source}`: sends `["loadfile", url, "replace", -1, {force-media-title, user-agent, referrer, http-header-fields: "Origin:<o>", start: "+<resumeSeconds>"}]`. Live sources never seek. If mpv older than 0.38 rejects the 5-argument form, the command is retried as `["loadfile", url, "replace", "k=%len%v,..."]`, where `%len%` quoting keeps commas safe.
- `mpv.command {cmd}`: passes a raw command through, but only from an allowlist (`ALLOWED_COMMANDS`): `seek` (what the player UI sends), the read-only `get_property` and `get_property_string`, and the property commands below. Any other first element is Invalid, including mpv's command prefixes (`no-osd`, `osd-*`, `raw`, `expand-properties`, `async`, `sync`, `repeatable`, `nonrepeatable`, `nonscalable`), `keybind`/`keypress`, `script-*`, `run`, `loadfile`, `dump-cache` and `screenshot-to-file`. Object or array arguments are rejected.
- `mpv.setProperty {name, value}`: `set_property`, limited to `SETTABLE_PROPERTIES` (pause, volume, mute, speed, aid, sid, vid, audio-delay, sub-delay, sub-visibility, time-pos); any other name, such as `stream-record`, is Invalid. `mpv.command` applies the same allowlist to its property commands (`set`, `set_property`, `set_property_string`, `add`, `multiply`, `cycle`, `cycle-values`).
- `mpv.setBounds {bounds}`: `factory.set_bounds`.
- `mpv.detach`: sends `quit`, waits 2 s, kills the process if it is still running, destroys the window, and emits a final `{attached: false}` state. It is idempotent.
- `mpv.record {start}`: sets mpv's `stream-record` property to `<dir>/<title>-YYYYMMDD-HHMM.ts` (characters invalid in Windows file names replaced with `_`, the title cut to 80 characters, `recording` when nothing is left, a ` (n)` suffix when the name is taken), or to `""` to stop. `<dir>` is `settings.recordingsDir`, else `<downloadsDir>/recordings`, and is created when missing. Returns `{recording, path}` and updates `MpvState.recording` and `recordPath`. Loading another source or detaching stops the recording. mpv copies packets without re-encoding and starts writing at the next keyframe.
- `mpv.state`: returns the live state, or the last detached state, which keeps volume, mute, and the last error.
- `mpv.stats`: the stream info snapshot (`player/stats.rs`). It reads `STATS_PROPERTIES` (video-format, width, height, estimated-vf-fps then container-fps, video-bitrate, audio-codec-name, audio-params/channel-count, audio-bitrate, hwdec-current, frame-drop-count + decoder-frame-drop-count, demuxer-cache-duration, file-format) with concurrent `get_property` calls under a 2 s timeout. A property mpv cannot answer is left out. `hwdecKnown` tells "software decoding" (`hwdec-current` is `no`) apart from "no answer". The stream URL is never part of the reply. Errors like the other commands without a session.
- Crash handling: a watcher notices when mpv exits or the pipe closes without a detach. It waits up to 1 s for the exit code, then sets `error: "mpv stopped unexpectedly (exit code N). Start playback again to restart it."`, tears the session down, destroys the window, and emits the result.
- On other OSes every `mpv.*` command returns `Unsupported`, and the external players still work.
- Server mode (`iptv-server`): `player.detect`, `player.openExternal`, `player.stopExternal` and every `mpv.*` command return `Unsupported` ("Players run only in the desktop app"), because a browser client must not start processes on the server. `player.capabilities` still answers.
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
3. Everything in `vendor/mpv/` is gitignored except `LICENSE.txt`, the GPL licence and source notice that ships beside `mpv.exe`. That file names one specific build (mpv version and commit, FFmpeg commit, libplacebo version), so when you swap in a different build, update those lines to match it and keep the source links pointing at the same commits. `pnpm tauri:build:mpv` merges `crates/iptv-tauri/tauri.mpv.conf.json`, which bundles the whole folder, notice included, as resources beside the installed exe.
4. Check it: Settings > Players should show the detected path, and `player.capabilities` should return `embeddedMpv: true` in the desktop app.

A system mpv works too (WinGet, scoop, choco, or `PATH`), and so does a path set in Settings > Players.

## Reconnect and failover

Smart reconnect (`streamReconnect`) and live failover (`liveFailover`) sit above both the built-in engines and embedded mpv: they follow the player store and reload through each surface's `commands.retry()`. See `failover.md`.

## Tests

- `tests/player_args.rs`: shell splitting (quotes, escapes, Windows paths), mpv and VLC argv with and without headers, header escaping, embedded flags and their order, `loadfile` options, legacy `%len%` options, raw-command validation.
- `tests/player_ipc.rs`: framing (partial writes, several lines per write), reply and event parsing, concurrent `request_id` correlation, error and timeout paths, observer registration, `property-change` handling, track parsing, close handling, emitter throttling (50 updates produce at most 4 emits and the last state wins). It uses a fake mpv on `tokio::io::duplex`.
- `tests/player_detect.rs`: every search location against temp-dir layouts, plus precedence and fallbacks.
- `tests/player_rpc.rs`: exactly the 13 player names are registered; server mode refuses every player command; non-media schemes are refused; `player.stopExternal` with nothing running; reuse closing the previous external mpv; capabilities reasons; errors without a session; `player.openExternal` with `whoami.exe` as a stand-in player (the `started` then `exited` events); and, when an mpv is detectable, a real embedded end-to-end run with `--vo=null --ao=null`. That run covers attach, attach again, loading an mpv-encoded clip with resume and headers, pause, volume, seek, a blocked `quit`, an unknown property, setBounds, a crash via `taskkill` (error state, window destroyed), re-attach, attach with volume and mute, recording to `recordingsDir` (file name, state, `stream-record` property, non-empty file), `mpv.stats` on the test clip (size, codec, container, no URL), audio-delay and sub-delay round trips, and an idempotent detach.
- `tests/player_args.rs` also covers the `--` separator, the URL allowlist, VLC reuse flags, the `stream-record` IPC command, and recording file names.

## Sync, stream info and channel history (UI)

Code: `src/features/player/` (`sync.ts`, `textDelay.ts`, `streamInfo.ts`, `inlineExtras.ts`, `mpvExtras.ts`, `history.ts`, and `components/SyncMenu.tsx`, `StreamInfoPanel.tsx`, `ChannelHistory.tsx`).

- Delays: `useSyncStore` holds `audioMs` and `subMs` (100 ms steps, clamped to +/-10 s). Both go back to zero when the item (its catalog ref, or the URL for ref-less sources) or episode changes; a reconnect that swaps in a fresh Stalker link keeps them. With embedded mpv, `mpvExtras.ts` writes them as `audio-delay` / `sub-delay` (seconds) through `mpv.setProperty`, and again after each attach. Built-in engines (hls.js, Shaka, mpegts.js, native) have no audio delay, so that row is disabled with the reason as its tooltip and the shortcut shows it in the OSD. Subtitle delay shifts the cue times of the showing or hidden text tracks (`textDelay.ts`). Original times live in a WeakMap, so stepping never accumulates error, and cues added later (live WebVTT) are shifted by a 500 ms recheck that only runs while the delay is non-zero. A positive delay shows subtitles later, as in mpv.
- Stream info: `useStreamInfoStore.open` gates everything. The open panel polls the registered stats provider once a second; closed, there is no timer and no RPC. Embedded mpv provides `mpv.stats`; the inline player merges the engine's own numbers (hls.js level, Shaka variant and stats, mpegts.js media info) with the video element's size, dropped frames and buffer ahead. The panel shows the URL host only (no path, query, user or password), or "Local file" for file paths. Over embedded mpv the panel carries `data-mpv-overlay` and `data-mpv-reserved`, so the native window is cut around it, and opening or closing it remeasures the mpv layout.
- History: `history.ts` records each live source that has a catalog ref (live TV and radio, never VOD) when it starts, newest first, deduplicated, capped at 10, in memory only. B plays the most recent entry that is not the current channel. A failover hop or pin redirect replaces the channel's entry instead of adding one. The popover and the stream info panel close when playback stops or turns to radio, and Shift+B and I do nothing in radio mode, which shows neither. The popover (Shift+B or the history button) fetches now/next for the listed refs once per list, with `settings.epgOffsetMinutes`.
- Previous episode: Shift+P calls the queue's `prev()`. The series page offers the previous episode by `previousEpisode()` in `vod/lib/merge.ts`, which never crosses between specials and regular seasons.

## Sleep timer, zap banner and glass (UI, C5)

Code: `src/features/player/` (`sleepTimer.ts`, `sleepReadout.ts`, `zapBanner.ts`, `nowNext.ts`, `parentalHook.ts`, `parentalGuard.ts`, `parentalLocks.ts`, `player.css`, and `components/SleepTimer.tsx`, `ZapBanner.tsx`, `zapHooks.ts`).

- Sleep timer: `sleepTimer.ts` is a zustand store `{target, endsAt, fading}` plus extras `{warning, resolving}`. `target` is `minutes`, `programmeEnd` (the airing programme's end, looked up through `nowNext.ts`) or `episodeEnd` (the remaining duration divided by the playback speed). One `setTimeout` clock wakes for the warning (T-60 s) and the fade (T-30 s); each fade step calls `usePlayerStore.setVolume(base * remaining / span)`. `subscribeVolumeIntent` in `store.ts` tells a person's volume or mute change apart from the fade's own. A person changing the level during the fade takes the volume over: the ramp stops there and nothing is restored. A mute during the fade only silences it: the ramp holds while muted (an unmute carries on from the faded level), and the earlier level returns at the end or on Cancel with the mute kept. Expiry stops live TV, or pauses VOD and cancels Up next, then restores the base volume and toasts. Stopping playback or switching to an external player cancels the timer; an episode timer turns off when live TV replaces the item. Minute timers count wall-clock time even while paused, like a TV's; an episode timer recomputes its end from position and speed, so while paused it does not expire.
- `Z` cycles off, 15, 30, 45, 60, 90 minutes, off (`cycleSleepTimer`). From a programme or episode end, or from a countdown made by Keep watching or a zap off another timer, the next press turns the timer off. The readout after a change (`announceSleep`, `sleepTargetLabel`, `sleepLeftText`) lives in `sleepReadout.ts`, so the shortcut works without loading the timer's UI.
- Sleep UI (`components/SleepTimer.tsx`): `SleepChip` (the countdown in the control bar), `SleepMenu` and `SleepRowValue` (the options menu's submenu and row), `SleepTimerHost` (mounted once by `PlayerDock`; raises the one-minute toast with Keep watching and Cancel) and `SleepPrompt` (fullscreen and picture-in-picture only, where the top layer hides toasts).
- Zap banner: `zapBanner.ts` shows it for `ZAP_BANNER_MS` (5 s) on each live channel change. Radio, VOD and external playback are excluded, and `settings.zapBanner` (Settings > Playback) turns it off. `holdZapBanner` counts hovers on the channel title and on the banner; it lingers `ZAP_HOVER_GRACE_MS` (600 ms) after the pointer leaves. A hover hold also ends when its element stops being hoverable (`useZapHover(active)` turning false, or an unmount), since no pointerleave arrives then, and any hold ends `ZAP_HOLD_MAX_MS` (30 s) after the last pointer enter, so a lost leave cannot pin the banner. The channel number and logo come from `catalog.item`, cached for the session; now and next come from `epg.nowNext` with a 60 s cache in `nowNext.ts`, which the sleep menu shares. Over embedded mpv the banner carries `data-mpv-overlay`, so the native video is cut out under it, and the title bar dims while it is up. `useZapHover` and `useZapBannerShown` live in `components/zapHooks.ts` for the surfaces and the dock.
- Loading: `ZapBanner` and the five sleep components load through `lazyPart` (`components/lazyParts.tsx`) like the other on-demand player parts, outside the main chunk. The first player part that mounts preloads them at idle time, so they render at once when needed.
- Glass: `player-glass`, `player-glass-strong`, `player-glass-edge`, `player-on-glass-muted`, `player-scrim-top`, `player-scrim-bottom` and `player-sleep-fading` in `player.css` read the C8 glass and scrim tokens (with fallbacks) and keep animation behind the reduced-motion checks.
- Parental gate: `parentalHook.ts` `ensurePlaybackAllowed({ref, title, categoryId?})` is the one gate point. With controls off or an unlock running it lets the item through. In Ask mode it calls `ensureUnlocked` from `src/features/parental/gate.ts` (PIN prompt; see `parental.md`). In Hide mode it refuses an item the core hides, without a prompt, and `parentalLocks.ts` `notifyPlaybackHidden` drops it from the B history and the resume record and shows a toast saying why. `store.ts` `passGate` calls it before anything about the item shows and remembers the last allowed ref, so resuming or reloading the same item does not ask again. Callers pass `categoryId` when they know it (the live list, search, and the movie and series pages), so a locked category is checked without another lookup. `parentalGuard.ts` (bound by `PlayerDock`) forgets that pass on `parental.changed` with controls locked, and re-checks what is playing: Ask pauses and asks for the PIN (cancel stops), Hide stops. A zap whose neighbour is refused steps on in the same direction, skipping further locked channels without another prompt (`ZAP_SKIP_LIMIT` 50); the tuner OSD shows only after the gate passes. A core `not_found` saying "locked by parental controls" shows the parental copy, not "stream no longer exists".
