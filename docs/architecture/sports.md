# Sports

Code: `src/features/sports/`. Tests: `src/features/sports/test/` (the ESPN normalizer and day helpers, the name normalizer and network aliases, `matchGame`, the polling policy, the stream hooks, the page with those hooks mocked, and the page end to end with its real hooks in `integration.test.tsx`). The tests never reach the network: they stub `fetch` or mock the game hooks, the core is a mocked `rpc`, and the fixtures in `test/fixtures/` are trimmed real ESPN responses.

`/sports` lists NFL, college football (FBS), NBA and MLB games from a week back to a week ahead, with the user's channels that carry each game. It is frontend only. There is no Rust code, no new command, event, setting or migration: the games come from ESPN's scoreboard API, which the page fetches itself, and the streams come from RPCs the app already has (`catalog.categories`, `catalog.channels`, `catalog.search` and `epg.grid`). Nothing links an ESPN game to a channel for certain. Every stream on the page is matched from names: the channel's name, the text of its TV guide, and the networks ESPN lists for the game.

## Public surface (`index.ts`)

| Export | What it is |
| --- | --- |
| `sportsRoutes`, `SPORTS_PATH` | One lazy route, `/sports` → `SportsPage`. The app router mounts it among the shell layout's children. |

The rail's Watch group lists it after the TV guide (`WATCH_LINKS`, label `sports:title`), the phone's More sheet lists it beside Multi-view, and the command palette finds it as `nav.sports` (keywords such as NFL, NBA, MLB, college football and scores). The strings are in the `sports` namespace, in all 19 languages. Team names, notes and network names are ESPN's English text and are not translated.

## Game data: ESPN's scoreboard

ESPN's scoreboard API is unofficial. ESPN doesn't document it, asks for no key, and promises nothing: fields can change and the endpoint can stop answering without notice. `lib/espn.ts` therefore reads every field defensively (`normalizeScoreboard`): a missing optional field becomes a default, an event without both teams is skipped, and a body that isn't a scoreboard gives no games rather than an error.

### Requests

One plain GET per league and US Eastern date (`scoreboardUrl`, `fetchScoreboard`):

```
https://site.api.espn.com/apis/site/v2/sports/{football/nfl | football/college-football | basketball/nba | baseball/mlb}/scoreboard?dates=YYYYMMDD&limit=300
```

College football adds `&groups=80`, which keeps it to FBS. ESPN answers date ranges with HTTP 400, so the client never asks for more than one day. The request carries no custom headers, so the browser sends it as a simple CORS request without a preflight (ESPN answers with `Access-Control-Allow-Origin: *`). The desktop CSP and the server's page CSP both allow `https:` in `connect-src` and `img-src`, which covers the scoreboard and the team logos on `a.espncdn.com`. In server mode the browser makes these requests, not the server.

`dates=` returns exactly one US Eastern calendar day: an 8:20 PM ET kickoff dated 00:20Z the next UTC day comes back under the Eastern date. The page's days are Eastern days for that reason. `etDate(ms)` gives the Eastern date of a time and `etDays(now, 7, 7)` the 15 dates of the day strip, oldest first, computed in `America/New_York` (`ET_ZONE`) whatever the machine's time zone. Start times are shown in the user's own zone.

### Normalizing

`normalizeScoreboard(league, json)` turns one response into `Game[]` (`lib/types.ts`), sorted by start (ESPN returns past college days sorted by rank):

- `phase` comes from the status name first: postponed, canceled and suspended games are named so. Otherwise ESPN's `state` decides: `in` is live, `post` is final, `pre` is scheduled. A postponed game has state `post` with `completed` false, so `post` alone never means final.
- `score` is null before the start and for postponed and canceled games (ESPN sends `'0'` there).
- `rank` is the college poll rank from 1 to 25, otherwise null (ESPN sends 99 for unranked teams). `record` is the overall record.
- `broadcasts` is the union of `geoBroadcasts` (TV and streaming; radio dropped) and the names in `broadcasts[]`, one entry per name and market. NBA League Pass is only in `broadcasts[]`.
- `timeValid` is false for a TBD start, which ESPN dates at midnight Eastern. `timeNote` keeps a kickoff-window note (`EARLY:`, `FLEX:`, `NIGHT:`, `LATE:`), whose listed time is a placeholder.
- `gamecastUrl` is the event link whose `rel` includes `summary`.

No game was live while the responses were surveyed, so the live payload (clock, period, halftime and delay statuses) is unverified. Live detection rests on `state === 'in'` alone, never on status names.

### Caching and polling

`hooks/useGames.ts` runs one React Query per league and Eastern date, keyed `['sports.espn', league, etDate]` (`sportsKey`), so the day view and "Live now" share requests. This is not an RPC key, so core events don't invalidate it (a `resync` still invalidates every query). The global retry only retries `RpcError`s, so these queries set their own: two retries with backoff (1 s, then 2 s). After a failure the last good games stay on screen.

The queries fetch even when the webview reports no network (`networkMode: 'always'`). Offline, the fetch and its two retries fail within about 3 seconds and the page shows its error, instead of a skeleton that waits for the network. `refetchOnReconnect` fetches again as soon as the network is back.

How often a day refetches depends on what it holds:

| Day | Refetch |
| --- | --- |
| A game is live, or a timed game still marked scheduled is between 10 minutes before and 3 hours after its listed start (a delayed first pitch) | every 30 s |
| Today, or a past day with a game not yet over | every 5 min |
| A future day (kickoff times, TBD slots and TV picks change during the week) | every hour |
| A past day whose games are all over (settled) | never (`staleTime: Infinity`) |

Polling pauses while the document is hidden (`refetchIntervalInBackground: false`) and stops when the page unmounts. When the window shows again, a stale day refetches at once (`refetchOnWindowFocus`, which the rest of the app turns off); a settled day is never stale. ESPN sends no `ETag` or `Last-Modified`, so every poll is a full download: a busy college Saturday is about 1 MB of JSON (60 to 80 KB gzipped), an NBA day about 250 KB. Only the normalized games are kept.

The page fetches only what it shows: the picked day for the picked leagues (`useSportsDay`), plus today and yesterday for "Live now" (`useLiveGames`, games with state `in`; yesterday because a late game runs past midnight in yesterday's bucket). With every league picked that is at most 12 requests (8 when the picked day is today or yesterday).

`TYPICAL_LENGTH_MS` holds rough game lengths (NFL 3 h 15, college football 3 h 30, NBA 2 h 30, MLB 3 h). `gameWindow(game)` is when the game is likely on air: from 30 minutes before the start to an hour past its typical length, or the whole Eastern day plus 4 hours when the start is TBD or only a window note.

## Finding the user's channels: the channel index

`useChannelIndex` builds the list of channels that can carry games, from every visible source (`useVisibleSources`):

1. Sports groups. `catalog.categories {sourceId, contentType: 'live', includeHidden: true}`, the Live page's own query, minus the hidden groups, keeping the groups whose names look like sports (`isSportsGroup`: sport, NFL, NCAA, college, NBA, MLB, League Pass, Sunday Ticket, ESPN+, Peacock, PPV, events, regional and so on; a wrong group costs a page read, a missed one costs games). Each group is paged whole with `catalog.channels` at 1000 rows a page.
2. Networks. One `catalog.search` per distinct search word of `NETWORKS` across all sources (live only, up to 200 hits; about 60 searches, three at a time). A hit stays when its normalized name is a known network (`networkIdForChannel`), under that network's own id: the search for "ESPN" also finds ESPN2 and ESPNews, which count as themselves. A hit whose name holds a matchup (`hasMatchup`, such as "ESPN | Knicks @ Celtics") stays too, as an event channel. The longest phrase at the start of the name wins, so ESPN doesn't take ESPN2, ESPNU, ESPNews, ESPN+ or ESPN Deportes, and FOX doesn't take FS1 or FS2. Avoid lists keep FOX from taking Fox News or Fox Business, and keep a brand from its editions abroad that carry no country tag ("ESPN Brasil", "FOX Footy", ESPN 3 to 7). A bare "USA" never matches. These answers stay fresh for 10 minutes.
3. Rows are deduplicated by item key.

The query keys start with `catalog.`, so an import, a channel edit, a quality filter change or a parental change refetches the index. Because every row comes through the catalog readers, the index follows the same filters as Live TV: the quality filter, parental hide mode, English only, hidden channels and hidden groups. A channel the Live page hides never shows on the Sports page. One side effect: "Hide channels with no quality tag" hides most per-game event channels, which rarely carry a quality tag.

Channel names are compared as tokens (`nameTokens`): the country prefix is stripped as Live TV strips it, accents and case are folded, the name is split on anything that isn't a letter or digit, and quality, codec and backup words (HD, FHD, 4K, 1080p, HEVC, backup and the like) are dropped, so "US| ESPN HD" is the ESPN network. "@" reads as "at", so "Knicks @ Celtics" and "Knicks at Celtics" read alike. A spaced dash is its own token: it separates two team names ("Knicks - Celtics") but never turns a network name into a matchup.

A network name followed by a matchup written with "vs", "v", "versus", "at", "@" or "x" is one game's channel, not the network. "ESPN | Knicks @ Celtics" and "ABC: LSU vs Auburn" get no network id, so they match only as event channels or through their guide and never show up under the network's other games. A dash alone doesn't count, so "US: ESPN - East" and "SNY - Mets" stay networks; the cost is that a dash-only name such as "ESPN: Knicks - Celtics" is also read as ESPN. Package services keep their id there, since all their channels are per-game feeds, but a package never makes a network match anyway.

A feed from outside North America (`foreignFeed`) shares a US network's name but not its programming, so it gets no network id either. The channel's own country tag decides ("BR: ESPN", "AU| FOX FOOTY"), or a country word opening an untagged name ("Brasil", "LATAM"), or, when the name says nothing about its country, its group's tag ("ESPN" in "LATAM| DEPORTES"). Such a feed can still match through its guide or as an event channel, and it is listed after the other streams of the same kind.

`NETWORKS` covers the national networks (ESPN and its family, ABC, CBS, NBC, FOX, FS1, FS2, TNT, TBS, truTV, USA Network, CW), the league and conference networks (NFL Network, NFL RedZone, NBA TV, MLB Network, Big Ten Network, SEC Network, ACC Network, CBS Sports Network, Pac-12), the streaming services and league packages (ESPN+, Peacock, Prime Video, Netflix, Apple TV, Paramount+, Disney+, NBA League Pass, MLB.TV, NFL Sunday Ticket) and the regional sports networks ESPN names (FanDuel Sports Network regions, NBC Sports regions, NESN, YES, MSG, SNY, Marquee, Spectrum SportsNet, Space City and others).

## Matching a game: `matchGame`

`lib/match.ts` is pure: `matchGame(game, index, programs, now)` returns the game's streams, one per channel, each with the strongest reason that applies. `now` matters only for event channel names without a date.

| Reason | Rule | Limits |
| --- | --- | --- |
| `guide` | A programme on an indexed channel overlaps `gameWindow(game)` and names each team, in its title (abbreviations count) or its description (they don't), and its title and category name no other league. Shows around the game are skipped even though they name both teams: a title with pregame, postgame, pre game, post game, preview, recap, highlights, countdown or classics. For a timed game the programme must cover the game itself: it overlaps the span from the start to the start plus the typical length by at least 30 minutes, or by half the programme when that is less, so a show that only touches the window doesn't count. The programme with the most overlap wins. The strongest match. | Needs a guide mapped to the channel. The XMLTV parser keeps the first title and description and skips `<sub-title>`, so a guide that names the teams only in the sub-title can't match ([epg.md](epg.md)). The guide keeps programmes that ended less than 2 days before its last import, so a game older than about two days has no guide entry. |
| `event` | The channel's own name names both teams, as providers name their per-game channels, and no other league. With "@" or "at" between the teams the away team must come first, except at a neutral site; "vs" and "x" go either way. A date in the name must be the game's Eastern day. A time must be within 3 hours of the start, read in the zone the name gives (ET, CT, MT, PT, UK, GMT or CET and their variants; Eastern when none) and as either half of the day when it has no am or pm. Times aren't checked for a TBD start or a window note. A name without a date matches only a game that started within the last 36 hours or starts within the next 24. A network name followed by a matchup is an event channel (above). | Misses channels named by slot only ("NBA 05") and names that use team abbreviations the alias table doesn't know. An undated name matches every meeting of the two teams inside that window. |
| `network` | The channel is a network ESPN lists as a TV broadcast of the game, or a local station ESPN lists, found by its call sign anywhere in the name. | Never for package services (ESPN+, Peacock, Prime Video, League Pass, MLB.TV, Sunday Ticket, Paramount+, team apps): those are per-game feeds, so a package channel counts only through its name or its guide. Never for a feed from abroad or a network name followed by a matchup (above). |

`regional` marks a network match that may show a different game: an NFL regular-season Sunday game carried only by CBS or FOX (ESPN lists those regional broadcasts as national and never lists Sunday Ticket), and regional sports networks and local stations (home or away market). A guide programme that confirms the game on that channel makes it a `guide` match with `regional` false.

Teams match by phrases and abbreviations (`teamKeys`, `mentionsTeam`, `mentionsBoth`). For the pro leagues: the nickname ("Celtics"), location and nickname, the short name, and the abbreviation as a whole token, with an alias table for provider spellings (NY and NYK, GS and GSW, SA and SAS, NO and NOP, UTAH and UTA, WSH and WAS, and more). For college teams: the school, the short name and the full name, longest phrase first, so "Texas" doesn't take "Texas A&M", "Texas Tech" or "Texas State", and "Miami" doesn't take "Miami (OH)". Both teams must match, which keeps nicknames shared across leagues (Cardinals, Giants, Rangers, Panthers) from crossing over, and a league or sport word for another league rules the text out ("MLB 07: Giants x Cardinals" is not the NFL game).

Order: guide, then event, then network; inside each, non-regional first, then feeds from abroad last, then the order of the sources, then the channel name. The stream list then moves the rows that can act now (Watch, Replay or Record, below) ahead of the rest, keeping this order inside each group, so a final game's one archived copy doesn't hide behind "Show all" under rows with no button.

## The guide window: `useGuideWindow`

`useGameStreams(games)` asks `useGuideWindow` for the programmes of every indexed channel over the union of the games' windows: `epg.grid` with `withDescription: true`, at most 500 refs a call. The query window is the display window minus `epgOffsetMinutes`, and the answers are shifted back to display time with Live's helper, so they compare with ESPN's times. The keys are `rpcKey('epg.grid', …)`, so a guide refresh refetches them.

A game keeps its matches until the index or the guide changes. `now` comes from a one-minute clock, and a game is matched again only when it moves into or out of the window for undated event names.

It uses `epg.grid` rather than `epg.search` because search reads titles only and maps channels by exact name, while US guides usually title a game "NBA Basketball" and put the teams in the description, and the grid also maps channels by fuzzy name ([guide-search.md](guide-search.md)).

## Fallback search

A game that is live or starts within 3 hours and has no stream after the index and the guide gets one more try: one `catalog.search` per team name (live only, up to 30 hits). This finds event channels in groups whose names don't look like sports. A hit counts only after the same checks as an event channel, both teams included. At most 2 of these searches run at once, and only for games on screen: each search ranks every match in the core before the limit applies, and the core has 8 database connections that every other page reads through.

## Actions

Each stream row offers what fits the game:

- Watch, while the game is live and from 15 minutes before the start: `playChannel`, loaded with a dynamic import, with the channel's name as the player's title and "Away at Home" under it. Once the channel plays, the page sets the player's `zapContext` to its source and group, so channel up and down walk that group instead of the last Live TV group.
- Replay, after the game: `playCatchup` from the channel's archive, over the programme `gameProgram` builds. That is the matched guide programme, or without one a slot from 10 minutes before the start. Games run past the typical length (overtime, extra innings, a late first pitch) and a catch-up link stops at its end, so for a timed game the end is at least an hour past the typical length (the end of `gameWindow`), later when the guide slot ends later. A game that ended minutes ago asks for nothing past now. A TBD start or a window note with no guide programme gets neither Replay nor Record. Replay shows only when the channel has a usable archive and that programme is inside it (`canCatchUp`); a channel without an archive gets no action. The provider decides how far back its archive goes, and a refused replay shows an error toast.
- Record, before the start and only where recording is supported: `useScheduleActions().record` with the same programme. The recording padding from Settings applies on top.

The page draws no player stage. Playback opens in the mini player, and the player loads on the press, so the route chunk (`SportsPage-*.js`) holds none of the player's UI; `tools/check-bundle.mjs` checks this.

## Page

- The league (`?league=nfl|cfb|nba|mlb`, every league by default) and the day (`?day=YYYY-MM-DD`, an Eastern date, today by default) live in the URL; the defaults leave their parameter out. A `?day=` opens only when it is inside the strip's window and was picked on the strip during this run of the app (`pickDay` and `readDay` in `paths.ts`); anything else opens today. lastRoute saves the query and startup restores it, so without that check a day picked in an earlier run would come back on the next launch.
- League pill tabs (All, NFL, College Football, NBA, MLB), then "Live now" while any game of those leagues is on, whatever the day, then the day strip (Yesterday, Today, Tomorrow, other days as a date) and the day's games by league, each league with a count ("12 games, 9 with streams"), live games first and then by start.
- A game card shows the away and home teams with logos, college ranks, records and scores, the status (LIVE with ESPN's clock line, Final or Final/OT, the start time in the user's language and zone, TBD, or a Postponed, Canceled or Suspended badge), ESPN's note or the playoff series line, the networks, and a Gamecast link to ESPN's page.
- Under it, the matched streams, rows with an action first: three, then "Show all". Each row has the channel's logo and name (`displayChannelName` with the strip-country-prefix setting), the source's name when there are several sources, a badge for the reason ("In guide", "Event channel", "Network") and a "Regional" warning where it applies.
- No stream: "No stream found", with a note that the quality filter may be hiding channels while one is set.
- Loading shows a skeleton. When ESPN fails the page shows an error with its own title and hint (the shared hint talks about the provider's URL), and keeps the games it already has. An empty day says "No games on this day". With no sources the page still lists games and links to adding a source.

## Limits

- ESPN's API is unofficial (above). If it changes, the page shows an error or fewer details until `lib/espn.ts` is updated.
- Streams are matched from channel names, the TV guide and network names. A match can be wrong (a regional network showing another game, or an undated event channel of two teams that meet on consecutive days, as in an MLB series, which matches both games) and a game can be missed (an unknown abbreviation, an event channel in an oddly named group, a channel the user renamed, which matches by its new name).
- Past games play only where the provider keeps a catch-up archive for the channel and the game is still inside it.
- The guide usually holds only about two days of past programmes, so older games match by channel name and network only.
- The four leagues are fixed, and college football is FBS only.
