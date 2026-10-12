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
} from './types';

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

export interface BackupImportResult {
  imported: number;
  skipped: number;
  warnings: string[];
}

/** Value accepted in an mpv JSON IPC command array. */
export type MpvArg = string | number | boolean;

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
  'sources.refreshAll': Cmd<void, { refreshed: string[]; failed: { id: string; error: string }[] }>;
  'sources.counts': Cmd<{ id: string }, SourceCounts>;

  // ---- catalog (B1) -------------------------------------------------------
  'catalog.categories': Cmd<{ sourceId: string; contentType: ContentType; includeHidden?: boolean }, Category[]>;
  'catalog.setCategoryHidden': Cmd<{ sourceId: string; contentType: ContentType; categoryId: string; hidden: boolean }, void>;
  /** Replaces the hidden set. */
  'catalog.setCategoriesHidden': Cmd<{ sourceId: string; contentType: ContentType; hiddenIds: string[] }, void>;
  /** contentType live, or radio when `radio` is true. */
  'catalog.channels': Cmd<
    { sourceId: string; categoryId?: string; query: PageQuery; includeHidden?: boolean; radio?: boolean },
    Page<Channel>
  >;
  'catalog.movies': Cmd<{ sourceId: string; categoryId?: string; query: PageQuery; /** Only titles rated at least this (unrated drop out); `total` counts the filtered set. */ minRating?: number }, Page<VodItem>>;
  'catalog.series': Cmd<{ sourceId: string; categoryId?: string; query: PageQuery; /** Only titles rated at least this (unrated drop out); `total` counts the filtered set. */ minRating?: number }, Page<SeriesItem>>;
  /** Shape by `ref.contentType`. */
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
  'recent.add': Cmd<{ ref: ItemRef; snapshot: ItemSnapshot }, void>;
  'recent.remove': Cmd<{ ref: ItemRef }, void>;
  'recent.clear': Cmd<{ sourceId?: string }, void>;
  'positions.get': Cmd<{ ref: ItemRef; episodeId?: string }, PlaybackPosition | null>;
  /** Deleted when positionSeconds >= 0.95 * duration. */
  'positions.set': Cmd<
    { ref: ItemRef; episodeId?: string; positionSeconds: number; durationSeconds?: number; snapshot?: ItemSnapshot },
    void
  >;
  'positions.forSeries': Cmd<{ ref: ItemRef }, PlaybackPosition[]>;
  /** Snapshot filled. */
  'positions.continueWatching': Cmd<{ limit: number }, PlaybackPosition[]>;
  'positions.remove': Cmd<{ ref: ItemRef; episodeId?: string }, void>;
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
  'backup.import': Cmd<{ json: string; mode: 'merge' | 'replace' }, BackupImportResult>;

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
  'epg.nowNext': Cmd<{ refs: ItemRef[]; offsetMinutes?: number }, Record<ItemKey, EpgNowNext>>;
  'epg.programs': Cmd<{ ref: ItemRef; from: string; to: string }, EpgProgram[]>;
  'epg.grid': Cmd<{ refs: ItemRef[]; from: string; to: string }, Record<ItemKey, EpgProgram[]>>;
  'epg.channelsSearch': Cmd<{ query: string; limit?: number }, EpgChannelMatch[]>;
  /** `null` = explicitly unmapped. */
  'epg.setMapping': Cmd<{ ref: ItemRef; epgChannelId: string | null }, void>;
  'epg.clearMapping': Cmd<{ ref: ItemRef }, void>;
  'epg.resolve': Cmd<{ ref: ItemRef }, EpgResolution>;
  'epg.setEnabled': Cmd<{ url: string; enabled: boolean }, void>;
  /** Deletes all programmes and guide channels (urls and mappings kept); emits epg.changed. */
  'epg.clearAll': Cmd<void, void>;

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
  'remote.status': Cmd<void, { running: boolean; url?: string; port: number }>;
  'remote.reportStatus': Cmd<{ status: RemoteStatus }, void>;
  'remote.publishChannels': Cmd<{ channels: RemotePublishedChannel[] }, void>;

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
] as const satisfies readonly (keyof RpcMap)[];

// Compile-time check that RPC_COMMANDS lists every RpcMap key.
type MissingCommands = Exclude<keyof RpcMap, (typeof RPC_COMMANDS)[number]>;
const _allCommandsListed: [MissingCommands] extends [never] ? true : MissingCommands = true;
void _allCommandsListed;
