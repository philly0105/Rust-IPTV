# Subscription status

`crates/iptv-core/src/account/` caches what Xtream panels and Stalker portals report about the subscription: status text, expiry date, trial flag, and (Xtream only) connections in use and the limit. M3U sources have no account.

## Cache

- One `AccountStatus` per source, stored as JSON in `app_state` under `account_status:<id>`, so the dashboard and source cards have data at boot without a network call. Removing the source deletes the key.
- Fields: `sourceId`, `kind`, `status?`, `expDate?` (RFC 3339; absent = no expiry reported), `isTrial`, `activeCons?`, `maxConnections?` (absent or 0 = unlimited), `checkedAt`, `error?`.
- It is filled from replies the app already gets: every Xtream sync (the account call that opens it), `xtream.accountInfo`, and `stalker.accountInfo`. After a successful Stalker import a background check runs, since a Stalker sync does not fetch the account.
- A check older than 4 hours (30 minutes after a failed check) is stale; `account.status` refreshes a stale entry in the background. `refresh: true` asks an Xtream panel now, at most once per 20 s per source; a younger check is returned as is. On Stalker sources `refresh: true` returns the cache without asking the portal (portals report no connection counts). One check per source runs at a time. A failed check keeps the last good fields and sets `error`; `connections_full` is then false.
- A failed check keeps the last good fields and sets `error` to a redacted message. Credentials, MACs, tokens and URLs never appear in the cache, the error or the logs.
- A changed entry emits `account.changed {sourceId}`, after its row is stored; the UI invalidates `account.*`.
- Saves pass the gate of the background writes (`AppState::db_background`, userstate.md), so a sync start or a forced check during another source's import save parks no write-pool connection of its own. Sync starts and the `accountInfo` commands still wait for their save. A check (`refresh`) updates the downloads' connection limit and returns the fetched status before its row is stored, so the player's check after a failed tune never waits for an import's commit. Every save first notes its status in an in-memory map per source (`account.unstored`), dropped once the save has run unless a newer status replaced it; a check reads that entry before the row, so a check queued behind one whose row still waits (smart reconnect's check, then the error screen's, for one playback failure) reuses it within 20 s at once and with no second panel request. The source's lock is let go as soon as the status is noted, not when the row lands, and `account.changed` still follows the stored row. With the write lock held, forced checks of two mock panels answered in 1.4 and 2.4 ms (`l2_import_pool.rs`, debug build), and a second forced check of one panel in 0.7 ms (`account_status.rs`); it used to wait for the save's commit.

## Commands

| Command | Args | Result |
| --- | --- | --- |
| `account.status` | `{sourceId, refresh?}` | `AccountStatus \| null` (null for M3U; unknown source is `NotFound`) |
| `account.statusAll` | none | `AccountStatus[]` for every Xtream and Stalker source with a cached entry |

Both are in the shared router, so desktop and server mode serve them the same way.

## UI

- Source cards (`AccountBadges`): "Expired" (danger), "Expires in 3 days" (warning, within `accountExpiryWarnDays`), "Trial", and "1/2 connections" (warning when full; hidden while the last check failed, since the counts are then from an older check). A healthy unlimited account shows nothing.
- Dashboard: `AccountAlerts`, see ui-shell.md.
- Zap: on an Xtream source whose limit is 1, or whose status is not known yet, a burst of presses opens only the channel it stops on, after `ZAP_SETTLE_MS` (250 ms), so the panel never sees two of the app's streams at once. An unknown status is asked through the shared `account.status` query, once per burst (an empty or failed answer is asked again only after 2 s), and a single press opens as soon as the answer allows more than one connection. Other sources open each press at once. See `holdsZapTune` in `src/features/player/store.ts`.
- Player: after a failure whose class a full account could explain (auth, server, network, timeout, generic) on an Xtream source, `useConnectionCounts` calls `account.status {refresh: true}` once for that error. The counts count only when that check succeeded (no `error`) and is at most 30 s old. The app's own connections are subtracted: the stream it played from that source in the last 2 minutes (panels keep a dropped connection counted for a while) its running recordings on that source (`recordings.list`) and its running downloads from that source (`downloads.list`, status `downloading`). When the others alone fill the limit, the error becomes `connectionLimit` ("Connection limit reached (2 of 2 in use)" plus what to do). When the limit is full only counting the app's own connections, a refused stream (auth class) reads "Connection limit may be reached" with a hint that one of them may be this app's own stream; server, network, timeout and generic failures keep their own class. Provider wording ("max connections", "too many connections", "connection limit") and HTTP 458 / 509 give the same class without a check. Offline, a missing player, a missing stream and codec errors keep their own class. Classification is in `src/features/player/errors.ts`.

## Settings

`accountExpiryWarnDays` (default 7, 0..60, 0 = off). See settings.md.

## Tests

`tests/account_status.rs` runs against the mock panel's `expiring`, `expired` and `full` users (xtream.md): a sync fills the cache, `statusAll` skips M3U, a forced check within 20 s makes no request, a second forced check reuses the first one's answer while another save holds the write lock (no panel request, no wait for the commit; the row lands after it), a forced Stalker check makes no portal request, removing a source drops its entry, and a failed check keeps the last good fields. Unit tests in `account/mod.rs` cover the reply mapping and staleness.
