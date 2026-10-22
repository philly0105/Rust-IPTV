# Downloads and My Videos

Code: `crates/iptv-core/src/downloads/`. Tests: `crates/iptv-core/tests/downloads.rs` (check 9 / SC7) plus unit tests in `naming.rs`, `transfer.rs`, and `rpc.rs`.

The download manager keeps a FIFO queue of movie, episode and catch-up programme downloads, runs at most two transfers at a time, resumes partial files over HTTP Range, and never overwrites a file it did not create. Completed rows make up My Videos, the offline library.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Operations behind every command (`start`, `pause`, `resume`, `retry`, `cancel`, `remove`, `set_dir`, `reveal`, `play_source`, ...) and `init`. |
| `manager.rs` | Queue runtime stored in `state.extensions["downloads"]`: FIFO queue, active map, per-task `CancellationToken`, stop reason, live byte counter, done signal. |
| `transfer.rs` | One transfer: destination preparation, Range resume, streaming to the `.part`, in-task retry, throttled progress, finalize. |
| `naming.rs` | Windows-safe file names, atomic `.part` reservation, finalize without overwrite. |
| `store.rs` | SQL for the C3 `downloads` table. |
| `rpc.rs` | `downloads.*` and `myvideos.*` registration (C4), plus `COMMANDS`. |

## Commands (C4)

`downloads.list`, `downloads.get`, `downloads.start`, `downloads.pause`, `downloads.resume`, `downloads.cancel`, `downloads.retry`, `downloads.remove {id, deleteFile}`, `downloads.reveal`, `downloads.setDir {path}`, `downloads.dir`, `downloads.setPosition {id, positionSeconds}`, `myvideos.list`, `myvideos.playSource`.

Events: `downloads.update {}` on every state change (queued, started, paused, resumed, canceled, failed, completed, removed) and `downloads.progress {id, bytesDownloaded, totalBytes?, bytesPerSecond}`, at most 4 per second per download. The first chunk of every attempt emits at once, so the UI sees a resumed transfer start where it left off. In the UI a `downloads.update` refetches only `downloads.list` and the `myvideos.` queries (`DEFAULT_EVENT_INVALIDATION` in `src/api/query.ts`), never `downloads.dir`. A `downloads.progress` event re-renders only the /downloads row it is about (`useLiveProgress`), and a movie or series page refetches `downloads.list` only for progress of its own rows ([performance.md](performance.md#progress-clocks-and-formatters)).

## Lifecycle

```
start -> queued -> downloading -> completed
                     |  ^   \-> failed  -- retry/resume --> queued
              pause  v  | resume
                   paused
cancel (any unfinished state) -> canceled -- retry --> queued
completed (file missing) -- retry --> queued
```

- `start` validates the URL (http/https only) and title, then inserts the row or reuses the row for the same `(ref, episodeId)`. Queued, downloading, and paused rows, and completed rows whose file still exists, come back unchanged. Failed, canceled, and completed-but-missing rows lose any retained `.part` and restart under the same id. Before returning, `start` reserves the destination and persists `fileName`/`filePath`.
- The runtime claims a row with a conditional `queued -> downloading` update. `resume`/`retry` use a conditional `paused|failed|canceled -> queued` claim and the queue rejects duplicate ids, so two rapid clicks can never start two transfers.
- `pause`, `cancel`, and `remove` signal the running task and wait (up to 15 s) until it has persisted its final state, so the RPC returns only after the change is on disk. If the task is still winding down after 15 s (for example a write stuck on a network share), the RPC fails with a retryable `Timeout` instead of reporting a change that has not happened; the stop request stays in force, and `remove` leaves the row and files alone so nothing is deleted under a live task. Until the task finishes, the row stays `downloading`, so a second `pause` or `cancel` either waits again or finds the final status. A repeated request can escalate the stop reason (cancel beats remove beats pause, never the other way), so a `cancel` sent after a timed-out `pause` still ends `canceled` with the `.part` deleted. `downloads::set_stop_timeout(state, Some(d))` shortens the 15 s wait for tests.
- `pause` on a queued row pulls the id out of the queue and marks it `paused`; it never starts until `resume` (or `retry`) puts it back, even when both slots free up.
- `retry` on a completed row whose file is gone (deleted, moved, or replaced by something that is not a regular file) clears the recorded path and progress, keeps `fileName`, and queues the same row again; the new transfer reserves that name in the current downloads folder (next free number if taken) and never touches the old path. A completed row whose file is still there gets `Conflict`.
- `init` (boot): rows left `downloading` become `queued`, and every queued row is scheduled in FIFO order (`created_at`, then id). A restored row resumes from its `.part`.

## Destination policy

This follows the old app's `docs/architecture/download-manager.md`, "Destination collision policy":

- Folder: `settings.downloadsDir` when set, else `<data dir>/downloads` (`AppState::downloads_dir`, amendment A5: inside the Tauri asset scope).
- Name: `fileNameHint` (last path component only) or `title` plus ` - subtitle` when present. The extension comes from the hint, then the URL path, then `mp4`. Sanitizing replaces `<>:"/\|?*` and control characters with `_`, collapses whitespace, strips trailing dots and spaces, prefixes Windows device names (`CON`, `NUL`, `COM1`, `LPT1`, ..., also `con.backup`) with `_`, and caps the stem at 150 characters.
- Reservation: the first `name.ext`, `name (1).ext`, ... whose final path is absent gets its `name.ext.part` created with `create_new`. That call is atomic, so concurrent starts can never share a name. The final path stays absent until completion.
- The `.part` is opened only after `symlink_metadata` confirms a regular file, so a symlink planted while the download was paused is never followed.
- Completion moves the `.part` into place without overwriting. `std::fs::rename` replaces existing files, so the move uses a hard link (fails atomically when the target exists) and then deletes the `.part`. File systems without hard links (FAT/exFAT, some network shares) fall back to copying into a destination opened with `create_new`, then deleting the `.part`, so the fallback is equally atomic about the destination at the cost of one extra pass over the data. When the recorded final path got occupied (for example the user created `Movie.mp4` while the download was paused), the next free numbered name wins (`Movie (1).mp4`, with both final and `.part` free) and the row records it.
- Pause keeps the `.part`. Cancel deletes it and clears `fileName`/`filePath`. A failure keeps it when the total size is known and bytes reached disk (retry continues via Range); otherwise it is deleted. A `.part` that cannot be deleted (locked file) keeps its row and path so a later cancel or remove retries the cleanup.
- `remove {deleteFile}` deletes the row's file only when `deleteFile` is true: the `.part` of an unfinished row, or the media file of a completed one (only if it is a regular file). With `deleteFile: false` an unfinished row's `.part` stays on disk; a later download of the same item reserves its own `.part`, so the kept one is never reused or overwritten. A completed row's leftover `.part` is always deleted.
- `fileAvailable` is derived on every read for completed rows: true only for a regular, non-symlink file at `filePath`. `downloads.list` and `myvideos.list` check their files on the blocking pool (`present_all`), so a file on a sleeping disk does not hold up a runtime worker. A missing file never changes the persisted `completed` status. Starting the same item again re-downloads it.

## Transfer

- URL refresh: every run (start, resume, retry, restart after a missing file, boot restore) re-resolves the stream URL from the row's `ref` and `episodeId` before the first request, except for catch-up programmes (live and radio refs): their archive URL cannot be rebuilt from the ref, which would give the live stream, so they keep the stored one. Xtream rows go through `xtream::service::stream_url` (the URL embeds the source's current credentials) and Stalker rows through `stalker::playback::stream_url` (a fresh tokenized `create_link`). The new URL and its headers replace the stored ones (`store::set_source`). M3U/file sources, rows whose source was removed, and resolution failures keep the stored URL, and the transfer then reports whatever the server says. A pause or cancel during resolution stops the run at once. The file name reserved at `start` does not change.
- `GET` through `state.http` with the stored source headers (`headers_json`: User-Agent, Referer, Origin) and `Accept-Encoding: identity`, so byte offsets and `Content-Length` describe the file itself.
- Resume: a non-empty `.part` resumes only with evidence about the representation, meaning a stored `resume_validator` (strong ETag, else Last-Modified) or a recorded `total_bytes`. The request sends `Range: bytes=<offset>-`, plus `If-Range: <validator>` when a validator exists. A `206` must have a `Content-Range` that starts at the offset, and its total must equal the recorded total. A mismatch fails the run and discards the `.part`, because a tail cannot be rewritten in place. Any other `2xx` (Range ignored, or If-Range detected a change) restarts from byte zero over the same `.part`. A `416` truncates and restarts. A `.part` already at the recorded total is finalized without a request. A partial with neither validator nor total restarts from zero.
- Idle limits: the request goes through `http::send_within` with a 15 s limit on the response head (`HEADER_TIMEOUT`), and the copy loop waits at most 20 s (`BODY_IDLE_TIMEOUT`) for the next body chunk. Either becomes a retryable `Timeout`, so a panel that accepts the connection and never answers, or stops sending in the middle of the body, costs 15 or 20 s and a reconnect with Range instead of the shared client's 60 s read timeout. The idle timer starts after the rate-limit sleep, so a speed cap never trips it. `downloads::set_idle_timeout(state, Some(d))` shortens both limits for tests.
- Retry: network and timeout errors, including a body that ends before the advertised size, are retried in the same task with `http::backoff_delay` (300 ms x 2^n plus jitter). After 5 consecutive failures without new bytes the row fails. Only passing the highest offset this run has written counts as new bytes and resets the counter: an attempt that restarted from zero and re-read what it already had does not, so a server that sends a few bytes and then stalls fails after 5 attempts instead of being retried forever. Pausing or canceling interrupts the backoff sleep.
- Progress is written to SQLite every 2 s and when an attempt ends. The periodic write runs in its own task, so the copy loop never waits for it (an import can hold the write lock for seconds); while one is in flight the next is skipped, and the attempt's final write waits for it, so an older count never lands last. `downloads.list`/`get` overlay the live in-memory byte count for running transfers.
- Every attempt ends with `flush` + `sync_data` before the outcome is recorded.
- Error messages stored in `errorMessage` name the problem and the next action, and never contain the URL (reqwest errors are stripped of URLs in `error.rs`).
- `downloads::set_rate_limit(state, Some(bps))` caps per-transfer speed. Running transfers re-read the cap on every chunk (sleeps are sliced to 200 ms), and a change restarts the pacing baseline, so lifting or setting a cap applies to in-flight downloads immediately without a catch-up burst. Tests use it to make pause points deterministic. It is a Rust function, not a C4 command.

## Folder, reveal, playback

- `downloads.dir` returns the effective folder. `downloads.setDir` requires an absolute, existing directory and proves it is writable with a `create_new` probe file that it then deletes. It then stores the path in `settings.downloadsDir` through B2's `iptv_core::settings::save`, which validates, writes the settings row, refreshes the `AppState.settings` cache, and emits `settings.changed` (nothing is written and no event fires when the folder is unchanged). An empty path resets to the default. Rows that already have a destination keep it, so switching folders never strands a paused download.
- `downloads.reveal` (desktop only; `Unsupported` on the server) opens the containing folder. On Windows it uses `explorer /select,` so the file, or its `.part`, is highlighted.
- `myvideos.list` lists completed rows, most recently completed first, with `fileAvailable`. `myvideos.playSource` returns `kind: 'file'`. On desktop the URL is the loopback proxy's `.../files/{id}/media.<ext>`, which streams the file with Range support ([desktop.md](desktop.md#what-it-serves)); when the proxy is not running it is the absolute file path, which the UI converts with `convertFileSrc` (amendment A5). mpv and VLC are handed the path either way. On the server it is `/api/files/{id}`. `resumeSeconds` comes from `downloads.setPosition`. A missing file returns `NotFound` with a hint to download again.
- `downloads::completed_file(state, id)` resolves the path of an available completed download. The server's `GET /api/files/{id}` uses it.

## Tests (check 9)

`cargo test -p iptv-core --test downloads` runs against `iptv_fixtures::spawn_mock()` (C13 `/files/video.bin` 20 MiB with ETag and Range, `flaky.bin` dropping the first response after 5 MiB (or, with `stall=1`, holding it open with no more bytes), `nolen.bin` with no length and no Range; `?size=` overrides the length). The harness asserts that the mock answers `Range: bytes=0-0` with 206, and file contents are checked against `iptv_fixtures::video_bytes`. The test covers:

- pause/resume continues from the byte offset: `.part` size equals the paused offset, the first progress after resume is past it, and the file is byte-exact;
- cancel removes the `.part`, and retry starts over;
- the same name twice gives `video.bin` and `video (1).bin`, then `(2)`;
- the flaky endpoint retries and completes byte-exact;
- a body that stalls with the connection open reconnects after the idle limit and completes byte-exact with one extra request, and a server that sends 8 bytes and then stalls (`/fail/stall.m3u`) fails after exactly 5 requests;
- an existing destination is never overwritten, both at start and when it is occupied while paused;
- `nolen.bin` downloads without resume;
- at most two transfers run, and the third stays queued;
- the queue is restored on `init`, and the restored row resumes from its `.part`;
- My Videos and `playSource`: missing-file derivation, `setPosition`, `remove` with and without `deleteFile`;
- `setDir` validation, persistence through `settings::save` (one `settings.changed`, none when unchanged, visible to a fresh `AppState`), file-instead-of-folder rejection, and reset;
- `retry` of a completed item whose file was deleted re-downloads it under the same row and name; a folder squatting on the old path is left alone; `myvideos.list` reports `fileAvailable: false` meanwhile;
- `pause` on a queued item: stays paused with an untouched `.part` after both slots free up, then `resume` completes it;
- `remove {deleteFile: true}` on paused, running, and completed rows deletes both the media file and the `.part`;
- `remove {deleteFile: false}` on a paused row removes the row and keeps its `.part` at the same size, and a new download of the same item reserves a different file;
- the rate limit applies to a running transfer in both directions (lifted and imposed mid-transfer);
- `start` input validation;
- Xtream re-resolution: a download queued with a stale URL fails while the source password is wrong, and after the password is edited `retry` completes and persists the new URL; a start with an expired URL on a correct source completes;
- a `pause` that times out (SQLite write lock held from another connection, stop wait shortened to 300 ms) returns `Timeout`, leaves the row `downloading` with its `.part`, and a second `pause` succeeds; a `cancel` after a timed-out `pause` ends `canceled` with the `.part` deleted;
- every C4 command is registered.

## What the UI queues

- Movies and episodes from every source kind (`usePlayback` in `src/features/vod/hooks/`). Xtream and Stalker rows take the provider's link (`xtream.streamUrl`, `stalker.streamUrl`); M3U rows take the playlist row's URL from `catalog.item`, with the playlist's request headers under the row's own (`#EXTVLCOPT`), and their file extension from the URL when it names a video container; an M3U episode takes its stored URL and merged headers from `m3u.streamUrl` (m3u.md, Series). An M3U URL that is an HLS playlist (`.m3u8`, `.m3u`) is refused before anything is queued, since the download would save the playlist text.
- A whole season from the series page (Download season): the season's episodes without a download, or with a failed, cancelled or missing one, one `downloads.start` after another; one toast counts what was queued and another what was not.
- Catch-up programmes from the archive page (`ArchivePage`, finished programmes only): the portal's timeshift link or the M3U catch-up URL (`catchupDownloadArgs` in `src/features/live/lib/playback.ts`), behind the parental gate like playback. The row is the channel's ref with episode id `catchup:<start>`, title the channel, subtitle `<programme> · <day> <time>`, and the file is saved as MPEG-TS unless the URL names another container. HLS and DASH archives are refused. My Videos groups these rows under the channel.

## The Downloads page

`/downloads` (`DownloadsPage`) lists the queue (downloading, queued, paused) and Needs attention (failed), each under the kit's `SectionHeader` with its count, a hint and its bulk action (Clear failed) at the end of the heading line. A row's actions are ghost icon buttons in a column as wide as the most any row has (three), shown or not, so every bar, badge and button ends on one line, and the folder line above the list shares the list's box. A row that is waiting or paused shows its actions on hover or focus with a fine pointer; a downloading row and a failed one always show them, since a failed row is there to be retried or removed.

## Tests (UI)

`src/features/library/test/round2.test.tsx` (a failed row's actions, the fixed actions column), `src/features/vod/test/pages.test.tsx` (M3U movie, HLS refusal, Download season) and `src/features/live/test/guideArchive.test.tsx` (archive download). `crates/iptv-core/tests/downloads.rs` checks that a catch-up row keeps its archive URL.

## Not carried over from the old app

- Multi-connection parallel range downloads (`.part.parallel`, `.ranges.json`). The brief asks for range requests and resumable partials, and one connection per transfer keeps the two-transfer cap meaningful for providers that limit connections.
- Metadata snapshots for offline detail pages. The row keeps title, subtitle, poster, and ref, which is enough for My Videos.
