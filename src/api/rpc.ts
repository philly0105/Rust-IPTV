/**
 * RPC command catalog (SPEC C4). Every Rust module registers exactly these
 * names; `transport.ts` derives `rpc()` argument and result types from here.
 *
 * Conventions:
 * - `args: void` means the command takes no payload (`rpc('app.info')`).
 * - Commands whose args are all optional still take an object (`rpc('favorites.list', {})`).
 * - `result: void` means the command resolves with nothing useful (JSON null).
 */

import type {
  AppInfo,
  Bounds,
  Category,
  Channel,
  ContentType,
  Download,
  EpgLinks,
  EpgNowNext,
  EpgProgram,
  EpgSourceStatus,
  FavoriteEntry,
  ImportSummary,
  ItemKey,
  ItemRef,
  ItemSnapshot,
  M3uOrigin,
  M3uSourceConfig,
  MpvState,
  Page,
  PageQuery,
  PlaybackPosition,
  PlayerSource,
  RecentEntry,
  RemoteStatus,
  RequestHeaders,
  RpcErrorCode,
  SeriesDetail,
  SeriesItem,
  Settings,
  Source,
  SourceKind,
  StalkerSourceConfig,
  TmdbBrief,
  TmdbMediaType,
  TmdbMovie,
  TmdbPerson,
  TmdbSeason,
  TmdbTv,
  VodDetail,
  VodItem,
  WindowState,
  XtreamSourceConfig,
  // failover:
  LiveAlternates,
} from './types';
// recording:
import type {
  Recording,
  RecordingCapabilities,
  RecordingFile,
  Reminder,
  ReminderFiredEvent,
  ScheduleRecordingArgs,
  ScheduleRecordingResult,
} from './types';
// parental:
import type { ParentalLock, ParentalLockTarget, ParentalMode, ParentalStatus } from './types';
// watchlist:
import type { WatchlistEntry } from './types';
// Run 2: channel edits, custom lists, VOD browsing, guide search, stats.
import type {
  ChannelEdit,
  CustomList,
  CustomListEntry,
  GuideSearchHit,
  RecordingRule,
  WatchStats,
  YearFacet,
} from './types';
// Run 3: image cache, screenshot.
import type { ImageCacheStats, ScreenshotResult } from './types';

/** One command: payload and resolved value. */
interface Cmd<A, R> {
  args: A;
  result: R;
}

// ---------------------------------------------------------------------------
// Arg / result helpers shared by several commands
// ---------------------------------------------------------------------------

/** `sources.add` m3u payload. `text` is used when origin is 'text'. */
export interface M3uAddInput {
  origin: M3uOrigin;
  url?: string;
  filePath?: string;
  text?: string;
  headers?: RequestHeaders;
}

export interface SourcesAddArgs {
  kind: SourceKind;
  name: string;
  autoRefresh?: boolean;
  m3u?: M3uAddInput;
  xtream?: XtreamSourceConfig;
  stalker?: StalkerSourceConfig;
}

/** `sources.update` patch. Config changes do not re-import (call `sources.refresh`). */
export interface SourcePatch {
  name?: string;
  autoRefresh?: boolean;
  position?: number;
  m3u?: M3uSourceConfig;
  xtream?: XtreamSourceConfig;
  stalker?: StalkerSourceConfig;
  epg?: Partial<EpgLinks>;
}

export interface SourceCounts {
  /** Live channels only. */
  channelCount: number;
  radioCount: number;
  movieCount: number;
  seriesCount: number;
}

export interface CatalogSearchResult {
  live: Channel[];
  movies: VodItem[];
  series: SeriesItem[];
}

export interface XtreamAccountInfo {
  status: string;
  expDate?: string;
  activeCons: number;
  maxConnections: number;
  isTrial: boolean;
  createdAt?: string;
  serverTime?: string;
  timezone?: string;
  /** Lowercased `user_info.allowed_output_formats`; empty when the panel lists none. */
  allowedOutputFormats: string[];
}

export interface StalkerAccountInfo {
  mac: string;
  status?: string;
  expDate?: string;
  tariff?: string;
  raw: Record<string, unknown>;
}

// account: cached subscription status and the refresh schedule.
/** Cached provider account status (`account.status`); Xtream and Stalker sources only. */
export interface AccountStatus {
  sourceId: string;
  kind: SourceKind;
  /** Provider status text ("Active", "Expired", "Banned", ...). */
  status?: string;
  /** RFC 3339; absent = no expiry reported. */
  expDate?: string;
  isTrial: boolean;
  /** Connections in use (Xtream only). */
  activeCons?: number;
  /** Connection limit (Xtream only; absent or 0 = unlimited). */
  maxConnections?: number;
  /** When the provider was last asked (RFC 3339). */
  checkedAt: string;
  /** Why the last check failed (redacted); the other fields come from the last good check. */
  error?: string;
}

export interface ScheduleEntry {
  sourceId: string;
  /** RFC 3339. The scheduler checks every 10 minutes, so a refresh starts up to that long after this. */
  nextRefreshAt: string;
  /** The next attempt is a retry after a failure. */
  retrying: boolean;
}

/** `sources.schedule`: scheduled sources only (auto-refresh on, interval above 0). */
export interface ScheduleView {
  intervalHours: number;
  sources: ScheduleEntry[];
}

export interface ConnectionTestResult {
  ok: boolean;
  message?: string;
  name?: string;
}

export interface EpgChannelMatch {
  channelId: string;
  displayName: string;
  icon?: string;
  epgUrl: string;
}

export interface EpgResolution {
  epgChannelId?: string;
  via: 'manual' | 'item' | 'name' | 'none';
}

export interface DownloadStartArgs {
  ref: ItemRef;
  episodeId?: string;
  title: string;
  subtitle?: string;
  url: string;
  headers?: RequestHeaders;
  posterUrl?: string;
  fileNameHint?: string;
}

export interface DetectedPlayers {
  mpvPath?: string;
  vlcPath?: string;
}

export interface PlayerCapabilities {
  embeddedMpv: boolean;
  mpvPath?: string;
  vlcPath?: string;
  /** Why embedded mpv is unavailable, when it is. */
  reason?: string;
}

export interface RemotePublishedChannel {
  /** `${sourceId}|${itemId}` */
  id: string;
  name: string;
  number?: number;
  logoUrl?: string;
}

// remote: LAN pairing
/** A private network address the remote control listens on. */
export interface RemoteLanAddress {
  ip: string;
  /** Network adapter name, e.g. "Wi-Fi". */
  interface: string;
  url: string;
}

export interface RemoteServerStatus {
  running: boolean;
  url?: string;
  port: number;
  /** LAN mode on and listening: the addresses, best first. */
  lanAddresses?: RemoteLanAddress[];
  /** LAN mode on but not (fully) listening. */
  lanError?: string;
}

/** `remote.pairingCode`: one-time pairing link and its QR code. */
export interface RemotePairing {
  /** `http://<lan-ip>:<port>/?pair=<code>` */
  url: string;
  address: string;
  expiresAt: string;
  expiresInSecs: number;
  /** Dark modules as one SVG path in a `size` x `size` grid, without quiet zone. */
  qr: { size: number; path: string };
}

export interface RemoteDevice {
  id: string;
  /** Fixed browser and OS names read from the user agent; empty browser = unknown. */
  name: { browser: string; os?: string };
  pairedAt: string;
  lastSeen: string;
}

export interface BackupImportResult {
  imported: number;
  skipped: number;
  warnings: string[];
  /** Background merge: names of the sources whose catalogs load after the call returned (each reports `import.progress`; their favorites and history follow). Absent when empty. */
  refreshing?: string[];
}

/** Value accepted in an mpv JSON IPC command array. */
export type MpvArg = string | number | boolean;

/** `catalog.movies` / `catalog.series` args. */
export interface VodListArgs {
  sourceId: string;
  categoryId?: string;
  query: PageQuery;
  /** Only titles rated at least this (unrated drop out); `total` counts the filtered set. */
  minRating?: number;
  // vod: Run 2 C4.
  /** 1900..2100; `yearFrom <= yearTo` else invalid. Titles without a year drop out when either bound is set. */
  yearFrom?: number;
  yearTo?: number;
  /** Drops titles with an item-level watched row. `total` counts the filtered set. */
  hideWatched?: boolean;
}

/** A ref with the title/logo snapshot stored next to it (`lists.create`, `lists.addItems`). */
export interface RefWithSnapshot {
  ref: ItemRef;
  snapshot: ItemSnapshot;
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export interface RpcMap {
  // ---- app (W0) -----------------------------------------------------------
  'app.info': Cmd<void, AppInfo>;
  /** Desktop only; Unsupported in server mode. */
  'app.openLogDir': Cmd<void, void>;
  /** Desktop only; opens a folder or non-executable file with the OS handler. */
  'app.openPath': Cmd<{ path: string }, void>;
  'app.ping': Cmd<void, { ok: true }>;
  /** Returns and clears deep links queued before the UI was listening (desktop). */
  'app.pendingDeepLinks': Cmd<void, string[]>;

  // ---- sources (B1) -------------------------------------------------------
  /** Ordered by position. */
  'sources.list': Cmd<void, Source[]>;
  'sources.get': Cmd<{ id: string }, Source>;
  /** Validates, inserts, runs the kind's importer (emits import.progress). On importer failure the source keeps `lastError` and the error is returned. */
  'sources.add': Cmd<SourcesAddArgs, Source>;
  'sources.update': Cmd<{ id: string; patch: SourcePatch }, Source>;
  'sources.remove': Cmd<{ id: string }, void>;
  /** Removes every source (same path as `sources.remove`); emits `sources.changed`. */
  'sources.removeAll': Cmd<void, null>;
  'sources.reorder': Cmd<{ ids: string[] }, void>;
  /** Re-import: m3u refetch, xtream/stalker resync. */
  'sources.refresh': Cmd<{ id: string }, Source>;
  /** Refreshes sources with autoRefresh. */
  'sources.refreshAll': Cmd<
    void,
    { refreshed: string[]; failed: { id: string; error: string; /** Classified code (C10). */ code?: RpcErrorCode }[] }
  >;
  'sources.counts': Cmd<{ id: string }, SourceCounts>;
  /**
   * Cancels a running import or refresh for the source (C8). Returns true when one was
   * running and is now cancelling; that run emits `import.progress` with `phase: 'cancelled'`
   * and leaves the previous catalog intact. False when nothing was running.
   */
  'sources.cancelImport': Cmd<{ id: string }, boolean>;

  // ---- catalog (B1) -------------------------------------------------------
  /** includeLocked: also list categories parental controls hide while locked (names and counts only, for the parental settings page). */
  'catalog.categories': Cmd<{ sourceId: string; contentType: ContentType; includeHidden?: boolean; includeLocked?: boolean }, Category[]>;
  'catalog.setCategoryHidden': Cmd<{ sourceId: string; contentType: ContentType; categoryId: string; hidden: boolean }, void>;
  /** Replaces the hidden set. */
  'catalog.setCategoriesHidden': Cmd<{ sourceId: string; contentType: ContentType; hiddenIds: string[] }, void>;
  /** contentType live, or radio when `radio` is true. */
  'catalog.channels': Cmd<
    { sourceId: string; categoryId?: string; query: PageQuery; includeHidden?: boolean; radio?: boolean },
    Page<Channel>
  >;
  'catalog.movies': Cmd<VodListArgs, Page<VodItem>>;
  'catalog.series': Cmd<VodListArgs, Page<SeriesItem>>;
  // vod: Run 2 C4.
  /**
   * Years present (count per year, newest first) for the decade chips. Hidden categories excluded;
   * `hideWatched` counts only the titles "Hide watched" keeps (absent = false).
   */
  'catalog.yearFacets': Cmd<
    { sourceId: string; contentType: 'movie' | 'series'; categoryId?: string; hideWatched?: boolean },
    YearFacet[]
  >;
  /**
   * Shape by `ref.contentType`. A ref missing from the catalog -> not_found. An item parental Hide mode locks ->
   * not_found with `details: { parentalLocked: true }` (still in the catalog; see `isParentalLocked`).
   */
  'catalog.item': Cmd<{ ref: ItemRef }, Channel | VodItem | SeriesItem>;
  'catalog.channelByNumber': Cmd<{ sourceId: string; number: number; contentType?: 'live' | 'radio' }, Channel | null>;
  /** Channel up/down inside the current list. */
  'catalog.neighbors': Cmd<{ ref: ItemRef; categoryId?: string }, { prev?: Channel; next?: Channel }>;
  /** FTS prefix match; hidden categories excluded. */
  'catalog.search': Cmd<
    { query: string; sourceId?: string; contentTypes?: ContentType[]; limit?: number },
    CatalogSearchResult
  >;
  'catalog.recentlyAdded': Cmd<
    { sourceId?: string; contentType: 'movie' | 'series'; limit: number },
    VodItem[] | SeriesItem[]
  >;
  /** Same title_base + year in other sources (multi-source VOD resolution). */
  'catalog.sameTitle': Cmd<{ ref: ItemRef }, VodItem[]>;
  /** Remote control publication only; capped at 20000. */
  'catalog.allLiveChannels': Cmd<{ sourceId: string }, Channel[]>;

  // ---- m3u (B1) -----------------------------------------------------------
  'm3u.raw': Cmd<{ sourceId: string }, { text: string; sha256: string; fetchedAt: string }>;
  /** Parses the first 2 MB only. */
  'm3u.parsePreview': Cmd<{ text: string }, { channelCount: number; groups: string[]; epgUrls: string[] }>;

  // ---- userstate (B2) -----------------------------------------------------
  'favorites.list': Cmd<{ sourceId?: string }, FavoriteEntry[]>;
  'favorites.toggle': Cmd<{ ref: ItemRef; snapshot: ItemSnapshot }, { isFavorite: boolean }>;
  /** Returns the subset of `refs` that are favorites. */
  'favorites.contains': Cmd<{ refs: ItemRef[] }, ItemRef[]>;
  'favorites.reorder': Cmd<{ sourceId?: string; refs: ItemRef[] }, void>;
  'favorites.remove': Cmd<{ ref: ItemRef }, void>;
  'recent.list': Cmd<{ sourceId?: string; limit?: number }, RecentEntry[]>;
  /** `viewedAt` (C7) is RFC 3339; when present the core stores it as the entry's viewed time instead of now (Recent undo). */
  'recent.add': Cmd<{ ref: ItemRef; snapshot: ItemSnapshot; viewedAt?: string }, void>;
  'recent.remove': Cmd<{ ref: ItemRef }, void>;
  'recent.clear': Cmd<{ sourceId?: string }, void>;
  'positions.get': Cmd<{ ref: ItemRef; episodeId?: string }, PlaybackPosition | null>;
  /**
   * At >= 0.95 * duration the item is finished: a movie's row is deleted (unless marked watched) and an
   * episode's row is kept as watched at its end (C13), so a replay must not resume from it.
   * `updatedAt` (C14, ISO 8601): only undo/restore passes it; the row keeps that
   * time and replaces a stored row only when newer. `watched` (undo of Mark
   * watched/unwatched) stores the row as watched.
   */
  'positions.set': Cmd<
    { ref: ItemRef; episodeId?: string; positionSeconds: number; durationSeconds?: number; snapshot?: ItemSnapshot; updatedAt?: string; watched?: boolean },
    void
  >;
  'positions.forSeries': Cmd<{ ref: ItemRef }, PlaybackPosition[]>;
  /** Snapshot filled. */
  'positions.continueWatching': Cmd<{ limit: number }, PlaybackPosition[]>;
  'positions.remove': Cmd<{ ref: ItemRef; episodeId?: string; allEpisodes?: boolean }, void>;
  // vod: Run 2 C4.
  /** Refs among the input that are watched (item-level row, empty episode id, watched = 1). 1..500 refs else invalid. */
  'positions.watchedContains': Cmd<{ refs: ItemRef[] }, ItemRef[]>;
  /** Watched: row kept with watched = true (position = duration when known). Unwatched: row cleared. */
  'userstate.setWatched': Cmd<{ ref: ItemRef; episodeId?: string; watched: boolean }, void>;

  // ---- settings (B2) ------------------------------------------------------
  'settings.get': Cmd<void, Settings>;
  /** Emits settings.changed. */
  'settings.update': Cmd<{ patch: Partial<Settings> }, Settings>;
  'settings.reset': Cmd<void, Settings>;
  'settings.detectPlayers': Cmd<void, DetectedPlayers>;
  'window.getState': Cmd<void, WindowState | null>;
  'window.setState': Cmd<{ state: WindowState }, void>;

  // ---- backup (B2, format C15) --------------------------------------------
  'backup.export': Cmd<{ includeSecrets: boolean; path?: string }, { json: string; fileName: string; path?: string }>;
  /** background (merge only): return once the source rows are written; sources that still need a catalog load afterwards and are named in `refreshing`. */
  'backup.import': Cmd<{ json: string; mode: 'merge' | 'replace'; background?: boolean }, BackupImportResult>;

  // ---- xtream (B3) --------------------------------------------------------
  'xtream.sync': Cmd<{ sourceId: string; contentTypes?: ContentType[] }, ImportSummary>;
  'xtream.vodDetail': Cmd<{ ref: ItemRef }, VodDetail>;
  'xtream.seriesDetail': Cmd<{ ref: ItemRef }, SeriesDetail>;
  'xtream.streamUrl': Cmd<{ ref: ItemRef; episodeId?: string }, PlayerSource>;
  /** `start` is RFC 3339. */
  'xtream.catchupUrl': Cmd<{ ref: ItemRef; start: string; durationMinutes: number }, PlayerSource>;
  'xtream.shortEpg': Cmd<{ ref: ItemRef; limit?: number }, EpgProgram[]>;
  'xtream.accountInfo': Cmd<{ sourceId: string }, XtreamAccountInfo>;
  'xtream.test': Cmd<{ config: XtreamSourceConfig }, ConnectionTestResult>;

  // ---- stalker (B4) -------------------------------------------------------
  /** itv genres + all channels, radio; VOD/series categories only. */
  'stalker.sync': Cmd<{ sourceId: string }, ImportSummary>;
  /** Paged live from the portal. */
  'stalker.movies': Cmd<{ sourceId: string; categoryId?: string; query: PageQuery }, Page<VodItem>>;
  'stalker.series': Cmd<{ sourceId: string; categoryId?: string; query: PageQuery }, Page<SeriesItem>>;
  'stalker.vodDetail': Cmd<{ ref: ItemRef }, VodDetail>;
  'stalker.seriesDetail': Cmd<{ ref: ItemRef }, SeriesDetail>;
  'stalker.streamUrl': Cmd<{ ref: ItemRef; episodeId?: string }, PlayerSource>;
  'stalker.catchupUrl': Cmd<{ ref: ItemRef; start: string; durationMinutes: number }, PlayerSource>;
  'stalker.epg': Cmd<{ ref: ItemRef; limit?: number; /** RFC 3339; adds archived programmes since then (at most 7 days back). */ from?: string }, EpgProgram[]>;
  'stalker.search': Cmd<
    { sourceId: string; query: string; contentType: ContentType },
    Page<VodItem | SeriesItem>
  >;
  'stalker.accountInfo': Cmd<{ sourceId: string }, StalkerAccountInfo>;
  'stalker.test': Cmd<{ config: StalkerSourceConfig }, ConnectionTestResult>;

  // ---- epg (B5) -----------------------------------------------------------
  /** Union of settings.epgUrls and every source's detected + manual urls, minus disabled. */
  'epg.sources': Cmd<void, EpgSourceStatus[]>;
  /** All enabled, or one; runs in background; emits epg.progress and epg.changed. */
  'epg.refresh': Cmd<{ url?: string }, void>;
  /** `offsetMinutes` (`settings.epgOffsetMinutes`, -720..720): "now" is the programme airing at `now - offset`; times stay unshifted. */
  /**
   * `withDescription: false` leaves `description` off every programme (about half the bytes);
   * omitted or true keeps it. An older core ignores the flag and always sends descriptions.
   */
  'epg.nowNext': Cmd<{ refs: ItemRef[]; offsetMinutes?: number; withDescription?: boolean }, Record<ItemKey, EpgNowNext>>;
  'epg.programs': Cmd<{ ref: ItemRef; from: string; to: string }, EpgProgram[]>;
  /** `withDescription` as for `epg.nowNext`. */
  'epg.grid': Cmd<{ refs: ItemRef[]; from: string; to: string; withDescription?: boolean }, Record<ItemKey, EpgProgram[]>>;
  'epg.channelsSearch': Cmd<{ query: string; limit?: number }, EpgChannelMatch[]>;
  /** `null` = explicitly unmapped. */
  'epg.setMapping': Cmd<{ ref: ItemRef; epgChannelId: string | null }, void>;
  'epg.clearMapping': Cmd<{ ref: ItemRef }, void>;
  'epg.resolve': Cmd<{ ref: ItemRef }, EpgResolution>;
  'epg.setEnabled': Cmd<{ url: string; enabled: boolean }, void>;
  /** Deletes all programmes and guide channels (urls and mappings kept); emits epg.changed. */
  'epg.clearAll': Cmd<void, void>;
  // guide: Run 2 C5.
  /**
   * query trimmed 2..100 chars else invalid. from default now, to default from+14 d; to > from and span <= 16 d else invalid.
   * limit default 50, 1..200. Times are raw guide times like epg.programs (the UI applies the EPG offset).
   * Hits map to this source's channels by manual mapping, items.epg_channel_id (case-insensitive) or exact normalised name
   * (no similarity matching). Hidden and parental-hidden channels are excluded. Ordered by start, then channel number.
   */
  'epg.search': Cmd<{ sourceId: string; query: string; from?: string; to?: string; limit?: number }, GuideSearchHit[]>;

  // ---- downloads (B6) -----------------------------------------------------
  'downloads.list': Cmd<void, Download[]>;
  'downloads.get': Cmd<{ id: number }, Download>;
  'downloads.start': Cmd<DownloadStartArgs, Download>;
  'downloads.pause': Cmd<{ id: number }, void>;
  'downloads.resume': Cmd<{ id: number }, void>;
  'downloads.cancel': Cmd<{ id: number }, void>;
  'downloads.retry': Cmd<{ id: number }, void>;
  'downloads.remove': Cmd<{ id: number; deleteFile: boolean }, void>;
  'downloads.reveal': Cmd<{ id: number }, void>;
  'downloads.setDir': Cmd<{ path: string }, void>;
  'downloads.dir': Cmd<void, { path: string }>;
  'downloads.setPosition': Cmd<{ id: number; positionSeconds: number }, void>;
  /** Completed downloads with `fileAvailable`. */
  'myvideos.list': Cmd<void, Download[]>;
  /** kind 'file'; desktop url is an absolute path (see `proxiedUrl`), server url is `/api/files/{id}`. */
  'myvideos.playSource': Cmd<{ id: number }, PlayerSource>;

  // ---- tmdb (B7) ----------------------------------------------------------
  /** All tmdb.* return null / [] without network when settings.tmdb.enabled is false. */
  'tmdb.movie': Cmd<{ title: string; year?: number; tmdbId?: number }, TmdbMovie | null>;
  'tmdb.tv': Cmd<{ title: string; year?: number; tmdbId?: number }, TmdbTv | null>;
  'tmdb.season': Cmd<{ tmdbId: number; season: number }, TmdbSeason | null>;
  'tmdb.person': Cmd<{ personId: number }, TmdbPerson | null>;
  'tmdb.trending': Cmd<void, TmdbBrief[]>;
  'tmdb.similar': Cmd<{ mediaType: TmdbMediaType; tmdbId: number }, TmdbBrief[]>;
  'tmdb.testKey': Cmd<{ apiKey: string }, { ok: boolean; message?: string }>;
  'tmdb.clearCache': Cmd<void, void>;

  // ---- remote (B8) --------------------------------------------------------
  'remote.start': Cmd<void, { url: string }>;
  'remote.stop': Cmd<void, void>;
  'remote.status': Cmd<void, RemoteServerStatus>;
  'remote.reportStatus': Cmd<{ status: RemoteStatus }, void>;
  'remote.publishChannels': Cmd<{ channels: RemotePublishedChannel[] }, void>;
  // remote: LAN pairing (desktop only; `unsupported` in server mode)
  'remote.pairingCode': Cmd<{ address?: string }, RemotePairing>;
  'remote.devices': Cmd<void, RemoteDevice[]>;
  'remote.revokeDevice': Cmd<{ id: string }, void>;
  'remote.resetPairing': Cmd<void, void>;

  // ---- player (B9) --------------------------------------------------------
  'player.capabilities': Cmd<void, PlayerCapabilities>;
  'player.detect': Cmd<void, DetectedPlayers>;
  /** Emits player.external on start and exit. */
  'player.openExternal': Cmd<{ player: 'mpv' | 'vlc'; source: PlayerSource }, { pid: number }>;
  /** Terminates the external mpv/VLC this app launched last (desktop only). */
  'player.stopExternal': Cmd<void, { stopped: boolean }>;
  /** Windows desktop only; Unsupported elsewhere. Bounds in CSS px. */
  /** `volume` (0..100) and `muted` are applied before the first state event. */
  'mpv.attach': Cmd<{ bounds: Bounds; volume?: number; muted?: boolean }, MpvState>;
  'mpv.load': Cmd<{ source: PlayerSource }, void>;
  /** Raw mpv JSON IPC command. */
  'mpv.command': Cmd<{ cmd: MpvArg[] }, unknown>;
  'mpv.setProperty': Cmd<{ name: string; value: unknown }, void>;
  'mpv.setBounds': Cmd<{ bounds: Bounds; holes?: Bounds[] }, void>;
  'mpv.detach': Cmd<void, void>;
  'mpv.state': Cmd<void, MpvState>;
  /** Starts/stops writing the live stream to `<recordingsDir>/<title>-<yyyyMMdd-HHmm>.ts`. */
  'mpv.record': Cmd<{ start: boolean }, { recording: boolean; path: string | null }>;
  // player: stream info overlay snapshot (desktop only; Unsupported in server mode).
  'mpv.stats': Cmd<void, import('./types').MpvStats>;
  // subtitles: Run 2 C6.
  /**
   * Desktop only (else unsupported). No attached session -> conflict. Path absolute, existing file,
   * extension srt/vtt/ass/ssa, <= 5 MB, else invalid. Runs `sub-add <path> select` on the IPC client.
   */
  'mpv.addSubtitle': Cmd<{ path: string }, void>;
  // failover: the same live channel on other sources, best first.
  'live.alternates': Cmd<{ ref: ItemRef }, LiveAlternates>;

  // account: subscription status and the scheduled refresh.
  /**
   * Cached account status; null for M3U sources. `refresh: true` asks the provider now
   * (at most once per 20 s per source). Emits `account.changed` `{ sourceId }` on change.
   */
  'account.status': Cmd<{ sourceId: string; refresh?: boolean }, AccountStatus | null>;
  /** Cached status of every Xtream and Stalker source that has one. */
  'account.statusAll': Cmd<void, AccountStatus[]>;
  /** When each auto-refresh source is next refreshed (`sourceRefreshIntervalHours`). */
  'sources.schedule': Cmd<void, ScheduleView>;

  // guide:
  /** Xtream panel now/next for channels without XMLTV (cached in core); [] when `epgShortFallback` is off or not Xtream. */
  'epg.shortEpg': Cmd<{ ref: ItemRef; limit?: number }, EpgProgram[]>;
  /** Xtream archive table (`get_simple_data_table`) overlapping [from, to); [] for other kinds. */
  'catchup.programs': Cmd<{ ref: ItemRef; from: string; to: string }, EpgProgram[]>;

  // recording:
  'reminders.list': Cmd<void, Reminder[]>;
  /** A future programme; returns the existing reminder when one is set. */
  'reminders.add': Cmd<{ ref: ItemRef; channelName: string; title: string; start: string; end: string }, Reminder>;
  'reminders.remove': Cmd<{ id: string }, void>;
  /** Reminders fired in this run that no window handled yet (one may fire before the UI listens). */
  'reminders.unhandled': Cmd<void, ReminderFiredEvent[]>;
  /** A window handled this fired reminder. */
  'reminders.ack': Cmd<{ id: string }, void>;
  'recordings.capabilities': Cmd<void, RecordingCapabilities>;
  'recordings.list': Cmd<void, Recording[]>;
  'recordings.schedule': Cmd<ScheduleRecordingArgs, ScheduleRecordingResult>;
  /** Cancels a scheduled recording, or stops a running one (keeping what was recorded). */
  'recordings.cancel': Cmd<{ id: string }, void>;
  /** Forgets a finished row; its files stay. */
  'recordings.remove': Cmd<{ id: string }, void>;
  'recordings.library': Cmd<void, RecordingFile[]>;
  'recordings.playSource': Cmd<{ id: string }, PlayerSource>;
  /** Desktop only. */
  'recordings.reveal': Cmd<{ id: string }, void>;
  /** Moves the file to the Recycle Bin (deletes it on a server that is not Windows). */
  'recordings.delete': Cmd<{ id: string }, void>;
  // Run 2 C5: series recording rules. Rule changes emit `recordings.update`.
  'recordings.rules': Cmd<void, RecordingRule[]>;
  /** Same capability/live-only checks as recordings.schedule (unsupported/invalid). Duplicate -> conflict. title 1..200. Max 100 rules -> invalid. */
  'recordings.addRule': Cmd<{ ref: ItemRef; channelName: string; title: string }, RecordingRule>;
  'recordings.setRuleEnabled': Cmd<{ id: string; enabled: boolean }, RecordingRule>;
  /** Cancels the rule's still-scheduled recordings unless keepScheduled; running ones continue. */
  'recordings.removeRule': Cmd<{ id: string; keepScheduled?: boolean }, void>;

  // parental: parental controls (contract C2). Every change emits `parental.changed`.
  'parental.status': Cmd<void, ParentalStatus>;
  /** First PIN: currentPin omitted. Changing: currentPin required (wrong -> auth). newPin 4-8 digits else invalid. unlock: true starts a session unlock after the first PIN (changing a PIN never changes the session). */
  'parental.setPin': Cmd<{ currentPin?: string; newPin: string; unlock?: boolean }, ParentalStatus>;
  /** Removes the PIN (controls off). Locks are kept for when a PIN is set again. Wrong pin -> auth. */
  'parental.disable': Cmd<{ pin: string }, ParentalStatus>;
  /** Needs pin, or an active unlock. unlockMinutes outside 0..=720 -> invalid. */
  'parental.configure': Cmd<{ pin?: string; mode?: ParentalMode; autoAdult?: boolean; unlockMinutes?: number }, ParentalStatus>;
  /** Wrong pin -> auth (failedAttempts+1). After 5 consecutive wrong PINs: conflict, retryable, details.retryAfterSeconds (30 s, doubling to max 300 s). */
  'parental.unlock': Cmd<{ pin: string }, ParentalStatus>;
  'parental.lockNow': Cmd<void, ParentalStatus>;
  'parental.locks': Cmd<{ sourceId?: string }, ParentalLock[]>;
  /** Adding a lock needs no PIN. Removing one needs pin or an active unlock (else auth). */
  'parental.setLocked': Cmd<{ target: ParentalLockTarget; locked: boolean; pin?: string }, void>;
  /** One transaction and one `parental.changed`. Any remove needs pin or an active unlock (else auth). At most 5000 targets in total, else invalid. */
  'parental.setLockedMany': Cmd<{ add?: ParentalLockTarget[]; remove?: ParentalLockTarget[]; pin?: string }, { changed: number }>;
  /** Refs locked right now (empty when disabled or unlocked). categoryId optional: core looks it up from items when absent. Covers item locks, category locks and autoAdult categories. Max 500 items else invalid. */
  'parental.check': Cmd<{ items: { ref: ItemRef; categoryId?: string }[] }, ItemRef[]>;
  /** Category ids of a source/type that autoAdult treats as adult (whether or not enabled), for badges in lock management. */
  'parental.adultCategories': Cmd<{ sourceId: string; contentType: ContentType }, string[]>;

  // watchlist: My List (contract C3). Every write emits `watchlist.changed`.
  /** Ordered by position, then addedAt desc. */
  'watchlist.list': Cmd<{ sourceId?: string; contentType?: 'movie' | 'series' }, WatchlistEntry[]>;
  /** Adds or removes one movie or series; live/radio refs -> invalid. */
  'watchlist.toggle': Cmd<{ ref: ItemRef; snapshot: ItemSnapshot }, { inList: boolean }>;
  /** The subset of `refs` that is in My List. */
  'watchlist.contains': Cmd<{ refs: ItemRef[] }, ItemRef[]>;
  'watchlist.remove': Cmd<{ ref: ItemRef }, void>;
  /** New order of My List. */
  'watchlist.reorder': Cmd<{ refs: ItemRef[] }, void>;

  // channeledit: hide and rename channels (Run 2 C2). Every write emits `channels.changed` with `{ sourceId }`.
  /** Edits of one source, newest first. hiddenOnly filters to hidden rows. */
  'channels.edits': Cmd<{ sourceId: string; hiddenOnly?: boolean }, ChannelEdit[]>;
  /**
   * 1..500 refs else invalid; contentType not live/radio -> invalid. hidden:true with a ref missing from the
   * catalog -> not_found (nothing written); hidden:false never answers not_found, so a channel the provider
   * dropped can still be unhidden.
   */
  'channels.setHidden': Cmd<{ refs: ItemRef[]; hidden: boolean }, void>;
  /** name trimmed 1..120 chars else invalid; null or '' resets to the provider name. Returns the row, or null when it was removed. */
  'channels.rename': Cmd<{ ref: ItemRef; name: string | null }, ChannelEdit | null>;
  /** Drops every edit of the source. */
  'channels.reset': Cmd<{ sourceId: string }, void>;

  // lists: custom channel lists (Run 2 C3). Every write emits `lists.changed` with `{}`.
  /** By position. */
  'lists.list': Cmd<void, CustomList[]>;
  /** name empty/too long -> invalid; duplicate name (case-insensitive) -> conflict; 51st list -> invalid. */
  'lists.create': Cmd<{ name: string; items?: RefWithSnapshot[] }, CustomList>;
  /** Unknown id -> not_found. */
  'lists.update': Cmd<{ id: string; name?: string; onDashboard?: boolean }, CustomList>;
  'lists.remove': Cmd<{ id: string }, void>;
  /** Must be a permutation of all list ids else invalid. */
  'lists.reorder': Cmd<{ ids: string[] }, void>;
  /** Hidden and parental-hidden channels are left out; renames applied. */
  'lists.items': Cmd<{ id: string }, CustomListEntry[]>;
  /** Non live/radio ref -> invalid; already present -> ignored; over 2000 -> invalid (nothing written). Appends at the end. */
  'lists.addItems': Cmd<{ id: string; items: RefWithSnapshot[] }, { added: number }>;
  'lists.removeItems': Cmd<{ id: string; refs: ItemRef[] }, void>;
  /**
   * Like watchlist.reorder: the listed refs fill the slots they held before, in the given
   * order, and unlisted refs (e.g. hidden channels) keep theirs, so any subset works. A ref
   * the list does not hold, or one listed twice -> invalid (nothing written).
   */
  'lists.reorderItems': Cmd<{ id: string; refs: ItemRef[] }, void>;
  /** Ids of lists that hold the ref (menu check marks). */
  'lists.containing': Cmd<{ ref: ItemRef }, string[]>;
  /** Prev/next available, visible channel in list order; wraps like catalog.neighbors. */
  'lists.neighbors': Cmd<{ id: string; ref: ItemRef }, { prev?: Channel; next?: Channel }>;

  // stats: watch statistics (Run 2 C7). No event; `stats.clear` invalidates locally.
  /**
   * seconds integer 1..300 else invalid; day YYYY-MM-DD within 2 days of the core's UTC date else invalid;
   * title trimmed 1..300; unknown source -> not_found. Adds seconds to the (day, ref) row and refreshes title/poster.
   */
  'stats.record': Cmd<{ ref: ItemRef; title: string; posterUrl?: string; seconds: number; day: string }, void>;
  /**
   * days must be 7 or 30 else invalid; `days` has exactly that many entries ending at `today`, zero-filled.
   * topChannels = live+radio, topTitles = movie+series; top default 10, 1..50; ordered by seconds desc, then title.
   */
  'stats.summary': Cmd<{ days: 7 | 30; today: string; top?: number }, WatchStats>;
  'stats.clear': Cmd<void, void>;

  // imagecache: disk image cache (Run 3 C2). No event; `images.clear` and a cap change refetch `images.stats`.
  /** Bytes and files on disk against the cap; also evicts down to the cap. */
  'images.stats': Cmd<void, ImageCacheStats>;
  /** Deletes every cached image; resolves the (empty) stats. */
  'images.clear': Cmd<void, ImageCacheStats>;

  // screenshot: player frames to Pictures\Tsrust IPTV (Run 3 C6). Desktop only; server mode -> unsupported.
  /** Decoded 1 B..=25 MB, magic bytes must match format, else invalid. */
  'screenshot.save': Cmd<{ dataBase64: string; format: 'png' | 'jpeg'; title?: string }, ScreenshotResult>;
  /**
   * Needs an attached embedded mpv session else conflict. Runs `screenshot-to-file <path> video|subtitles`
   * on the IPC client directly (the mpv.command allowlist stays unchanged).
   */
  'screenshot.mpv': Cmd<{ title?: string; withSubtitles?: boolean }, ScreenshotResult>;
  /** Path must be inside the screenshot folder and end in .png/.jpg/.jpeg, else invalid. Opens it in the OS default app. */
  'screenshot.open': Cmd<{ path: string }, void>;
  /** Opens the folder, selecting the file when given. */
  'screenshot.reveal': Cmd<{ path?: string }, void>;
}

/** Every command name, for runtime checks and tests. Kept in sync with `RpcMap` by the type below. */
export const RPC_COMMANDS = [
  'app.info',
  'app.openLogDir',
  'app.openPath',
  'app.ping',
  'app.pendingDeepLinks',
  'sources.list',
  'sources.get',
  'sources.add',
  'sources.update',
  'sources.remove',
  'sources.removeAll',
  'sources.reorder',
  'sources.refresh',
  'sources.refreshAll',
  'sources.counts',
  'sources.cancelImport',
  'catalog.categories',
  'catalog.setCategoryHidden',
  'catalog.setCategoriesHidden',
  'catalog.channels',
  'catalog.movies',
  'catalog.series',
  'catalog.item',
  'catalog.channelByNumber',
  'catalog.neighbors',
  'catalog.search',
  'catalog.recentlyAdded',
  'catalog.sameTitle',
  'catalog.allLiveChannels',
  'catalog.yearFacets',
  'm3u.raw',
  'm3u.parsePreview',
  'favorites.list',
  'favorites.toggle',
  'favorites.contains',
  'favorites.reorder',
  'favorites.remove',
  'recent.list',
  'recent.add',
  'recent.remove',
  'recent.clear',
  'positions.get',
  'positions.set',
  'positions.forSeries',
  'positions.continueWatching',
  'positions.remove',
  'positions.watchedContains',
  'userstate.setWatched',
  'settings.get',
  'settings.update',
  'settings.reset',
  'settings.detectPlayers',
  'window.getState',
  'window.setState',
  'backup.export',
  'backup.import',
  'xtream.sync',
  'xtream.vodDetail',
  'xtream.seriesDetail',
  'xtream.streamUrl',
  'xtream.catchupUrl',
  'xtream.shortEpg',
  'xtream.accountInfo',
  'xtream.test',
  'stalker.sync',
  'stalker.movies',
  'stalker.series',
  'stalker.vodDetail',
  'stalker.seriesDetail',
  'stalker.streamUrl',
  'stalker.catchupUrl',
  'stalker.epg',
  'stalker.search',
  'stalker.accountInfo',
  'stalker.test',
  'epg.sources',
  'epg.refresh',
  'epg.nowNext',
  'epg.programs',
  'epg.grid',
  'epg.channelsSearch',
  'epg.setMapping',
  'epg.clearMapping',
  'epg.resolve',
  'epg.setEnabled',
  'epg.clearAll',
  'epg.search',
  'downloads.list',
  'downloads.get',
  'downloads.start',
  'downloads.pause',
  'downloads.resume',
  'downloads.cancel',
  'downloads.retry',
  'downloads.remove',
  'downloads.reveal',
  'downloads.setDir',
  'downloads.dir',
  'downloads.setPosition',
  'myvideos.list',
  'myvideos.playSource',
  'tmdb.movie',
  'tmdb.tv',
  'tmdb.season',
  'tmdb.person',
  'tmdb.trending',
  'tmdb.similar',
  'tmdb.testKey',
  'tmdb.clearCache',
  'remote.start',
  'remote.stop',
  'remote.status',
  'remote.reportStatus',
  'remote.publishChannels',
  'remote.pairingCode',
  'remote.devices',
  'remote.revokeDevice',
  'remote.resetPairing',
  'player.capabilities',
  'player.detect',
  'player.openExternal',
  'player.stopExternal',
  'mpv.attach',
  'mpv.load',
  'mpv.command',
  'mpv.setProperty',
  'mpv.setBounds',
  'mpv.detach',
  'mpv.state',
  'mpv.record',
  'mpv.stats',
  'mpv.addSubtitle',
  'live.alternates',
  'account.status',
  'account.statusAll',
  'sources.schedule',
  'epg.shortEpg',
  'catchup.programs',
  'reminders.list',
  'reminders.add',
  'reminders.remove',
  'reminders.unhandled',
  'reminders.ack',
  'recordings.capabilities',
  'recordings.list',
  'recordings.schedule',
  'recordings.cancel',
  'recordings.remove',
  'recordings.library',
  'recordings.playSource',
  'recordings.reveal',
  'recordings.delete',
  'recordings.rules',
  'recordings.addRule',
  'recordings.setRuleEnabled',
  'recordings.removeRule',
  'parental.status',
  'parental.setPin',
  'parental.disable',
  'parental.configure',
  'parental.unlock',
  'parental.lockNow',
  'parental.locks',
  'parental.setLocked',
  'parental.setLockedMany',
  'parental.check',
  'parental.adultCategories',
  'watchlist.list',
  'watchlist.toggle',
  'watchlist.contains',
  'watchlist.remove',
  'watchlist.reorder',
  'channels.edits',
  'channels.setHidden',
  'channels.rename',
  'channels.reset',
  'lists.list',
  'lists.create',
  'lists.update',
  'lists.remove',
  'lists.reorder',
  'lists.items',
  'lists.addItems',
  'lists.removeItems',
  'lists.reorderItems',
  'lists.containing',
  'lists.neighbors',
  'stats.record',
  'stats.summary',
  'stats.clear',
  'images.stats',
  'images.clear',
  'screenshot.save',
  'screenshot.mpv',
  'screenshot.open',
  'screenshot.reveal',
] as const satisfies readonly (keyof RpcMap)[];

// Compile-time check that RPC_COMMANDS lists every RpcMap key.
type MissingCommands = Exclude<keyof RpcMap, (typeof RPC_COMMANDS)[number]>;
const _allCommandsListed: [MissingCommands] extends [never] ? true : MissingCommands = true;
void _allCommandsListed;
