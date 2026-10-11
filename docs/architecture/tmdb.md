# TMDB enrichment

Code: `crates/iptv-core/src/tmdb/`. Tests: `crates/iptv-core/tests/tmdb_rpc.rs`
plus unit tests in each module. Contract: SPEC C4 (tmdb) and C3 (`tmdb_cache`).

## Attribution (required)

Any screen that shows TMDB data (detail pages, the TMDB settings section, the
About page) must carry this notice:

> This product uses the TMDB API but is not endorsed or certified by TMDB.

Show the TMDB logo next to it, less prominent than the app's own logo, and
link it to https://www.themoviedb.org. Use the official logo files from
TMDB's brand page without changing them.

## Modules

| File | Role |
| --- | --- |
| `config.rs` | Constants (base URL, image sizes, TTLs, limits), language mapping, key resolution |
| `normalize.rs` | Title normalization and year extraction, ported from `title-normalization.util.ts` |
| `matcher.rs` | Search variants, confidence gate, provider-id check, cache lookup keys |
| `raw.rs` | Serde types for TMDB v3 responses (lenient: missing or null fields default) |
| `map.rs` | Raw to `model::Tmdb*` mapping: cast/crew picks, trailer choice, language fallback |
| `client.rs` | HTTP client: auth placement, retries, 429 handling, concurrency cap |
| `cache.rs` | In-memory LRU (300) in front of SQLite `tmdb_cache`, with in-flight coalescing |
| `service.rs` | `Tmdb` singleton: resolution order and each rpc operation |
| `rpc.rs` | The eight `tmdb.*` commands and `COMMANDS` |

## Commands

| Command | Disabled / no key | Notes |
| --- | --- | --- |
| `tmdb.movie {title, year?, tmdbId?}` | `null` | Provider id first, then title search |
| `tmdb.tv {title, year?, tmdbId?}` | `null` | Same flow |
| `tmdb.season {tmdbId, season}` | `null` | A 404 is negatively cached and returns `null` |
| `tmdb.person {personId}` | `null` | English biography fallback when the localized one is empty |
| `tmdb.trending` | `[]` | `trending/all/week`, persons dropped, deduplicated, max 40 |
| `tmdb.similar {mediaType, tmdbId}` | `[]` | Read from the cached details payload |
| `tmdb.testKey {apiKey}` | works | `GET /configuration`; a blank key tests the resolved one |
| `tmdb.clearCache` | works | Deletes every row and the memory layer |

"Disabled" means `settings.tmdb.enabled` is false or no key resolves; neither
touches the network. Ids `<= 0` return an `Invalid` error. Upstream failures
(network, auth, rate limit after retries) propagate as `RpcError`s rather than
`null`, so the UI can tell "no match" apart from "TMDB is down".

## API key

Resolution order:

1. `settings.tmdb.apiKey`
2. `TMDB_API_KEY` in `<data_dir>/.env`
3. `TMDB_API_KEY` in `./.env`, production only (`Tmdb::from_env`). Tests use
   `Tmdb::new`, which skips the cwd.

The `.env` parser is hand-written (no dotenv crate): it handles `KEY=value`,
`export KEY=value`, single or double quotes, `#` comments, and a BOM. The
process environment is never read for the key.

A key starting with `eyJ` or longer than 64 characters is a v4 read access
token and is sent as `Authorization: Bearer`. Anything else is a v3 key and is
sent as the `api_key` query parameter.

The key is never logged. `ApiKey` and `TmdbSettings` have redacted `Debug`
impls. Logs record only the API path, never the URL. reqwest errors are
stripped of their URL (`without_url`) before they become messages, because the
URL can carry `api_key`. `tests/tmdb_rpc.rs::network_errors_never_echo_the_key`
checks this.

## Base URL

The default is `https://api.themoviedb.org/3`. The `TMDB_BASE_URL` env var
overrides it in production (`Tmdb::from_env`). Tests call
`Tmdb::new(http, url)` and `Tmdb::install(&state, ..)`. Image URLs always use
`https://image.tmdb.org/t/p/` with sizes `w500` (poster), `w1280` (backdrop),
`w185` (profile), and `w300` (still).

## Language

The language is `settings.tmdb.language` when it is set. A full tag like
`pt-BR` is used as-is; a short code is mapped. Otherwise `settings.language` is
mapped with the old app's table: en to en-US, de to de-DE, ar to ar-SA, ary to
ar-MA, zh to zh-CN, zhtw to zh-TW, by to be-BY, and so on (see
`config::to_tmdb_language`). Unknown codes fall back to en-US.

Cyrillic titles are searched in ru-RU unless the app language is already
Cyrillic. Details missing an overview or a YouTube trailer are refetched once
in the content's `original_language`, and the gaps are filled from that
response. A season with no usable text gets the same treatment, using the
show's original language.

## Matching

Title search sends `query=<variant>`, the request language, and
`include_adult=false`. It deliberately omits a year parameter, because TMDB's
year filters are strict and the tolerance lives in the matcher. Variants are
normalized titles (lowercase, diacritics folded, release noise and the release
tag removed). A leading language token such as `EN -` produces an extra
variant.

The confidence gate (`matcher::match_results`) has three tiers:

1. Exact normalized title, with years compatible when both sides have one.
   Ties go to vote count, then popularity.
2. Fuzzy: `strsim::normalized_levenshtein >= 0.85` and a year within ±1. For
   TV, an earlier premiere year also counts, since providers often tag a show
   with a later season's year.
3. When no year was given and the title ends in a year (`Blade Runner 2049`),
   the form that keeps the year is also compared; unambiguous matches only.

The year is `args.year`, else the release-tag year (`Title (1999)`), else none.
A leading number such as in `2001: A Space Odyssey` is not treated as a year.

A provider `tmdbId` is trusted unless its details contradict the provider's
title and year (`assess_provider_id`). In that case only a confident title
search answers: a different id's details replace it, the same id keeps them,
and when the search finds nothing (or fails) the call returns null rather than
another title's metadata. An
id that returns 404 is negatively cached and the call falls through to the
search.

## Endpoints

- `search/movie`, `search/tv`
- `movie/{id}?append_to_response=credits,videos,similar,external_ids`
- `tv/{id}?append_to_response=credits,aggregate_credits,videos,similar`.
  This departs from SPEC by adding `aggregate_credits`, because TV `credits`
  only covers the latest season. The cast uses the aggregate list and reserves
  slots for newest-season arrivals.
- `tv/{id}/season/{n}`
- `person/{id}?append_to_response=combined_credits`
- `trending/all/week`
- `configuration`, used by `testKey` only

## Cache

The cache is the SQLite table `tmdb_cache(media_type, lookup_key, tmdb_id,
payload_json, fetched_at, expires_at)`. The table has no language column, so
the language is part of `lookup_key`.

| Row | media_type | lookup_key | TTL |
| --- | --- | --- | --- |
| Search match | movie / tv | `title:<norm>\|year:<y>\|lang:<L>\|v1` | 7 days (id only, no payload) |
| Details | movie / tv | `id:<id>\|lang:<L>\|v1` | 7 days |
| Season | tv | `id:<id>\|season:<n>\|lang:<L>\|v1` | 7 days |
| Person | person | `id:<id>\|lang:<L>\|v1` | 7 days |
| Trending | trending | `all:week\|lang:<L>\|v1` | 1 day |
| Any miss | as above | as above | 3 days (negative: `tmdb_id` and `payload_json` NULL) |

Cached details are the mapped model JSON plus hidden `_originalLanguage` and
`_originalTitle` fields. They feed the season fallback and the provider-id
check, and typed deserialization drops them before results leave the service.
Bumping `matcher::KEY_VERSION` invalidates every row.

Lookup order: memory LRU (300 entries), then an in-flight request for the same
key, then SQLite, then the network. Concurrent callers for one key share one
spawned fetch, so a cancelled caller does not cancel the others. Errors are
never cached; only real misses are. A failed cache write still serves the
fetched value. Expired rows are ignored on read and purged by `tmdb::init`.

## Rate limits and retries

- At most 8 requests are in flight, each with a 15 s timeout. Requests go through `http::send` (15 s response-head deadline, URL stripped from errors so the api key never leaks); a transport failure reads "Could not reach api.themoviedb.org. ..." and a timeout "TMDB did not answer in time. ...".
- `http::with_retry(4, ..)` retries Network and Timeout errors with backoff.
- A 429 reads `Retry-After` (seconds or an HTTP date, capped at 10 s, default
  1 s). Every later request waits it out before sending, so one 429 slows all
  callers instead of each finding it separately. The 429 maps to Network and
  is retried.
- 401 maps to Auth ("TMDB rejected the API key..."), 404 to NotFound (a
  negative cache entry), and 5xx to Network.

## Wiring (integrator)

- `crate::tmdb::rpc::register(&mut r)` in `rpc::build_router`.
- Optional: `run_init("tmdb", crate::tmdb::init(state.clone()))` in
  `rpc::init_all` to purge expired rows at boot.
