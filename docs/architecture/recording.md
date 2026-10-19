# Guide reminders and scheduled recordings

Code: `crates/iptv-core/src/recording/` (core), `src/features/recording/` (guide actions, reminder handling), `src/features/library/pages/ScheduledPage.tsx` and `src/features/library/components/RecordingsPanel.tsx` (Library pages), `src/features/settings/sections/RecordingSection.tsx` (settings). Tests: `crates/iptv-core/tests/recording.rs` (records real bytes from the mock), `crates/iptv-core/tests/recording_rules.rs` (series rules on a manual clock), unit tests in `scheduler.rs`, `naming.rs`, `engine.rs`, `store.rs`, and Vitest in `src/features/recording/test/` and `src/features/library/test/recording.test.tsx`.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Commands (`add_reminder`, `schedule`, `cancel`, ...), the background loop, `tick`, recording tasks with retry, guide re-matching, `shutdown`. |
| `scheduler.rs` | Pure decisions: `plan(now, reminders, recordings, settings)` returns fire / miss / start / stop / purge actions. "Now" comes from a `Clock` (`SystemClock`, or `ManualClock` in tests). Also `rematch`. |
| `engine.rs` | Engine choice and the two engines: a direct HTTP copy (preferred for plain streams) and headless mpv (`--stream-record`). |
| `naming.rs` | `<Channel> - <Programme> - <YYYY-MM-DD HHmm>.ts`, Windows-sanitized, never overwriting; `(part N)` suffixes. |
| `store.rs` | SQL for the `reminders` and `recordings` tables (migration `0010_recordings.sql`; `recordings.rule_id` from `0015_guide.sql`). |
| `rules.rs` | Series recording rules: the `recording_rules` and `recording_rule_skips` tables (migration `0015_guide.sql`), their commands, materialisation into scheduled recordings, and the backup export and import. |
| `library.rs` | My Videos > Recordings: rows plus loose files in the recordings folder, play, reveal, delete to the Recycle Bin (Windows; elsewhere the file is deleted). |
| `rpc.rs` | `reminders.*` and `recordings.*` registration and `COMMANDS`. |

## Commands

| Command | Args | Result |
| --- | --- | --- |
| `reminders.list` | none | `Reminder[]` |
| `reminders.add` | `{ref, channelName, title, start, end}` | `Reminder` (the existing one for the same channel and start) |
| `reminders.remove` | `{id}` | null |
| `reminders.unhandled` | none | `ReminderFiredEvent[]`: fired reminders no window has acknowledged yet, while their programme runs |
| `reminders.ack` | `{id}` | null (the UI handled the firing) |
| `recordings.capabilities` | none | `{supported, mpv, reason?}` |
| `recordings.list` | none | `Recording[]` |
| `recordings.schedule` | `{ref, channelName, title?, start?, end?}` or `{ref, channelName, durationMinutes}` | `{recording, warning?: {overlapping, maxConnections}}`; `engine_missing` when mpv is absent and the stream is not plain MPEG-TS |
| `recordings.cancel` | `{id}` | `Recording` (stops a running one, keeping its file) |
| `recordings.remove` | `{id}` | null (finished rows only; files stay) |
| `recordings.library` | none | `RecordingFile[]` |
| `recordings.playSource` | `{id}` | `PlayerSource` |
| `recordings.reveal` | `{id}` | null (desktop) |
| `recordings.delete` | `{id}` | null (file to the Recycle Bin on Windows, deleted elsewhere; a missing file just drops the entry) |
| `recordings.rules` | none | `RecordingRule[]`, oldest first |
| `recordings.addRule` | `{ref, channelName, title}` | `RecordingRule`, with its airings already scheduled |
| `recordings.setRuleEnabled` | `{id, enabled}` | `RecordingRule` |
| `recordings.removeRule` | `{id, keepScheduled?}` | null |

Events: `reminders.update {}`, `reminders.fire {reminder, action, firedAt}`, `recordings.update {}`, `recordings.progress {id, bytes, elapsedSeconds}` (every 2 s while writing).

All times on the wire are RFC 3339 in display time: the UI sends programme times with `settings.epgOffsetMinutes` applied, the same times the guide shows, and the core stores them as given. Re-matching applies the offset when it reads the guide.

## Settings

`recordingPaddingBeforeMinutes` (default 1, 0..60), `recordingPaddingAfterMinutes` (5, 0..120), `remindersEnabled` (true), `reminderLeadMinutes` (2, 0..60), `reminderAction` (`notify` | `switch`, default `notify`). Padding is copied onto a recording when it is scheduled; changing it later does not move existing recordings. All five are part of the backup's app settings.

## Reminders

- A reminder is unique per channel and start time. Adding it twice returns the first one. A programme that already started cannot get one.
- The loop fires a pending reminder at `start - reminderLeadMinutes` and marks it `fired`. A reminder more than 5 minutes past its start (the PC slept, or the app was closed) becomes `missed` without firing. With `remindersEnabled` off, due reminders become `missed` quietly.
- Fired and missed reminders are deleted once their programme has ended.
- Adding a reminder that already fired or was missed (same channel and start) arms it again.
- A fired reminder stays in an in-memory "unhandled" list until a window calls `reminders.ack`. `RecordingWatcher` fetches `reminders.unhandled` on mount, so a reminder that fired at launch or with no browser tab open is still shown while its programme runs. The list does not survive a restart. Each firing (`id` + `firedAt`) is handled once per window.
- The UI (`RecordingWatcher`, mounted in the shell so it runs while the window is hidden in the tray) handles `reminders.fire`:
  - `notify`: a native Windows notification through the `native_notify` Tauri command (`tauri-plugin-notification`) and an in-app toast with "Watch now". In server mode only the toast shows, plus a browser notification when permission was already granted. The app never asks for permission.
  - `switch`: tunes to the channel, the desktop shell brings the window forward, and a toast offers Undo, which puts back what was playing (or stops).

## Recordings

- Programme recordings run from `start - paddingBefore` to `end + paddingAfter`. Channel recordings ("Record channel for 30 min / 1 h / 2 h / 3 h") start now; at most 12 h.
- `recordings.schedule` refuses a programme (`invalid`, `check_programme_times`) that does not end after it starts, that lasts more than 12 h ("This programme is longer than 12 hours, so the guide entry is probably a placeholder. Record the channel for a set time instead."), or that starts more than 30 days from now ("Recordings can be scheduled up to 30 days ahead."). Both limits apply to the programme's own times, before padding.
- Engines, chosen per part (`engine::choose`): a plain http(s) stream that is not an HLS or DASH manifest is copied over HTTP with the same User-Agent, Referer, Origin and other headers the player would send, and an Xtream live HLS URL is copied as its `.ts` variant, even when mpv is installed: the copy writes bytes as they arrive and decodes nothing. Everything else (HLS, DASH, other schemes) goes to a headless mpv when it is installed (`--vo=null --ao=null --hwdec=no --vd-lavc-skipframe=all --no-config --stream-record=<core path>`, with the same headers, ended at the padded end); `--vd-lavc-skipframe=all` keeps mpv from decoding video that `--stream-record` does not need. When a part copied over HTTP fails (wrote nothing or ended in under 15 s) and mpv is installed, mpv records the rest of that recording, starting at once; this covers providers that refuse the `.ts` variant and plain-looking addresses that answer with a manifest. Without mpv, HLS and DASH are refused when scheduling with `engine_missing` (and fail with that reason if mpv goes away later). Recordings made through mpv with frame skipping should be checked with `ffprobe` on the PC (streams present, duration, no decode errors at the start) after changes to these arguments. The output path is always built by the core under the recordings folder (`settings.recordingsDir`, default `<downloads>/recordings`); no user path is passed to mpv.
- A dropped stream is reconnected until the padded end or a stop, however often it drops. The wait before the next attempt is 1 s, doubling with each consecutive failed attempt to at most 30 s (`backoff`). A part that wrote nothing, or ended on its own in under 15 s, counts as failed; any longer part resets the wait to 1 s. A channel that cannot be resolved also counts as a failed attempt. The row's note reads "Reconnecting: ..." while it waits.
- Each attempt writes the next part file (`... (part 2).ts`). A reconnect part of 64 MB or less (`MERGE_MAX_BYTES`) is appended to the part before it (MPEG-TS joins byte for byte) and then deleted, so a flaky stream still gives one file; if the join fails, both stay as separate parts. A larger part stays separate, because copying it would take long enough to miss more of the programme. A part that wrote nothing is deleted.
- A recording that dropped at least once after something was written ends `completed` with "The stream dropped during the recording, so parts of the programme may be missing." (`streamGaps`). At most 50 separate parts are kept (`MAX_PARTS`): when the 50th is written the recording stops and ends `completed` with "Recording stopped early: the stream kept dropping." (`streamDropped`).
- Only errors that retrying cannot change end a recording early, as `failed`: no engine for the stream, a URL the player refuses, a refusal by the server-mode fetch guard, or a part file that cannot be created.
- Status changes are compare-and-set on the current status, so a stale task cannot overwrite a cancel or a newer state.
- States: `scheduled`, `recording` (bytes and elapsed time from `recordings.progress`), `completed`, `failed` (with a reason), `missed`, `cancelled`.
- A recording that was due while the app was closed starts late at launch while its padded slot is still running; it is marked `missed` ("The app was not running when this recording was due.") only once the slot is over. A recording that was writing when the process died is closed at the next launch: `completed` ("stopped early") if anything was written, otherwise `failed`. The part files on disk decide, not the row's saved byte count (a running recording saves that count every 10 s).
- On quit, `recording::shutdown` first stops the loop from starting or resuming anything, then stops every running recording, waits up to 5 s for the final rows to be written, and the mpv children are also in the kill-on-close job object. `iptv-server` calls it too on exit, once its open streams have closed or the shutdown grace has passed.
- Removing a source deletes its reminders, cancels its scheduled recordings ("The source of this channel was removed.") and stops running ones. Finished rows and files stay.
- Each `Recording` carries `errorCode` when its note is one of the core's own messages (`reconnecting`, `engineMissing`, `missedNotRunning`, `stoppedShutdown`, `closedEarly`, `closedNothing`, `nothingRecorded`, `stopped`, `sourceRemoved`, `streamDropped`, `streamGaps`, `streamNotFound`, `streamRejected`, `streamNoAnswer`, `streamServerError`, `notAStream`, `diskFull`, `ruleRemoved`); the UI shows `library:recError<Code>`. After a failed attempt that ended with an error, `engine::diagnose` looks for a cause the user can act on: under 32 MB free on the recordings disk (checked on Windows only) is `diskFull`; otherwise one request for the stream with the recording's client and headers maps 404/410 to `streamNotFound`, 408/504 and no answer to `streamNoAnswer`, 429/5xx to `streamServerError`, any other refusal to `streamRejected`, and a `text/html` answer to `notAStream`. The HTTP engine maps its own answers and a full disk the same way. Other stream errors (mpv's "The stream could not be read ...") are shown as written.
- Xtream `max_connections`: scheduling returns a warning (not an error) when the recordings on that source that overlap the new one (itself included) exceed the account's limit. Live playback is not counted.

## Series rules

A rule records every airing of one title on one channel: `RecordingRule {id, ref, channelName, title, enabled, createdAt, upcoming, nextStart?}`, where `upcoming` counts the rule's scheduled recordings and `nextStart` is the earliest of them.

- The title is matched by its key: letters and digits, lowercased (`scheduler::title_key`, the same key re-matching uses). "The Daily Show", "THE DAILY SHOW!" and "the-daily-show" are one series. A second rule with the same channel and key is a `conflict`.
- `addRule` has the same checks as `recordings.schedule`: `unsupported` without recording support (server without mpv), `invalid` for a non-live channel, `engine_missing` for an HLS or DASH stream with no mpv, `not_found` for an unknown source. The title is trimmed and must be 1 to 200 characters with at least one letter or digit. At most 100 rules; `channelName` falls back to the item id.
- Materialisation turns rules into ordinary `scheduled` recordings with `ruleId` set. It runs on the re-match triggers below (after each guide refresh, at most every 5 minutes otherwise), after the re-match itself so a moved airing is followed rather than added twice, and right after `addRule` and `setRuleEnabled(true)`. It holds the loop's tick lock, so a tick in progress cannot add the same airing.
- Each rule's checks and inserts run in one IMMEDIATE write transaction that first re-reads the rule: a rule removed or switched off meanwhile adds nothing, and a manual `recordings.schedule` of the same airing (also one IMMEDIATE transaction around its check and insert) lands wholly before or after it, so the airing is recorded once. `addRule` counts the rules and inserts in one IMMEDIATE transaction too, so two adds at once cannot pass the limit.
- It looks 7 days ahead of the clock and takes the channel's guide programmes whose title key matches, in display time (guide time plus `epgOffsetMinutes`), starting after now. A guide entry longer than 12 h is skipped as a placeholder. Padding comes from the settings at that moment and the recording keeps the guide's own title.
- An airing is never created twice. A start already present in `recordings` for the channel (any status, so a cancelled, failed, missed or finished recording counts, as does a manual one) is left alone, and so is a start in `recording_rule_skips`. The one exception is a row an older build cancelled when its rule was removed (`ruleRemoved`, below).
- Cancelling a rule's scheduled recording writes a skip row for its start, so removing the cancelled row from the list does not bring the airing back. The re-match moves the skip (and the cancelled row, while it is listed) with the airing when the guide moves it, so a cancelled airing stays cancelled at its new time. Skips more than a day older than the re-match window are pruned.
- Each rule keeps at most 20 scheduled recordings; as they run or are cancelled, later airings take their place on the next pass.
- `setRuleEnabled(false)` stops new airings and keeps the ones already scheduled.
- `removeRule` deletes the rule, its skips and the scheduled recordings it made that have not started, in one IMMEDIATE transaction. It leaves no cancelled row and writes no skip, so adding the rule again schedules those airings again. With `keepScheduled: true` the scheduled recordings stay. Running recordings go on either way. Recordings that stay lose their `ruleId` and are one-off recordings from then on: a rule added later for the same title does not take them over (their starts count as taken) and does not delete them when it is removed. Older builds cancelled the airings instead, with the note "Cancelled because its series rule was removed." (`ruleRemoved`). Such rows do not count as taken, and materialisation deletes each one (same channel and start) before it schedules the airing again. Removing a source deletes its rules.
- Backup: `recording::export_rules` and `import_rules` carry `{contentType, itemId, channelName, title, enabled, createdAt}` per source. Import skips non-live rules, blank titles or items, duplicates and anything past 100 rules; imported rules are scheduled on the next re-match pass. `rules::import_counted` also counts the new rules the limit left out, for the restore's warning (backup.md).

## Re-matching after a guide refresh

On a loop tick after each guide refresh, and at most every 5 minutes otherwise, pending reminders and scheduled programme recordings are matched again against the channel's guide: the programme with the same title (letters and digits, case-insensitive) whose start is nearest the stored one, within 3 hours. Its new start and end replace the stored ones. Channel recordings are not re-matched. Stalker portal-side EPG (`stalker.epg`) is not part of the local guide, so items scheduled from it are not re-matched.

Recordings are matched channel by channel (`scheduler::follow`), together with the series rules' cancelled airings (skips), so one airing never ends up with two recordings:

- Each airing of the guide goes to at most one of them, nearest pairs first. A slot held by a recording that is not re-matched (one running, about to start, or without a title) is not handed out. The move itself (`store::move_scheduled`) is refused when another scheduled or running recording of the channel already starts there.
- A recording whose airing is gone (the guide shows another title over its time and no free airing of its title is within 3 hours) is deleted when a series rule made it: it never started, and the rule schedules what it still wants on the same pass. A manual recording stays where the user put it. When the guide has nothing at that time, the recording is left alone.
- A cancelled rule airing that moves takes its skip and cancelled row along (see Series rules).

## Server mode

`recordings.capabilities` reports `supported: false` when the server machine has no mpv. The guide then hides Record and shows a one-line explanation; the Scheduled page notes it. Reminders work in server mode (toast only). Recordings made on the server are written under `<data dir>/downloads/recordings` and played back through `GET /api/recordings/{id}` (Range support). Before recording, the stream URL goes through the same fetch guard as other server fetches (http/https only, no private or loopback hosts unless allowed); mpv resolves names itself, so the host is also resolved first and refused unless every address is public. Redirects and HLS segment hosts that mpv follows are not checked.

## Library

- Library > Scheduled (`/scheduled`, rail entry) lists recordings writing now (progress, size, stop; only these rows tick every second, the page's own clock moves the day headings once a minute), upcoming reminders and recordings grouped by day (cancel), and the 50 most recent finished recordings (status, reason, remove from list).
- My Videos > Recordings lists each recording part (id `r.<recording>.<hex file name>`, so ids stay put when another part is deleted) and every media file in the recordings folder: play, show in folder (desktop), delete with an 8 s Undo before the file goes to the Recycle Bin, size, date, duration, and a "File missing" badge when the file is gone.
- On desktop `recordings.playSource` returns the loopback proxy's `.../recordings/{id}/media.<ext>`, which streams the file with Range support ([desktop.md](desktop.md#what-it-serves)); mpv and VLC get the path. When the proxy is not running it returns the path, which plays through the asset protocol.
- At startup the desktop app adds every folder that holds a known recording part to the player's asset scope, so recordings stay playable after the recordings folder setting changes.
