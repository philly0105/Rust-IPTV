# Screenshots

Code: `crates/iptv-core/src/screenshot/` (core and RPCs), `crates/iptv-core/src/player/embedded.rs` (the mpv command), `src/features/player/screenshot.ts` (capture and reporting), `src/features/player/components/ScreenshotButton.tsx` (the camera button). Strings: `src/i18n/<locale>/player.json`, keys `screenshot*` (19 locales). Tests: `crates/iptv-core/tests/screenshot.rs`, `src/features/player/screenshot.test.ts`, `src/features/player/screenshot.desktop.test.ts`, `src/features/player/components/ScreenshotButton.test.tsx` and `e2e/screenshot.spec.ts`.

A screenshot saves the frame of the playing video as a picture file (contract C6). There are three ways to take one:

- the camera button in the player's control bar, and on the external player's stage
- "Take screenshot" in the embedded mpv context menu
- the `S` key while a video plays

All three load `screenshot.ts` on first use, so none of the capture code is in the entry chunk.

## Where the file goes

| Mode | Destination |
| --- | --- |
| Desktop | `<Pictures>/Tsrust IPTV` (`dirs::picture_dir()`). Without a Pictures folder, or when it cannot be created or written (Windows Controlled Folder Access, for one), the core logs a warning and uses `<data_dir>/screenshots`. |
| Server mode | The browser's downloads, through an `<a download>` on a blob URL. The core is not involved. |

The file name is `<title> <YYYY-MM-DD HH-MM-SS>.png` in local time:

- The title is the item's title, then ` - <subtitle>` (the programme or episode) when there is one.
- It is trimmed and cut to 80 characters.
- Characters Windows refuses in a file name become `_` (the core uses `downloads::naming::sanitize_stem`).
- A blank title, or one with nothing but dots and spaces, becomes `Screenshot`.

On the desktop, a name that is already taken becomes `<name> (1).png`, up to `(999)`. Each candidate is claimed with `create_new`, so two saves in the same second never collide.

## RPCs

All four are desktop only. In server mode each answers `unsupported` with "Screenshots are saved to a folder only in the desktop app."

| Command | Args | Result |
| --- | --- | --- |
| `screenshot.save` | `{ dataBase64, format: 'png' \| 'jpeg', title? }` | `{ path, fileName }`. Writes the image the web view captured. |
| `screenshot.mpv` | `{ title?, withSubtitles? = true }` | `{ path, fileName }`. Embedded mpv writes the frame it shows. |
| `screenshot.open` | `{ path }` | Opens a saved screenshot in the system's image viewer. |
| `screenshot.reveal` | `{ path? }` | Opens the screenshot folder, selecting `path` when given. |

`screenshot.save` refuses the following, each as `invalid`, and writes nothing:

- empty data
- data that is not base64, which may also arrive as a `data:image/...;base64,` URL
- more than 25 MB once decoded; the size is checked from the encoded length before decoding
- bytes that do not start with the PNG or JPEG magic bytes for `format`

A partly written file is removed.

`screenshot.mpv`:

- The core claims the file name first, by creating an empty placeholder, then sends `["screenshot-to-file", <path>, "subtitles" | "video"]` (`player::embedded::screenshot_command`). `ALLOWED_COMMANDS` is unchanged: the core sends the command itself, and the web view cannot send it through `mpv.command`.
- It answers `conflict` when there is no attached session, nothing is loaded, or the loaded item has tracks but no video track (radio, audio only).
- If mpv times out, the core waits up to 10 s more for the file to appear and stop growing.
- An empty file after a reported success is an error.
- On any failure the placeholder is removed.

`screenshot.open` and `screenshot.reveal` accept only a `.png`, `.jpg` or `.jpeg` file inside the screenshot folder or the fallback folder:

- The path is checked lexically (absolute, `..` resolved, case-insensitive on Windows) before any file system access.
- It is checked again after `canonicalize`, so a symlink or junction cannot lead outside.
- A `:` in the file name (an NTFS alternate data stream) is refused.
- A file that no longer exists answers `not_found`. `screenshot.reveal` then just opens the folder.

Tests use `screenshot::set_folder_override` so nothing is written to the real Pictures folder.

## Capture in the UI

`takeScreenshot()` never rejects. Every outcome is shown twice:

- as a toast
- on the player's OSD, because toasts portal into `document.body` and cannot be seen while the player is in element fullscreen

A second press while a capture is running is ignored.

| Player | Path |
| --- | --- |
| Embedded mpv | `screenshot.mpv` with subtitles. The toast says "Screenshot saved" with the file name and an Open action (`screenshot.open`). |
| Built-in player, desktop | `<video data-player-video>` (InlinePlayer marks it) is drawn on a canvas at the stream's own size and encoded as PNG. A PNG over 25 MB is sent as JPEG (quality 0.92) instead. The base64 goes to `screenshot.save`; the toast is the same as for mpv. |
| Built-in player, server mode | The same canvas capture, downloaded under the name above. The toast says "Saved to your downloads" with the file name. |
| External player | The camera stays on the stage, `aria-disabled`, with the reason: "This plays in an external player. Use its own screenshot key." The `S` shortcut is off. |
| Radio | The camera is `aria-disabled` with "Radio has no picture to capture." The `S` shortcut is off. |

A disabled camera stays focusable. Its tooltip and `aria-describedby` give the reason, and pressing it shows the reason as an info toast and on the OSD.

Built-in player failures, each a toast titled "Screenshot not saved" that names the cause:

- No frame decoded yet (`readyState < 2` or no video size): "There is no picture yet. Try again once the video plays."
- A frame from another origin without CORS taints the canvas, and encoding it throws a `SecurityError`. The toast says the stream's server does not allow its picture to be copied. On the desktop it adds that embedded MPV can capture it, because mpv reads the stream itself.
  - Streams played through hls.js (MSE) are never tainted.
  - In server mode the app's own proxy (`/api/proxy`) is the page's origin, so a proxied stream is not tainted either.
  - A direct MP4 or TS file from another origin is, because the `<video>` has no `crossorigin` attribute. On the desktop that includes the loopback media proxy.
- An RPC error shows the core's message.

The canvas capture contains what the `<video>` decodes. Subtitles the app draws in the DOM are not part of it; mpv screenshots include subtitles.

## Keyboard

`S` is registered in `usePlaybackShortcuts` (area Playback) with `guard('letter')`. It is enabled only while a video plays in the app, so not for radio, external players or when nothing plays.

Some focused elements keep their own `S`, and the shell registry skips events they already handled:

- a Live channel list row (favourite)
- a multi-view tile (swap)
- a focused VOD grid (My List)

Text fields and modified keys (Ctrl, Alt, Meta) never take a screenshot.

## Entry chunk

`ScreenshotButton` is a `lazyPart` with a same-size placeholder, and the shortcut imports `screenshot.ts` dynamically. Only the following are in the entry chunk:

- the shortcut registration
- the lazy part declaration
- the `data-player-video` marker
- the English strings

## Limits

- The built-in player has no custom context menu, so "Take screenshot" in a menu exists only over embedded mpv. The button and `S` work in both.
- The compact (mini) bar has no camera. `S` still works there.
- A server-mode screenshot of a tainted stream cannot be taken: there is no core path to fall back to.
