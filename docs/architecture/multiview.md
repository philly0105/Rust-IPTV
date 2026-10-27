# Multi-view

`src/features/multiview/` is the wall: two to four live channels playing at once at `/multiview`, one of them with sound. It is frontend only. Each tile resolves its stream the same way the main player does and plays it on its own `<video>`; the core sees ordinary stream requests and the wall's playback report (see Downloads). Contract C4.

## Public surface (`index.ts`)

| Export | What it is |
| --- | --- |
| `multiviewRoutes`, `MULTIVIEW_PATH` | One lazy route, `/multiview` → `MultiviewPage`. The app router mounts it. |
| `useMultiviewStore` | The persisted wall (below). |
| `useMultiviewMenuItem(ch)` | A `MenuAction` "Add to multi-view" for channel context menus. Disabled for `null` and for anything that is not live TV. It runs the parental gate, adds the channel, and navigates to `/multiview`. If the channel is already on the wall or the wall is full, it shows a toast with an "Open multi-view" action. A cancelled PIN prompt does nothing. A failed gate check shows an error toast. |
| `addToWall(ch)`, `wallAccepts(ch)` | The same add without the menu, for callers with their own UI. Returns `added`, `duplicate`, `full`, `unsupported`, `cancelled` or `gateFailed`. |
| `MAX_TILES` | 4. |
| Types | `MultiviewTile`, `MultiviewLayout`, `MultiviewState`, `MultiviewChannelInput`, `MultiviewAddResult`, `AddOutcome`. |

`MultiviewChannelInput` is `{ref, title, number?, logo?, categoryId?}`. `categoryId` only feeds the parental check (a locked group locks its channels); the tile keeps `{key, ref, title, number?, logo?}`.

## Store

The wall lives in `store.ts`, a zustand store persisted to localStorage `tsrust.multiview` as `{v: 1, tiles, layout, audioKey}`. The entry is removed when the wall is empty and in the default layout. The wall's audio preferences are stored separately in `tsrust.multiview.audio` as `{volume, muted}`.

Every action keeps these invariants:

- Tile count: at most four tiles, and no channel twice. Two refs are the same channel when source, content type and item id match.
- Layout fit: the layout holds every tile. A third tile on `1x2` switches to `2x2`, and `1x2` cannot be chosen while more than two tiles are up.
- Sound: exactly one tile has the sound while the wall has any tiles. The first tile added gets it. A swap keeps the sound with its channel. Closing the tile with sound hands it to the first tile left.
- Parsing: the stored entry is parsed defensively. Bad refs, duplicates, missing keys and a fifth tile are dropped, and a layout that no longer fits is replaced. Corrupt JSON reads as an empty wall.

Actions: `add`, `remove`, `replace` (keeps the tile key and slot, refuses a channel on another tile), `swap`, `setAudio`, `setLayout`, `clear`.

A tile saved without a logo (a wall from an older version, or one added where only the name was known) gets its channel's logo once the page is open: `useTileLogoBackfill` (`useWallData.ts`) asks `catalog.item` for those tiles, under the same query key as the channel pickers, and `fillTileLogo` writes the logo into the tile, so it is saved with the wall. A tile that has a logo keeps it, and is not asked about.

Undo helpers for the toasts:

- `reinsertTile(tile, index, hadSound)`: refused when the wall is full or the channel is back.
- `snapshotWall()` / `restoreClearedWall(snapshot)`: merges with any channels added since the clear.

## Layouts

`layout.ts` defines three layouts:

| Layout | Slots | Arrangement |
| --- | --- | --- |
| `1x2` | 2 | Side by side. |
| `2x2` | 4 | A grid of four. |
| `1+3` | 4 | One large slot spanning three rows, with three small slots beside it. |

The arrangement is set with container queries on the stage, not the viewport:

- Below `@2xl` (42rem), every layout stacks as a single 16:9 column. The grid then sizes to its content (`WALL_BASE`: `self-start content-start`) and the stage scrolls. Left to stretch, the grid would take the stage's height and split it into rows shorter or taller than the 16:9 slots, so slots would overlap or float apart. Slots drop `min-h-0` below `@2xl` for the same reason: their 16:9 height, or their content if taller, sizes the row. Stacked, only the next free slot is drawn, at its content's height (`FreeSlot`): its quick picks, or a 56 px "Add channel" row (on an empty wall, the how-it-works line above the plus and "Add channel", since the phone toolbar has no room for it); the free slots after it, which on a phone were screens of dashed 16:9 frames, show only on a fitted wall, where they give the layout its shape. Arrow keys, Home and End skip slots that are not drawn (`slotTargets`). The layout choice shows its names only on a stage of 64rem or more, where the whole toolbar still fits one row with them; narrower (a tablet), the segments are their glyphs, named in tooltips. The toolbar leaves out the layout choice below a 45rem stage (the wall's 42rem plus its gutters), since every layout is the same column there; L still cycles the layouts.
- `1+3` puts the large slot across the top with the three small slots in a row beneath it from `@2xl`, and switches to the large slot on the start side with the three small slots stacked beside it from `@5xl` (64rem).

The stage height bounds the grid (`[container-type:size]`), so tiles never push the page into horizontal scroll from 390 to 1920 px.

`neighbour(boxes, from, direction)` drives arrow-key focus:

- It works on the measured boxes of the slots, not their order. The large `1+3` slot therefore moves right to the small slot level with its middle.
- Right-to-left layouts mirror for free.
- Slots that were not measured are skipped.

## Tiles

Each tile is a `Tile` component with its own playback hook, `useTilePlayback`. A tile resolves its source through `stream.ts`, which wraps the player's `resolveSource`. The tile then creates its own engine through `engine.ts`, a re-export of the player's hls.js / shaka / mpegts.js / native engines, attached to its own element, with the `tile` buffer profile: a few seconds of back buffer, and hls.js renditions capped at the tile's size ([players.md](players.md#built-in-engines-ui)). Nothing is shared between tiles, so one failure stays in its tile. What the engines remember is shared with the main player: an extensionless live channel starts in mpegts.js, and its source's host is remembered as MPEG-TS or not.

A tile's first start waits `slot × TILE_START_STAGGER_MS` (32 ms), so tiles that start together (the wall opening, a parental check answering) start in slot order, 32 ms apart. Each engine's parse and media attach then gets its own frames instead of all of them landing in one long task. The first slot starts at once, and so do later rebuilds of a tile (Retry, replace).

| Phase | Shown | Notes |
| --- | --- | --- |
| `resolving` / `loading` | "Tuning" with the channel mark | |
| `playing` | The video, with a "Buffering" pill while it waits for data | |
| `error` | A panel with the class headline, one line of next step, Retry and Replace | The tile fails on a lookup error, an engine or element error, no frame within 25 s (`START_TIMEOUT_MS`), or waiting for data for 30 s (`STALL_TIMEOUT_MS`). Retry rebuilds only this tile. Offline, network and timeout errors also retry by themselves when the browser comes back online. |
| `locked` | A lock panel instead of playback; no stream is requested | See Parental controls. |

A stream the server refuses fails at once with the reason. The media element hides the HTTP status and reports a refusal (a 503, a 404) as a network or unsupported error. An extensionless stream the element rejects as unsupported goes straight to its single retry through mpegts.js, with no request first: mpegts.js sees a refusal's status and asks the app's own server for the reason itself. That retry is skipped when the element only took over because mpegts.js had found no MPEG-TS. Any other element error makes the tile ask the app's own server why (`fetchFailureReason`, one GET), and an answer with a reason fails the tile with it. A tile on mpegts.js fails at once on an HTTP status too, since the player's mpegts.js engine no longer restarts on one ([failover.md](failover.md#starting-a-stream)).

A live stream that ends fails the tile, unless it plays in mpegts.js. Under Auto that is every Xtream channel in a browser with MSE (the panel's `.ts` URL). When the panel closes a live MPEG-TS connection, mpegts.js ends the MediaSource and the element fires `ended`; the engine reconnects it (up to `TS_MAX_RESTARTS` times, [players.md](players.md#built-in-engines-ui)) and reports through its error callback once they run out, which fails the tile. Before, the tile failed on `ended` itself, which destroyed the engine before its reconnect ran, so the tile sat in its error panel until Retry.

The player's `classifyStreamError` classifies failures. The copy is the wall's own (`errors.ts`). When an account has more tiles than connections, failures of classes `auth`, `server`, `network`, `timeout`, `generic` and `notFound` on that account's tiles read as "Connection limit reached".

Sound:

- Only the tile with sound is unmuted. Its volume is the wall volume, and "mute the wall" mutes it too.
- Some browsers refuse sound before the first gesture, for example after a reload straight into the wall. The tile then plays muted with "Click for sound", and the next click or key turns sound on.

Chrome follows the broadcast multiviewer pattern:

- A label strip along the bottom shows the slot plate, logo, number, name and the current programme from `epg.nowNext`.
- The tile with sound gets a tally: an accent edge and a lit slot plate.
- Tool buttons sit at the top end: listen, move, replace and close. They appear on hover and focus, and always on touch screens.
- The chrome is glass on video: C8 tokens (`--color-glass*`, `--color-on-glass`) with `var()` fallbacks. The label strip and pills, on screen all the time over up to four videos, use the solid `GLASS` (strong fill, no blur); only the hover tools and the error and lock panels use `GLASS_BLUR` (`glass-blur`, Run 3 C5). Both are in `styles.ts`.
- Panels with actions (error, lock, lock-check failure, source removed) are centred in the band above the label strip, so the strip never covers their buttons. Every slot is 16:9, so the tile's width (`@container/tile`) also gives its height, and the panel grows in steps: below 20rem the icon sits beside the headline and the help line is left out; from 20rem the icon stands above it; from 26rem the help line shows.

## Downloads

Opening the wall stops the main player, which clears its `downloads.playback` report, so the wall reports for itself (`wallReport.ts`, its own client id). Every tile that is not locked counts from the start of its lookup until it fails or goes, one entry per tile, so two tiles on one source count two connections of it: downloads from that source leave the wall what its account allows and yield when a tile needs a connection ([downloads.md](downloads.md#connections)). Tiles that change together (the wall opening, a clear) send one report; it is renewed every 30 s while any tile counts and cleared when the last one stops. A tile that loads from the provider directly (the browser without the media proxy) waits for the core's answer to the report naming its source, at most 3 s, before it creates its engine; a stream through the proxy goes on at once, since the proxy makes room itself.

## Page

`MultiviewPage` states:

| Wall | Sources | Shown |
| --- | --- | --- |
| Empty | Loading | A skeleton. |
| Empty | Load failed | `ErrorState` with retry. |
| Empty | None | `EmptyState` linking to `/sources`. |
| Empty | Present | The toolbar with layouts and add, and the free frames. The header's subtitle says what the page does, and the toolbar says how the wall works where sound, full screen and clear go once a tile is up. On a stacked wall (a stage under 45rem) the toolbar has no room for the line, so the first frame shows it above its quick picks instead; either way it is the first frame's description for screen readers. |
| Has tiles | | The toolbar (layouts, add, mute, volume, full screen, clear), banners and the wall. |

The toolbar is there from the first visit, so the layout choice keeps its place and look when the first tile goes up; mute, volume, full screen and clear join it with the first tile.

Behaviour:

- Banners:
  - Connection limit, per source. The page reads `account.status` for every Xtream source with a tile on the wall, without waiting for the tiles' parental checks. Putting a channel on the wall (`addToWall`, `replaceOnWall`) also asks its Xtream account ahead (`prefetchAccountStatus` in `accountStatus.ts`, sharing the page's query), so the wall opens with the banner in place instead of the banner pushing the tiles down when the answer comes. A source with `maxConnections > 0` and more tiles than that gets a dismissable warning naming the source, its limit and its tile count. The dismissal lasts until the count changes.
  - Main player. Opening `/multiview` stops the in-app main player, whether or not the wall has tiles yet, and so does putting the first tile on an empty wall. External mpv or VLC is left alone. During the first 5 s a restored session that starts playing is stopped too. After that, playback the user starts on purpose keeps playing: on a wall with tiles, the wall goes quiet and a banner offers to stop the main player.
- Missing source: a tile whose source was removed shows "Source removed" with Replace and Close.
- Full screen covers the whole stage through the Fullscreen API. On the desktop the shell mirrors the window. In full screen the toolbar and banners float over the wall and hide after 2.5 s without pointer or key activity. Toasts, dialogs and menus portal into the full-screen element while one is set (`src/ui/portal.ts`), so the Undo toast shows over the wall in full screen. The picker and the PIN prompt still leave full screen first (`openPicker` and `unlock` in `MultiviewPage`).
- Picker: `ChannelPicker` is a dialog. Choose a source and browse its live channels (all of them, a group, Favorites, Recently watched or a custom list), or search across sources with `catalog.search`. A query searches inside what is shown: a group through `catalog.channels` with `query.search`, a view by channel name, and all channels through `catalog.search`. "Show more" reads the next 60 rows at their offset (the core answers at most 1000 rows a read), and now/next is asked for each page of rows once. The browsing is `useChannelBrowse` (`src/features/live/hooks`), which a custom list's "Add channels" dialog uses too. Rows already on the wall show their slot. In add mode it stays open for several picks, and it warns when the wall is full or a source is already at its connection limit. Under "All sources" the warning names every source at its limit, and the rows of those sources carry a warning mark ("Connection limit reached", also in the row's accessible name). In replace mode it puts the pick on one tile; picking from the replaced tile's own source adds no connection, so that source is not warned about.
- Quick picks (`quickPicks.ts`, `FreeSlot`): the next free slot (tiles fill the slots in order, so it is the one a new channel lands in) lists up to three (`QUICK_PICKS`) recent, then favorite live channels that are not on the wall, each put up with one click through the same checks and parental gate as the picker, and "More channels…" for the picker; focus moves to the new tile. Channels whose names match after NFKC, trimming, collapsed spaces and lower case (`pickName`) show once, as the first found, and a channel whose name matches a tile is left out too. A fitted slot's width also sets its height, so a small slot keeps fewer rows: with a mouse two from 16rem of slot width and three from 21rem, and with 44 px touch rows two from 20rem and three from 26rem; stacked, the slot grows with its rows and keeps them all. Under 16rem a row would show only a few letters of a name (IPTV names share their first ones, as in "US| NBA TV FHD" and "US| NBC FHD"), so the slot is a plain "Add channel" frame there, like the others. The rows start after the slot number where they would reach it, and otherwise use the slot's full width. A click on the frame around the rows opens the picker, as on the other free frames, and the frame lights up the same way except while the pointer is on a row. Until both Recent and Favorites have answered, the slot shows row-height placeholders (`aria-hidden`, one pulse) above "More channels…". With nothing to offer, the next slot is a plain frame like the others: one button that opens the picker.
- Focus after "Add to multi-view": the menu item navigates with the new tile's key in the route state, and the page focuses that tile's main button, so a keyboard user lands on the tile they added.
- Undo: closing a tile or clearing the wall shows a toast with Undo.
- Screen readers: layout changes, sound moves, swaps and closes are announced in a polite live region.

## Parental controls

- Adding through the picker, the menu item, `addToWall` or a replace calls `ensureUnlocked` with the channel first.
  - In ask mode this opens the PIN prompt.
  - Cancelling adds nothing.
  - A check that fails also adds nothing, and says so.
- Tiles already on the wall are checked again with `parental.check` whenever parental controls are active, so a wall saved before a lock stays locked.
  - A locked tile requests no stream and shows "Locked channel" (ask mode) or "Hidden by parental controls" (hide mode), each with Unlock.
  - In hide mode, Unlock opens a PIN prompt that calls `parental.unlock`. In ask mode it uses `ensureUnlocked`.
  - A check that fails keeps the tile dark with a retry (fail closed).

## Keyboard

Registered with the shell's shortcut registry (area "Multi-view", so they list in the `?` overlay):

| Key | Action |
| --- | --- |
| `1`–`4` | Give the sound to that tile. |
| `F` | Full screen for the wall. |
| `M` | Mute or unmute the wall. |
| `L` | Next layout that holds the tiles. |
| `A` | Add a channel (opens the picker). |
| `Esc` | Cancel a tile move (only while moving). |

Inside the wall, on the focused tile (handled by the wall itself, not the registry):

| Key | Action | Overlay `descKey` |
| --- | --- | --- |
| Arrows | Move focus to the neighbouring tile or empty slot. | `multiview:shortcutFocusMove` |
| `Home` / `End` | Move focus to the first or last slot. | `multiview:shortcutFocusEnds` |
| `Enter` / `Space` | Give the focused tile the sound. | `multiview:shortcutGiveSound` |
| `Delete` / `Backspace` | Close the focused tile. | `multiview:shortcutCloseTile` |
| `R` | Replace the focused tile's channel. | `multiview:shortcutReplaceTile` |
| `S` | Start a move. On another tile, `S` or `Enter` swaps the two; on the same tile it cancels. | `multiview:shortcutSwapTile` |

These keys are not in the registry, so the `?` overlay only shows them if they are listed in `DOCUMENTED_SHORTCUTS` with the `descKey`s above, under an area that maps to `multiview:shortcutArea`.

Tiles can also be dragged onto each other to swap. Focus is always visible: an inset ring on the tile, and the shared focus ring on controls.

## Strings

All copy is in the `multiview` namespace, in all 19 locales. The shared Close, Cancel and Retry labels come from `common`. There are two plurals, `limitBody` (count = the account limit) and `pickerResults`, and each locale carries its CLDR categories.

## Tests

- `src/features/multiview/test/store.test.ts` covers the store: limits, duplicates, layout fit, sound hand-off, swap, replace, persistence and defensive parsing, undo, and audio preferences.
- `layout.test.ts` covers layout capacity and fitting, the layout cycle, the wall classes, and arrow-key neighbours: the grid, `1+3`, a stacked column, right-to-left and unmeasured slots.
- `wall.test.tsx` renders the page with a fake engine and checks:
  - one tile with sound, clicks and number keys;
  - failure isolation, where one failing tile leaves the other engines untouched and Retry rebuilds only it;
  - keyboard focus, close, replace and swap;
  - parental locks, the connection-limit banner (with `account.status` read when a channel is added), and the empty, loading and no-source states;
  - staggered tile starts and the quick-picks skeleton;
  - the picker add flow.
- `wallReport.test.tsx` covers the wall's playback report: one entry per playing tile in one report for tiles that start together, a closed or locked tile dropped from it, renewal, the clear when the wall goes, and a direct-loading tile held until the core answers (at most the cap) while a proxied one starts at once.
- `tilePlayback.test.tsx` covers a server-refused stream failing at once with its reason, the mpegts.js retry without a request first, no retry after an mpegts.js fallback, the tile buffer profile, and the start delay (none for the first slot, none for a retry).
- `tileReconnect.test.tsx` runs a tile on the player's real engines with mpegts.js faked: a live MPEG-TS stream that ends is reconnected and fails the tile only once the restarts run out, and a live stream on the element that ends fails it at once.
- `addChannel.test.tsx` covers the gate, duplicates and a full wall after the gate, replace, and `useMultiviewMenuItem`: disabled states, navigation, toasts and a cancelled PIN.
- `e2e/multiview.spec.ts` (check 4) seeds the wall in localStorage against the mock portal and checks:
  - four tiles all advance `currentTime` and exactly one video is unmuted, after a click and after a number key;
  - a tile with a stream the mock refuses (401) shows its error while the other three keep advancing, through Retry and Close;
  - four tiles of the demo Xtream account (limit 2) raise the connection banner;
  - the picker puts two channels on an empty wall, and arrow keys, Delete and a reload behave.
