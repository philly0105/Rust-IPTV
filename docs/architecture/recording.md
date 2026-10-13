# Guide reminders and scheduled recordings

Code: `crates/iptv-core/src/recording/` (core), `src/features/recording/` (guide actions, reminder handling), `src/features/library/pages/ScheduledPage.tsx` and `src/features/library/components/RecordingsPanel.tsx` (Library pages), `src/features/settings/sections/RecordingSection.tsx` (settings). Tests: `crates/iptv-core/tests/recording.rs` (records real bytes from the mock), unit tests in `scheduler.rs`, `naming.rs`, `engine.rs`, `store.rs`, and Vitest in `src/features/recording/test/` and `src/features/library/test/recording.test.tsx`.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Commands (`add_reminder`, `schedule`, `cancel`, ...), the background loop, `tick`, recording tasks with retry, guide re-matching, `shutdown`. |
| `scheduler.rs` | Pure decisions: `plan(now, reminders, recordings, settings)` returns fire / miss / start / stop / purge actions. "Now" comes from a `Clock` (`SystemClock`, or `ManualClock` in tests). Also `rematch`. |
| `engine.rs` | Engine choice and the two engines: headless mpv (`--stream-record`) and a direct HTTP copy. |
| `naming.rs` | `<Channel> - <Programme> - <YYYY-MM-DD HHmm>.ts`, Windows-sanitized, never overwriting; `(part N)` suffixes. |
| `store.rs` | SQL for the `reminders` and `recordings` tables (migration `0010_recordings.sql`). |
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
- Engines, chosen per recording: headless mpv when it is installed (`--vo=null --ao=null --no-config --stream-record=<core path>`, with the same User-Agent, Referer, Origin and other headers the player would send, ended at the padded end). Without mpv, a plain MPEG-TS URL is copied over HTTP with the same headers. Anything else (HLS, DASH) is refused when scheduling with `engine_missing` (and fails with that reason if mpv goes away later). The output path is always built by the core under the recordings folder (`settings.recordingsDir`, default `<downloads>/recordings`); no user path is passed to mpv.
- A dropped stream is retried up to 5 times with backoff (2 s doubling, at most 30 s). Each retry writes the next part file (`... (part 2).ts`); the row's error reads "Reconnecting: ..." while it waits. A part that wrote nothing or ran under 15 s counts as a failure even without an error, and a recording stops after 50 parts; it then ends `completed` with "Stopped early because the stream kept dropping." if anything was written.
- Status changes are compare-and-set on the current status, so a stale task cannot overwrite a cancel or a newer state.
- States: `scheduled`, `recording` (bytes and elapsed time from `recordings.progress`), `completed`, `failed` (with a reason), `missed`, `cancelled`.
- A recording that was due while the app was closed starts late at launch while its padded slot is still running; it is marked `missed` ("The app was not running when this recording was due.") only once the slot is over. A recording that was writing when the process died is closed at the next launch: `completed` ("stopped early") if anything was written, otherwise `failed`.
- On quit, `recording::shutdown` first stops the loop from starting or resuming anything, then stops every running recording, waits up to 5 s for the final rows to be written, and the mpv children are also in the kill-on-close job object.
- Removing a source deletes its reminders, cancels its scheduled recordings ("The source of this channel was removed.") and stops running ones. Finished rows and files stay.
- Each `Recording` carries `errorCode` when its note is one of the core's own messages (`reconnecting`, `engineMissing`, `missedNotRunning`, `stoppedShutdown`, `closedEarly`, `closedNothing`, `nothingRecorded`, `stopped`, `sourceRemoved`, `streamDropped`); the UI shows `library:recError<Code>`. Network errors are shown as written.
- Xtream `max_connections`: scheduling returns a warning (not an error) when the recordings on that source that overlap the new one (itself included) exceed the account's limit. Live playback is not counted.

## Re-matching after a guide refresh

On a loop tick after each guide refresh, and at most every 5 minutes otherwise, pending reminders and scheduled programme recordings are matched again against the channel's guide: the programme with the same title (letters and digits, case-insensitive) whose start is nearest the stored one, within 3 hours. Its new start and end replace the stored ones. Channel recordings are not re-matched. Stalker portal-side EPG (`stalker.epg`) is not part of the local guide, so items scheduled from it are not re-matched.

## Server mode

`recordings.capabilities` reports `supported: false` when the server machine has no mpv. The guide then hides Record and shows a one-line explanation; the Scheduled page notes it. Reminders work in server mode (toast only). Recordings made on the server are written under `<data dir>/downloads/recordings` and played back through `GET /api/recordings/{id}` (Range support). Before recording, the stream URL goes through the same fetch guard as other server fetches (http/https only, no private or loopback hosts unless allowed); mpv resolves names itself, so the host is also resolved first and refused unless every address is public. Redirects and HLS segment hosts that mpv follows are not checked.

## Library

- Library > Scheduled (`/scheduled`, rail entry) lists recordings writing now (progress, size, stop), upcoming reminders and recordings grouped by day (cancel), and the 50 most recent finished recordings (status, reason, remove from list).
- My Videos > Recordings lists each recording part (id `r.<recording>.<hex file name>`, so ids stay put when another part is deleted) and every media file in the recordings folder: play, show in folder (desktop), delete with an 8 s Undo before the file goes to the Recycle Bin, size, date, duration, and a "File missing" badge when the file is gone.
- At startup the desktop app adds every folder that holds a known recording part to the player's asset scope, so recordings stay playable after the recordings folder setting changes.
