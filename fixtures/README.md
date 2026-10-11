# Test fixtures

Static inputs shared by Rust tests, the mock server (`crates/iptv-mock`) and e2e.

## Port 7290 is baked in

`sample.m3u`, `sample.xml` and `backup-v1.json` contain absolute URLs rooted at
`http://127.0.0.1:7290`, the port e2e runs `iptv-mock` on. `sample.m3u` has
`url-tvg="http://127.0.0.1:7290/xmltv/sample.xml"`.

Tests that start the mock on another port should not read these files for
URLs. Use the served versions instead: `/m3u/sample.m3u` and
`/xmltv/sample.xml` are generated with the server's own base URL, and the
served guide starts the day before today so now/next always resolves. The
static `sample.xml` is anchored at 2026-01-01 UTC so it never changes.

## Generated text files

These are produced by the generators in `crates/iptv-mock` and
`crates/iptv-fixtures`, and tests fail if they drift:

- `sample.m3u`: 25 channels, 4 groups (News, Sports, Entertainment, Music),
  one `radio="true"` entry, logos, catch-up attributes.
- `sample.xml`: 3 days for those 25 channels; ids match `tvg-id`.
- `xtream-*.json`, `stalker-*.json`: sample API payloads with a fixed clock of
  2026-01-01 12:10 UTC.
- `backup-v1.json`: `iptv_fixtures::backup_manifest_v1()` with `{mock}`
  replaced by `http://127.0.0.1:7290`. The function keeps the `{mock}`
  placeholder so callers can substitute their own mock base; the file is
  pinned to the literal `http://127.0.0.1:7290`, and tests that import it
  must rewrite that prefix if their mock runs elsewhere.

To regenerate after changing a generator:

```
UPDATE_FIXTURES=1 cargo test -p iptv-mock --test routes
UPDATE_FIXTURES=1 cargo test -p iptv-fixtures
```

## Stalker VOD-as-series row

Real Ministra portals often file box sets among the films: a row in
`vod get_ordered_list` with `is_series: "1"`, whose seasons and episodes come
from further `vod get_ordered_list` calls with `movie_id`. The mock has one
such row so the "series row inside `stalker.movies` opens the series detail"
path can be tested without request interception.

- Row: id `5030` (`iptv_mock::stalker::VOD_SERIES_ID`, re-exported as
  `iptv_fixtures::STALKER_VOD_SERIES_ID`), title "The Lantern Keepers",
  category `11` (Drama & Family), poster
  `/img/poster/the-lantern-keepers.svg`, `series: []`. It takes the last
  listing slot, which was the film "Saturday Champions" (Xtream 230), so the
  unfiltered listing still totals 30, rows 5001..5029 keep their ids and
  order, and category 11 keeps its size. `stalker.movies` returns it with
  `ref.contentType = "series"`; it is the 30th item (page 3 at 14 per page)
  and `stalker.search` for "lantern" finds it.
- Seasons: `movie_id=5030` returns `5030:1` and `5030:2` (`is_season: true`,
  `video_id: "5030"`).
- Episodes: `movie_id=5030&season_id=5030:<s>` (or `movie_id=5030:<s>`)
  returns `is_episode: true` rows `5030:<s>:<e>`. Season 1 has 3 episodes
  ("The Lamp Room", "Fog Signal", "Low Tide Ledger"), season 2 has 2 ("The
  Relief Keeper", "Last Light"), so the season sizes differ. The core turns
  these into episode ids `v|5030:<s>|5030:<s>:<e>`.
- Playback: episode `cmd` is `/media/file_5030<s><e>.mpg`, and `create_link`
  answers `ffmpeg {base}/xtream/series/demo/secret/5030<s><e>.mp4` (the
  sample clip). `movie_id=5030:<s>:<e>` returns that episode's single file
  row, for clients that resolve file ids.
- Payloads: `stalker-vod-series-seasons.json`, `stalker-vod-series-episodes.json`.

Every other film id (`movie_id=5001` etc.) still answers an empty page.

## Media

Generated once with ffmpeg and embedded in the mock with `include_bytes!`.

- `sample.mp4`: 60 s, 320x180 colour bars, H.264 baseline and AAC, faststart,
  a keyframe every second. Served for every Xtream movie and episode.
  ```
  ffmpeg -f lavfi -i "smptebars=size=320x180:rate=15:duration=60" -f lavfi -i "sine=frequency=440:duration=60" -c:v libx264 -profile:v baseline -crf 30 -g 15 -c:a aac -b:a 32k -ac 1 -movflags +faststart sample.mp4
  ```
- `sample.webm`: the same clip as VP9 and Opus, for browsers without H.264
  (Playwright's bundled Chromium).
- `hls/seg-00.ts` .. `hls/seg-15.ts`: one continuous 32 s MPEG-TS clip
  (H.264 with a keyframe every 2 s, AAC 48 kHz, 880 Hz tone) cut into 2 s
  segments. Live segment `n` (`/xtream/seg/{n}.ts`) is `seg-{n % 16}` with
  its PTS, DTS and PCR shifted by `(n / 16) * 32 s`, so the live playlist is
  one continuous stream with no `#EXT-X-DISCONTINUITY` tags. 32 s is 1500
  AAC frames at 48 kHz, so audio also lines up at the wrap.
  ```
  ffmpeg -f lavfi -i "smptebars=size=320x180:rate=15:duration=32" -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=32" -c:v libx264 -profile:v baseline -crf 32 -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 -c:a aac -b:a 32k -ac 1 -ar 48000 -f segment -segment_time 2 -segment_format mpegts -reset_timestamps 0 "hls/seg-%02d.ts"
  ```
- `seg.ts`: a copy of `hls/seg-00.ts`, kept as a standalone valid TS clip.
- `radio.mp3`: 20 s, 48 kbps, served at `/media/radio.mp3`.
