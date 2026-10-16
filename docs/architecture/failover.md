# Smart reconnect and live failover

Two settings (Settings > Playback), both on by default:

- `streamReconnect`: a stream that drops or stalls is retried quietly before the error shows.
- `liveFailover`: a live channel that fails for good switches to the same channel on another source.

Code: `src/features/player/reconnect.ts` (state machine), `src/features/player/failover.ts` (VOD and live failover, alternates cache), `src/features/player/livePins.ts` (preferred-source pins), `crates/iptv-core/src/live/` (matching, `live.alternates`). UI: `components/ReconnectNotice.tsx`, `components/AlternateSources.tsx`.

## Smart reconnect

`bindRecovery()` (called once by `PlayerDock`) follows the player store. Every failure of the built-in engines (hls.js, shaka, mpegts.js, the media element) and of embedded mpv ends up as a store transition to `status: 'error'`. A stall counts too: `status: 'playing'` while the position has not moved for `STALL_MS` (12 s). Embedded mpv keeps a stalled file loaded and keeps reporting `playing`, so a stall only counts as recovered once the position moves; until then the retries go on, and after giving up the error stays up even when mpv says `playing` again.

The failure is classified with `classifyStreamError` (unchanged) and handled by `recoveryFor(cls)`:

| Class | Retry | Switch live channel |
| --- | --- | --- |
| `engineMissing`, `offline` | no | no (the error UI already handles both) |
| `auth`, `notFound`, `unsupported`, `connectionLimit` | no | at once |
| `server` | after the switch finds nothing | at once |
| `timeout`, `network`, `media`, `crashed`, `generic` | yes | when retries give up |

One exception: a `timeout` of a stream that never played switches a live channel first (see [Starting a stream](#starting-a-stream)).

Retries wait 1 s, 2 s and 4 s (`RECONNECT_DELAYS_MS`). That ladder is for a stream that played and then dropped. A stream that never played gets `STARTUP_RETRIES` (1) retry, after 1 s (`budgetOf`), and the notice reads "Reconnecting (1 of 1)": a provider that answers 503, or nothing, on the first try rarely does better on the fourth, and the user is waiting on a spinner. Every retry must start within 20 s of the first failure of the run (`RECONNECT_WINDOW_MS`), and a retry that has not reached playback after `ATTEMPT_TIMEOUT_MS` (8 s) counts as failed. Reaching playback ends the run, but the count of retries only goes back to zero after `HEALTHY_MS` (30 s) of good playback, so a stream that keeps flapping still gives up after three.

A full account often fails as a bare 5xx, timeout or dropped connection. While the first retry of a run waits, the source's account is checked once (`fetchConnectionCounts` in `connectionLimit.ts`, the same `account.status` check and own-connection accounting as the error UI; never for M3U or Stalker). When it is full, the retries stop and the failure goes on as `connectionLimit`. Stalls are not checked, since the stalled stream still holds its own connection.

While it works, the store stays in `loading` (so the error overlay does not flash) and `useReconnectStore` drives the notice: a pill under the loading dial in the built-in player, the status strip with embedded mpv. Then a retry:

- reloads through the surface's own `commands.retry()` (the built-in player rebuilds its engine, mpv reloads, or re-attaches after a crash);
- for VOD, first sets `source.resumeSeconds` to where playback dropped, so it resumes there;
- for Stalker, resolves a fresh link first (`stalker.streamUrl`), since links expire; a new url reloads the media by itself;
- when the stream URL lookup itself failed, runs it again (`retryResolve`).

Giving up restores the original error message and RPC code, so the overlay shows the same class it would have shown without reconnect. A movie then gets the VOD failover (`vodAutoFailover`), which used to run straight from `InlinePlayer` and now also covers embedded mpv. A user Retry after that starts a fresh budget.

### Starting a stream

- The player store's watchdog raises a `timeout` when a live stream shows no first frame within `LIVE_STARTUP_TIMEOUT_MS` (10 s). VOD keeps `STARTUP_TIMEOUT_MS` (30 s), and so does a re-buffer of any item that already played.
- A `timeout` before the first frame tries alternates first: with `liveFailover` on, a live channel switches to another copy before any retry, since a hung provider stays hung. When no copy plays, the one retry follows if the budget allows it.
- While a stream that never played is still loading after `SLOW_START_MS` (4 s), the phase is `connecting` and the player says "Still connecting" (a pill under the loading dial; with embedded mpv, a pill over the native video). For a live channel with alternates, and `liveFailover` on, the pill also has "Try another source" (`tryAnotherSource()`), which switches now instead of waiting out the start timeout; when no copy plays, it keeps waiting on the current one. The built-in player's compact (mini) view shows the pill without the button.
- The engines leave retries to smart reconnect, so the "Reconnecting" count is the real number of reloads. mpegts.js no longer restarts on an HTTP status (404, 503 and the like): the error goes up at once, with the reason the app's own server gives when the stream goes through it (`fetchFailureReason`). A network error without a status restarts only a stream that produced media (`hadMedia` in `engines.ts`), such as a live connection that dropped; before that it fails at once too.

## Live failover

`live.alternates {ref}` returns the same channel elsewhere, best first (see Matching). The player prefetches it when a live channel starts (`trackAlternates`, cached 5 minutes) so the menu and a failover need no extra wait.

`tryLiveFailover(failed)` keeps one chain per failure: the original, every copy tried, the copy now playing and whether it has played. It walks the ranked list, skips copies already tried, resolves each through the normal play path (`resolveSource`, so Stalker links are fresh) and moves on when a link cannot be resolved. A copy that fails before it ever played goes straight to the next copy without retries. A chain never returns to a copy it tried; it ends when the user plays something else. When no copy is left, the error shows on the last one. Account-wide failures change the order (`forAccountFailure`): after `connectionLimit` the chain skips every copy on a source it found full; after `auth`, copies on the refusing source go after all other sources.

Channel history treats a failover hop, a pin redirect and their Undo as the same channel: the new copy replaces the entry of the copy it left (`failoverSwitchKey`), so B goes back to the channel watched before, not to the dead copy.

The toast says "Switched to <channel> on <source>" with Undo. Undo plays the original again (resolved afresh) and turns automatic switching off for that channel until the user plays something else.

The player's options menu gets "Alternate sources" when the channel has any: each row shows the channel name, the source, and the quality tag. The last row, "Prefer this source for <channel>", pins the playing source. Pins live in localStorage (`live.sourcePins.v1`) keyed by the match key, like the VOD pins. A pinned copy leads the failover order, and when the channel starts on another source the player moves to the pinned copy with an Undo toast.

## Matching (`crates/iptv-core/src/live`)

`matcher::signature(name)` reduces a channel name to:

- `key`: lowercased, Latin diacritics folded, the country prefix removed by the same rules as the UI's `stripCountryPrefix` (`UK: `, `UK | `, `[UK] `, `|UK| `), and quality, codec and backup words removed (`HD`, `FHD`, `UHD`, `4K`, `HEVC`, `H.265`, `50fps`, `(backup)`, `alt 2`).
- `region`: the country prefix (`GB`/`GBR` read as `UK`, `USA` as `US`, `GER`/`DEU` as `DE`). Two names with different regions never match; a missing region matches any. A trailing `(UK)` stays part of the name, so "Discovery (UK)" and "Discovery" do not match.
- `quality`: the highest marker found (`sd`, `hd`, `fhd`, `uhd`).
- `timeshift`: `+1`, `+24` and so on. "Film4" and "Film4 +1" are different channels.

Numbers stay in the key, so "Sky Sports 1" and "Sky Sports 2" (and "Sky Sports 12") stay apart. "Canal" and "Canal+" stay apart too. Known limits: "Sports1" does not match "Sports 1", and "One" does not match "1".

`live::alternates(conn, ref)` collects candidates two ways, both indexed:

1. By guide id: the manual mapping in `epg_channel_map` if there is one, else the item's `epg_channel_id`, looked up through `idx_items_epg` (and the map). Placeholder ids (`none`, `0`, `-`) and ids shared by more than 200 channels are ignored. A guide-id match must still agree on timeshift and region.
2. By name: an FTS5 phrase query on the key's words (`items_fts`), at most 2000 rows, each then compared by its full signature.

The item itself, any copy with the very same URL and channels in hidden categories are dropped. Order: same quality tier as the playing copy first, then source order, then playlist order; at most 50. Live and radio only (Invalid otherwise; NotFound for an unknown item). No migration: the existing indexes are enough. Works in server mode (the server dispatches every router command).

## Tests

- `crates/iptv-core/src/live/matcher.rs`: country prefixes, pairs that must match, pairs that must not (Sky Sports 1/2/12, Film4/+1, Canal/Canal+, UK/DE, ESPN/ESPN 2), quality, region, timeshift, FTS phrase.
- `crates/iptv-core/tests/live_alternates.rs`: ordering, guide-id and manual-mapping matches, placeholder ids, the +1 guard, same-URL exclusion, errors; and three sources of 50,000 channels each, with query plans checked (FTS and `idx_items_epg`, no table scan) and every lookup under 100 ms after a warm-up.
- `src/features/player/reconnect.test.ts` (fake timers): backoff timing, give-up, attempt timeout, the 20 s window, budget reset, flapping, non-retryable classes, the setting off, VOD resume, stall detection, Stalker refresh; for streams that never played, one retry for a 503, none for a 4xx, the full ladder once a stream played, `connecting` after `SLOW_START_MS`, and Try another source with no other copy.
- `src/features/player/failover.live.test.ts`: switch with undo toast, next copy without retries, no loop back, unresolvable copy skipped, Undo restores the original and stops switching, pin order and pin redirect, retries before the switch.
