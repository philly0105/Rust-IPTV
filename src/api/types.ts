/**
 * Shared model types (SPEC C2). Mirrors `crates/iptv-core/src/model.rs` 1:1.
 *
 * JSON is camelCase; string enums are kebab-case; `?` fields are omitted by the
 * Rust side when absent. Timestamps are RFC 3339 strings in UTC. IDs are
 * strings unless stated. Frozen after wave 0: additions go through the
 * integration agent.
 */

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceKind = 'm3u' | 'xtream' | 'stalker';
export type M3uOrigin = 'url' | 'file' | 'text';
export type ContentType = 'live' | 'movie' | 'series' | 'radio';

/** Per-source HTTP headers applied to fetches and playback. */
export interface RequestHeaders {
  userAgent?: string;
  referrer?: string;
  origin?: string;
}

export interface M3uSourceConfig {
  origin: M3uOrigin;
  url?: string;
  filePath?: string;
  headers: RequestHeaders;
}

export interface XtreamSourceConfig {
  serverUrl: string;
  username: string;
  password: string;
}

export interface StalkerSourceConfig {
  portalUrl: string;
  macAddress: string;
  isFullPortal: boolean;
  username?: string;
  password?: string;
  headers: RequestHeaders;
  serialNumber?: string;
  deviceId1?: string;
  deviceId2?: string;
  signature1?: string;
  signature2?: string;
}

export interface EpgLinks {
  detectedUrls: string[];
  manualUrls: string[];
  disabledUrls: string[];
}

export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  position: number;
  autoRefresh: boolean;
  createdAt: string;
  updatedAt?: string;
  lastRefreshAt?: string;
  lastError?: string;
  /** Live channels only; radio stations are in `radioCount`. */
  channelCount: number;
  radioCount: number;
  movieCount: number;
  seriesCount: number;
  epg: EpgLinks;
  m3u?: M3uSourceConfig;
  xtream?: XtreamSourceConfig;
  stalker?: StalkerSourceConfig;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Stable reference to one catalog item.
 * itemId: m3u -> 16 hex chars of sha256(url + '\n' + name); xtream -> stream_id /
 * series_id as decimal string; stalker -> portal id string.
 */
export interface ItemRef {
  sourceId: string;
  contentType: ContentType;
  itemId: string;
}

/** Map key used by `epg.nowNext` / `epg.grid`: `${sourceId}|${contentType}|${itemId}`. */
export type ItemKey = `${string}|${ContentType}|${string}`;

/** Builds the `ItemKey` for a ref. */
export function itemKey(ref: ItemRef): ItemKey {
  return `${ref.sourceId}|${ref.contentType}|${ref.itemId}`;
}

/** True when two refs point at the same item. */
export function sameRef(a: ItemRef | undefined, b: ItemRef | undefined): boolean {
  return !!a && !!b && a.sourceId === b.sourceId && a.contentType === b.contentType && a.itemId === b.itemId;
}

export interface Category {
  id: string;
  sourceId: string;
  contentType: ContentType;
  name: string;
  hidden: boolean;
  itemCount: number;
  position: number;
}

export interface ArchiveInfo {
  enabled: boolean;
  durationHours?: number;
}

export interface Channel {
  ref: ItemRef;
  name: string;
  number?: number;
  logoUrl?: string;
  categoryId: string;
  categoryName: string;
  epgChannelId?: string;
  url?: string;
  isRadio: boolean;
  archive?: ArchiveInfo;
  /** Per-channel headers (m3u `#EXTVLCOPT` / `url|Header=`); override the source-level headers. */
  headers?: RequestHeaders;
  /** m3u catch-up attributes. */
  catchup?: CatchupInfo;
}

/**
 * m3u catch-up attributes. `type` is lowercased. `default` / `append` without a
 * `source` use the standard `?utc={utc}&lutc={lutc}` convention.
 */
export interface CatchupInfo {
  type: 'default' | 'append' | 'shift' | 'xc' | 'flussonic' | (string & {});
  days?: number;
  source?: string;
}

export interface VodItem {
  ref: ItemRef;
  title: string;
  titleBase?: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  rating?: number;
  added?: string;
  categoryId: string;
  categoryName?: string;
  containerExtension?: string;
  durationSeconds?: number;
  plot?: string;
  genres?: string[];
  tmdbId?: number;
}

export interface SeriesItem {
  ref: ItemRef;
  title: string;
  titleBase?: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  rating?: number;
  added?: string;
  categoryId: string;
  categoryName?: string;
  plot?: string;
  genres?: string[];
  tmdbId?: number;
}

export interface Episode {
  id: string;
  seriesRef: ItemRef;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  durationSeconds?: number;
  posterUrl?: string;
  containerExtension?: string;
  added?: string;
}

export interface Season {
  number: number;
  name?: string;
  posterUrl?: string;
  episodes: Episode[];
}

export interface Person {
  id?: number;
  name: string;
  role?: string;
  profileUrl?: string;
}

export interface VodDetail {
  item: VodItem;
  cast: Person[];
  director?: string;
  trailerUrl?: string;
  backdrops: string[];
  /** The provider's detail call failed; built from the catalog row alone. */
  providerDetailsUnavailable: boolean;
  providerError?: string;
}

export interface SeriesDetail {
  item: SeriesItem;
  seasons: Season[];
  cast: Person[];
  director?: string;
  trailerUrl?: string;
  backdrops: string[];
  /** The provider's detail call failed; built from the catalog row alone. */
  providerDetailsUnavailable: boolean;
  providerError?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export type SortKey = 'name' | 'added' | 'rating' | 'number' | 'year';
export type SortDir = 'asc' | 'desc';

export interface PageQuery {
  offset: number;
  limit: number;
  search?: string;
  sort?: SortKey;
  dir?: SortDir;
}

// ---------------------------------------------------------------------------
// EPG
// ---------------------------------------------------------------------------

export interface EpgProgram {
  channelId: string;
  start: string;
  end: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
}

export interface EpgNowNext {
  now?: EpgProgram;
  next?: EpgProgram;
}

export type EpgFetchStatus = 'idle' | 'fetching' | 'ok' | 'error';
export type EpgOrigin = 'settings' | 'source';

export interface EpgSourceStatus {
  url: string;
  lastFetchAt?: string;
  status: EpgFetchStatus;
  programCount: number;
  channelCount: number;
  error?: string;
  enabled: boolean;
  origin: EpgOrigin;
  sourceId?: string;
}

// ---------------------------------------------------------------------------
// User state
// ---------------------------------------------------------------------------

export interface ItemSnapshot {
  title: string;
  subtitle?: string;
  posterUrl?: string;
  contentType: ContentType;
}

export interface PlaybackPosition {
  ref: ItemRef;
  episodeId?: string;
  positionSeconds: number;
  durationSeconds?: number;
  updatedAt: string;
  snapshot?: ItemSnapshot;
  /** Marked watched with `userstate.setWatched`; never in continue watching. */
  watched: boolean;
}

export interface FavoriteEntry {
  ref: ItemRef;
  addedAt: string;
  position: number;
  snapshot: ItemSnapshot;
}

export interface RecentEntry {
  ref: ItemRef;
  viewedAt: string;
  snapshot: ItemSnapshot;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled';

export interface Download {
  /** Integer row id. */
  id: number;
  ref: ItemRef;
  episodeId?: string;
  title: string;
  subtitle?: string;
  url: string;
  fileName?: string;
  filePath?: string;
  posterUrl?: string;
  status: DownloadStatus;
  bytesDownloaded: number;
  totalBytes?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  fileAvailable?: boolean;
  positionSeconds: number;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type PlayerKind = 'hls' | 'dash' | 'direct' | 'file';

export interface PlayerSource {
  url: string;
  kind: PlayerKind;
  headers?: RequestHeaders;
  title: string;
  subtitle?: string;
  posterUrl?: string;
  ref?: ItemRef;
  episodeId?: string;
  resumeSeconds?: number;
  isLive: boolean;
  isRadio: boolean;
}

export type VideoPlayer = 'html5' | 'videojs' | 'embedded-mpv' | 'mpv' | 'vlc';
export type StreamFormat = 'm3u8' | 'ts';
export type Theme = 'light' | 'dark' | 'system';
export type StartupBehavior = 'first-view' | 'restore-last-view';
export type EpgViewMode = 'timeline' | 'list';
export type CoverSize = 'small' | 'medium' | 'large';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface DashboardRails {
  hero: boolean;
  continueWatching: boolean;
  liveFavorites: boolean;
  recentlyWatchedLive: boolean;
  favoriteMoviesAndSeries: boolean;
  recentSources: boolean;
  recentlyAdded: boolean;
  tmdbTrending: boolean;
}

export interface TmdbSettings {
  enabled: boolean;
  /** Secret. Never log or display in full. */
  apiKey?: string;
  language?: string;
}

/** Default port 7310. */
export interface RemoteControlSettings {
  enabled: boolean;
  port: number;
}

export interface Settings {
  player: VideoPlayer;
  streamFormat: StreamFormat;
  epgUrls: string[];
  language: string;
  theme: Theme;
  showDashboard: boolean;
  startupBehavior: StartupBehavior;
  lastRoute?: string;
  mpvPath?: string;
  vlcPath?: string;
  mpvArgs: string;
  vlcArgs: string;
  openStreamOnDoubleClick: boolean;
  showCaptions: boolean;
  downloadsDir?: string;
  tmdb: TmdbSettings;
  dashboardRails: DashboardRails;
  remoteControl: RemoteControlSettings;
  playerAmbientMode: boolean;
  playerAutoplayNextEpisode: boolean;
  playerUpNextRail: boolean;
  fullscreenChannelPanel: boolean;
  vodAutoFailover: boolean;
  epgViewMode: EpgViewMode;
  coverSize: CoverSize;
  /** Strip a leading `XX: ` / `XX | ` / `[XX] ` country tag from channel names. */
  stripCountryPrefix: boolean;
  /** Minutes added to displayed programme times (-720..720). */
  epgOffsetMinutes: number;
  /** Close the previous external player before launching the next. */
  playerReuseInstance: boolean;
  /** Show the external-playback footer. */
  showExternalBar: boolean;
  /** VOD grids hide items rated below this (0..10; 0 shows everything). */
  vodMinRating: number;
  /** `null` = `<downloadsDir>/recordings`. Desktop only. */
  recordingsDir: string | null;
}

/** Defaults identical to `impl Default for Settings` in model.rs. */
export const DEFAULT_SETTINGS: Settings = {
  player: 'html5',
  streamFormat: 'm3u8',
  epgUrls: [],
  language: 'en',
  theme: 'system',
  showDashboard: true,
  startupBehavior: 'first-view',
  mpvArgs: '',
  vlcArgs: '',
  openStreamOnDoubleClick: false,
  showCaptions: false,
  tmdb: { enabled: false },
  dashboardRails: {
    hero: true,
    continueWatching: true,
    liveFavorites: true,
    recentlyWatchedLive: true,
    favoriteMoviesAndSeries: true,
    recentSources: true,
    recentlyAdded: true,
    tmdbTrending: true,
  },
  remoteControl: { enabled: false, port: 7310 },
  playerAmbientMode: false,
  playerAutoplayNextEpisode: true,
  playerUpNextRail: true,
  fullscreenChannelPanel: true,
  vodAutoFailover: false,
  epgViewMode: 'timeline',
  coverSize: 'medium',
  stripCountryPrefix: false,
  epgOffsetMinutes: 0,
  playerReuseInstance: true,
  showExternalBar: true,
  vodMinRating: 0,
  recordingsDir: null,
};

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  platform: string;
  isDesktop: boolean;
  logFile: string;
  /** Desktop: loopback media proxy base (`http://127.0.0.1:<port>/<token>/api/proxy`, where `<token>` is a per-launch secret path segment); null in server mode. */
  proxyBase: string | null;
  /** True only in a desktop build compiled with the updater feature. */
  updaterAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Embedded mpv
// ---------------------------------------------------------------------------

export interface MpvTrack {
  id: number;
  type: 'audio' | 'sub' | 'video';
  title?: string;
  lang?: string;
  selected: boolean;
}

export interface MpvState {
  attached: boolean;
  loaded: boolean;
  paused: boolean;
  timePos: number;
  duration?: number;
  volume: number;
  muted: boolean;
  tracks: MpvTrack[];
  fullscreen: boolean;
  error?: string;
  /** True while `mpv.record` writes the stream to disk. */
  recording: boolean;
  recordPath: string | null;
  /** What mpv's cache can seek in, on the timePos clock; for live TV, the rewind window. */
  seekable?: { start: number; end: number };
  /** True while mpv is paused waiting for its cache to fill (buffering); omitted when unknown. */
  buffering?: boolean;
}

/** Child-window rectangle in CSS pixels (`mpv.attach`, `mpv.setBounds`). */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportSummary {
  channels: number;
  movies: number;
  series: number;
}

// ---------------------------------------------------------------------------
// Remote control (C4 remote)
// ---------------------------------------------------------------------------

export interface RemoteStatus {
  sourceName?: string;
  isLive: boolean;
  channelName?: string;
  channelNumber?: number;
  epgNow?: string;
  volume?: number;
  muted?: boolean;
  canVolume: boolean;
}

export type RemoteCommand =
  | 'channelUp'
  | 'channelDown'
  | 'selectNumber'
  | 'selectId'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'setVolume';

// ---------------------------------------------------------------------------
// TMDB (C4 tmdb). Images: w500 posters, w1280 backdrops.
// ---------------------------------------------------------------------------

export type TmdbMediaType = 'movie' | 'tv';

export interface TmdbBrief {
  tmdbId: number;
  mediaType: TmdbMediaType;
  title: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  rating?: number;
  overview?: string;
}

export interface TmdbMovie extends TmdbBrief {
  runtime?: number;
  genres: string[];
  cast: Person[];
  crew: Person[];
  director?: string;
  trailerYoutubeKey?: string;
  similar: TmdbBrief[];
  imdbId?: string;
}

export interface TmdbTvSeasonSummary {
  number: number;
  name: string;
  episodeCount: number;
  posterUrl?: string;
  airDate?: string;
}

export interface TmdbTv extends TmdbBrief {
  genres: string[];
  cast: Person[];
  crew: Person[];
  creators: string[];
  seasons: TmdbTvSeasonSummary[];
  trailerYoutubeKey?: string;
  similar: TmdbBrief[];
  status?: string;
}

export interface TmdbEpisode {
  number: number;
  name: string;
  overview?: string;
  stillUrl?: string;
  airDate?: string;
  runtime?: number;
}

export interface TmdbSeason {
  number: number;
  name: string;
  overview?: string;
  episodes: TmdbEpisode[];
}

export interface TmdbPerson {
  id: number;
  name: string;
  biography?: string;
  profileUrl?: string;
  birthday?: string;
  placeOfBirth?: string;
  knownFor: TmdbBrief[];
}

// ---------------------------------------------------------------------------
// Errors (C1)
// ---------------------------------------------------------------------------

export type RpcErrorCode =
  | 'not_found'
  | 'invalid'
  | 'network'
  | 'auth'
  | 'timeout'
  | 'io'
  | 'db'
  | 'unsupported'
  | 'conflict'
  | 'internal';

/** JSON body of an RPC error (Tauri rejection value or HTTP error body). */
export interface RpcErrorPayload {
  code: RpcErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// App events (C1). `type` -> payload.
// ---------------------------------------------------------------------------

export type ImportPhase = 'fetching' | 'parsing' | 'saving' | 'done' | 'error';

export interface ImportProgressEvent {
  sourceId: string;
  phase: ImportPhase;
  done: number;
  total?: number;
  message?: string;
}

export interface EpgProgressEvent {
  url: string;
  phase: string;
  programs: number;
  message?: string;
}

export interface DownloadProgressEvent {
  id: number;
  bytesDownloaded: number;
  totalBytes?: number;
  bytesPerSecond: number;
}

export interface RemoteCommandEvent {
  command: RemoteCommand;
  number?: number;
  id?: string;
  level?: number;
}

export interface PlayerExternalEvent {
  state: 'started' | 'exited';
  player: 'mpv' | 'vlc';
  title: string;
  pid?: number;
  exitCode?: number;
}

/** Desktop only: `iptv://` links opened while the app runs or at launch. */
export interface DeepLinkEvent {
  urls: string[];
}

export type EmptyEvent = Record<string, never>;

/** Server mode: the event socket fell behind and `skipped` events were dropped; refetch everything. */
export interface EventsLaggedEvent {
  skipped: number;
}

export interface AppEventMap {
  'import.progress': ImportProgressEvent;
  'sources.changed': EmptyEvent;
  'epg.progress': EpgProgressEvent;
  'epg.changed': EmptyEvent;
  'downloads.update': EmptyEvent;
  'downloads.progress': DownloadProgressEvent;
  'remote.command': RemoteCommandEvent;
  'mpv.state': MpvState;
  /** Left click on the embedded mpv video. */
  'mpv.click': EmptyEvent;
  /** Double click on the embedded mpv video (follows an `mpv.click`). */
  'mpv.dblclick': EmptyEvent;
  'settings.changed': Settings;
  'player.external': PlayerExternalEvent;
  'deeplink.open': DeepLinkEvent;
  'events.lagged': EventsLaggedEvent;
}

export type AppEventType = keyof AppEventMap;

/** Wire shape of one event. */
export interface AppEvent<T = unknown> {
  type: string;
  payload: T;
}
