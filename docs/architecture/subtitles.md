# Subtitles

Subtitle files and the subtitle look, for the built-in player and embedded mpv (Run 2 contract C6). External players (mpv, VLC in their own windows) keep their own subtitle handling.

## Files

| Part | Path |
| --- | --- |
| Parser | `src/features/player/subtitles/parse.ts` |
| Style mapping | `src/features/player/subtitles/style.ts` |
| File tracks on the media element | `src/features/player/subtitles/tracks.ts` |
| Subtitle overlay: draws every track (lazy) | `src/features/player/subtitles/inline.ts` |
| Loading a file (lazy) | `src/features/player/subtitles/load.ts` |
| Menu and compact style view (lazy) | `src/features/player/components/SubtitleMenu.tsx` |
| Controls shared with the settings page | `src/features/player/components/SubtitleStyleFields.tsx` |
| Settings group | `src/features/settings/sections/PlaybackSection.tsx` |
| mpv command and property checks | `crates/iptv-core/src/player/embedded.rs`, `player/rpc.rs` |

## Parser

`parseSubtitles(text, format)` returns `SubtitleCue {start, end, text}` (seconds, plain text with `\n` line breaks) and throws `SubtitleParseError` when no cue can be read. `detectFormat(fileName, text)` looks at the content first (`WEBVTT`, `[Script Info]`, `[V4+ Styles]` or `[Events]`), then the extension, then any SRT timing line, so a mislabelled file still loads.

- SRT and WebVTT share one block parser. Timestamps may leave out the hour, and the fraction may use `,` or `.`. Cue settings after the timing, cue ids, `NOTE` blocks, HTML-style tags (`<i>`, `<font>`, `<c.x>`, `<v Name>`, inline timestamps) and `{\an8}` codes are dropped, and entities are decoded. A timing line with no blank line before it starts a new cue, so damaged files still split correctly.
- ASS and SSA read only `Dialogue:` lines in `[Events]`, in the field order of the section's `Format:` line. The text is the last field and may contain commas. Override blocks are removed, `\p1` drawings are skipped until `\p0`, `\N` and `\n` become line breaks and `\h` becomes a hard space. Cues are sorted by start time.
- A cue whose end is not after its start, or whose text is empty once cleaned, is skipped.

All markup is stripped on purpose. Every format then takes the user's subtitle look, the same way in both players.

## Built-in player

"Load subtitle file…" in the Subtitles menu opens a hidden `<input type="file" accept=".srt,.vtt,.ass,.ssa">` (`data-testid="subtitle-file-input"`). The file is checked against `MAX_SUBTITLE_BYTES` (5 MB), read with `readFileText` (which detects the encoding), then detected and parsed. The cues go into `el.addTextTrack('subtitles', fileName)` as `VTTCue`s, with the text escaped as WebVTT markup, and that track is turned on.

### Drawn by the player

The player draws every subtitle track itself (engine tracks and files). Edge and WebView2 (the desktop app's runtime) paint native cues with the Windows caption theme through a browser default rule, `video::cue { background-color: rgba(0,0,0,0.75) !important; color: #fff !important; font-size: 100% !important }`. A browser `!important` rule beats any page CSS, so a `video::cue` rule cannot set the user's colour, size or background there (only the position works). Chrome and Playwright's Chromium do not mark that rule `!important`, so a check of `::cue` styles passes there and proves nothing.

- `inline.ts` (`bindSubtitleOverlay(el, box)`, loaded lazily for video) takes over every subtitle or captions track that turns `showing`: it adds the track to the drawn set (`tracks.ts` `drawTrack`) and sets it to `hidden`. A hidden track keeps its cues, `activeCues` and `cuechange` events, but the browser draws nothing.
- On `cuechange`, on a track change, added or removed, and on a settings change, the overlay draws the active cues of the drawn hidden tracks into `box`: one block per cue, a `span.player-sub-cue` with `dir="auto"` (right-to-left lines read right to left) and the browser's own parse of the cue (`getCueAsHTML()`, which builds nodes and never parses HTML). Without it, the cue text with its WebVTT tags removed is set as plain text. `white-space: pre-line` keeps the line breaks.
- A drawn track that turns `disabled` leaves the set (`releaseTrack`). Any other `hidden` track (hls.js and shaka keep the selected track hidden while subtitles are off) is not drawn.
- "On" for the menu is `isShownTrack`: `showing`, or `hidden` and drawn. The native engine and `withExternal` use it. hls.js reads its hidden track as "subtitles off" (`subtitleDisplay` turns false), so the hls engine keeps its own `textOn`. shaka does the same; its engine keeps `textOn`, sets `streaming.alwaysStreamText` so cues keep coming while its track is hidden, and turns Off with `hideDrawnTracks(el)`, because its Off only hides the track.
- InlinePlayer renders the empty overlay (`div.player-subs[data-subtitle-overlay]`, `aria-hidden`) right after the `<video>`, so it sits above the picture and below the controls, and `pointer-events: none` keeps it out of the way of clicks.
- The browser's picture-in-picture window shows the video, not the page's overlay. While the video is in it (`enterpictureinpicture`, or `document.pictureInPictureElement` is the video when the overlay binds), the drawn tracks go back to `showing` (`showDrawnTracks`) and the browser draws them in that window, in the system caption style, and the overlay is hidden. They stay in the drawn set, so the menu still shows them as on. A track turned on there stays `showing`; one turned `disabled` or `hidden` (hls.js hides its track on Off) leaves the set, so Off in picture-in-picture stays off. On `leavepictureinpicture` the overlay takes the `showing` tracks over again. The embedded mpv player's PiP (`pip.ts`) shrinks the app window instead and mpv draws its own subtitles, so the overlay is not involved there.

- `tracks.ts` remembers the file tracks of each element. A loaded file is listed as `ext:<n>` after the engine's own tracks. `withExternal()` builds the list the media store publishes. While a file shows, no engine track is marked selected.
- `selectText(el, engine, id)` serves `MediaCommands.setText` in InlinePlayer. Picking a file turns the engine's subtitles off (`engine.setText(null)`) and disables the other files. Picking an engine track, or Off, disables every file.
- Engines leave file tracks out of their own lists: the native engine skips them through `isExternalTrack`. hls.js and shaka only enumerate their own tracks.
- Tracks cannot be removed from a media element, so a new item calls `clearExternal`, which removes the cues and disables the tracks.
- The subtitle delay (`useSyncStore.subMs`) shifts file tracks like any other text track (textDelay.ts).
- Errors show a toast naming the file and the reason: larger than 5 MB, not an SRT/WebVTT/ASS file, no subtitle lines, or unreadable. With no video showing (radio, nothing playing), the toast says to start a video first.

## Embedded mpv

The menu entry opens the native dialog (`pickPathDesktop({extensions: ['srt','vtt','ass','ssa'], filterName})`) and sends the path to `mpv.addSubtitle {path}`. The core checks the path before it touches the session:

- it must be absolute;
- it must have a subtitle extension (case-insensitive);
- it must be an existing regular file of 5 MB or less.

Anything else is `Invalid`, so URLs and mpv protocols cannot get through. With nothing loaded, the command returns `Conflict`. Otherwise the core runs `sub-add <path> select <file name>`. An untitled external track is listed under its file name (`mpv_state::parse_tracks`). `sub-add` stays off the raw `mpv.command` allowlist.

## Style

Four settings: `subtitleSize` (small, medium, large, xlarge), `subtitleColor` (white, yellow, cyan, green), `subtitleBackground` (shadow, box, solid) and `subtitlePosition` (0..=40). `style.ts` maps them for both players. Unknown values fall back to medium, white, box and 0.

| Setting | Built-in player (`cueCssVars`) | mpv (`mpvSubtitleProperties`) |
| --- | --- | --- |
| Size 0.8 / 1 / 1.25 / 1.5 | `--sub-scale` | `sub-scale` |
| Colour #FFFFFF / #FFE600 / #00E5FF / #7CFF4F | `--sub-color` | `sub-color` |
| Shadow | `--sub-bg: transparent`, `--sub-shadow` halo | `sub-border-style=outline-and-shadow`, `sub-back-color=#C0000000`, border 2, shadow offset 1 |
| Box | `--sub-bg: rgb(0 0 0 / .72)` | `sub-border-style=background-box`, `sub-back-color=#B8000000`, border 3, shadow 0 |
| Solid | `--sub-bg: rgb(0 0 0)` | `background-box`, `sub-back-color=#FF000000`, border 3, shadow 0 |
| Position p | the overlay's line container: `bottom` at `100 - cueLine(p)` percent, that is `10 + p` (`cueLine(p) = 90 - p`) | `sub-pos = 100 - p` |

mpv also gets `sub-ass-override=scale`, so ASS files keep their own styling except for the size.

- PlayerDock sets the CSS variables on the persistent `[data-player-host]` node, and `player.css` reads them in `.player-sub-cue`, the overlay's cue. The overlay is a size container, so the font size follows the player, not the window: `clamp(14px, 2.4cqw, 28px) * var(--sub-scale)`. A `video::cue` rule with the same variables stays as a fallback for the moment before the overlay takes a track over.
- File cues are still created at `line = cueLine(p)` (`snapToLines=false`, `lineAlign='end'`), so a track that is ever drawn natively sits at the same height.
- MpvSurface calls `sendSubtitleStyle()` after each successful `mpv.load`. `bindMpvExtras` sends the style once mpv is attached and again whenever the style settings change. Each property is sent separately, so an mpv that lacks one property still takes the others.
- The core checks each style property in `mpv.setProperty` and in property commands:
  - `sub-scale` 0.5..=3;
  - `sub-color` and `sub-back-color` `#RRGGBB` or `#AARRGGBB`;
  - `sub-border-style` one of the three mpv styles;
  - `sub-border-size` and `sub-shadow-offset` 0..=10;
  - `sub-pos` a whole number in 0..=150;
  - `sub-ass-override` one of no, yes, scale, force or strip.

  Only plain `set` commands may change them (no add, multiply or cycle).

## UI

- The Subtitles row in the options menu (Controls) and in embedded mpv's context menu (VideoContextMenu) is always shown. Its submenu lists Off, the stream's tracks and loaded files, then "Load subtitle file…" and "Subtitle style…". With no tracks, a line says the stream has none.
- "Subtitle style…" is a compact view of the same four settings: radio groups with roving focus (Left/Right mirror in right-to-left text, Home/End) and the position slider. A choice is shown at once through the player's settings cache and written with `settings.update`. A failed write puts the old value back and shows a toast. The slider previews while it moves and saves once when the drag or key press ends. Escape or Back returns to the track list.
- A menu may hold only menu items, so the style view (radio groups, a slider and its live readout) is not a menu: in the same frame, its container turns into a dialog labelled "Subtitle style" (`role="dialog"`), and its Back and Close are plain buttons. In the menu views, Back and Close are `menuitem`s. The same goes for VideoContextMenu's style view.
- Up and Down move between rows in both views (the frame takes them). In the menu's style view the slider lets them through and keeps Left/Right, Home/End and Page keys; on the settings page the slider keeps every arrow.
- The options menu floats over the picture and grows up from the control bar. Its height is capped at the room between its bottom edge and the app header (the top of the screen in fullscreen), measured when a view opens, on resize and on fullscreen changes (`roomAbove` in Controls), so every view stays below the header and scrolls inside the frame. In the 390 px inline player that is about 90 to 115 px. The dock variant (embedded mpv) grows the dock instead and is not capped this way.
- A file over the limit is named by its size in the limit's unit, rounded up to hundredths (`oversizeText`): a 5,243,018-byte file reads "5.01 MB", never "5 MB".
- Settings, Playback, "Subtitles" group: the same controls with labels and hints, above a 16:9 preview. The preview's sample line uses the same variables, scale and position as the player, and follows the slider before it is saved.
- `Shift+C` (Playback area, video only) opens the options menu at the Subtitles submenu. `usePlaybackShortcuts` sets `media.subtitleMenuAt`, and Controls consumes it.
- The menu, the style view, the loader and the cue placement load lazily (lazyParts and dynamic imports). Only `style.ts`, `tracks.ts` and the wiring are in the entry chunk.
- Strings live in `player.json`: `subtitle*` for the menu and toasts, `subtitleStyle.*` for the style controls and the settings group.

## Tests

- `src/features/player/subtitles/parse.test.ts`: timestamps, detection, SRT/WebVTT/ASS parsing, markup stripping, bad input, and the e2e fixtures.
- `style.test.ts`: every option through `cueCssVars` and `mpvSubtitleProperties`, `cueLine`, and the fallbacks.
- `inline.test.ts`: the overlay takes a showing track over, draws active cues as safe text with `dir="auto"` or from `getCueAsHTML`, follows `cuechange`, lets a disabled track go, ignores an engine's own hidden track, and moves with the position setting; in picture-in-picture the track that is on shows natively with the overlay hidden, is drawn again after leaving, a track turned on there is drawn after leaving, Off there (disabled, hidden by hls.js, or `hideDrawnTracks`) stays off, and binding while already in picture-in-picture shows the drawn track natively.
- `engines.test.ts`: the native engine reports a drawn (hidden) track as on and an engine-hidden one as off, and keeps reporting the track as on across picture-in-picture, while Off there stays off after leaving.
- `components/menuFit.test.ts`: `roomAbove` below the header, at the window top, never negative.
- `external.test.tsx`:
  - file tracks, selection and clearing;
  - the file listed in the Subtitles menu;
  - the compact style view as a labelled dialog, Up/Down leaving the slider, Back and Close as menu items;
  - Shift+C;
  - file errors and the size of a file over the limit;
  - the mpv path flow.
- `crates/iptv-core/tests/player_args.rs` and `player_rpc.rs`: the property value checks, `sub-add` refused as a raw command, path checks, and `mpv.addSubtitle` registered and refusing bad files before the session.
- `e2e/subtitles.spec.ts` with `e2e/fixtures/subtitles/`:
  - the settings preview and saved values;
  - SRT, WebVTT and ASS loads in the built-in player, with the drawn cue's computed colour, background, font size and position checked (not the host variables);
  - Off and Shift+C;
  - a broken file;
  - the menu's style view;
  - at 390 and 1280 px, the inline player's menu views (root, Subtitles, style) stay below the header and scroll, and Off takes a click.
