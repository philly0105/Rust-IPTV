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
  // guide:
  /** Source-wide catch-up override; absent = the playlist's own attributes. Applied by core to channel rows. */
  catchup?: CatchupOverride;
}

// guide:
/** `none` turns catch-up off; the others are the M3U catch-up types (see `features/live/lib/catchup.ts`). */
export type CatchupOverrideType = 'default' | 'append' | 'shift' | 'flussonic' | 'xc' | 'none';

// guide:
export interface CatchupOverride {
  type: CatchupOverrideType;
  /** Replaces each channel's `catchup-source` (placeholders: {utc} {lutc} {utcend} {duration} {offset} {Y}{m}{d}{H}{M}{S}). */
  template?: string;
  /** Replaces each channel's `catchup-days` (1..366). */
  days?: number;
}

export interface XtreamSourceConfig {
  serverUrl: string;
  username: string;
  password: string;
  /** Sent with every panel request; without a User-Agent the core sends VLC's. */
  headers?: RequestHeaders;
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
  /** Guide time shift of every channel of the source, in minutes (-720..720); absent = none. A patch with 0 removes it. */
  shiftMinutes?: number;
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
  /** Classified code for `lastError` (C10); absent when there is no error or it predates codes. */
  lastErrorCode?: RpcErrorCode;
  // account:
  /** When `lastError` was recorded (RFC 3339); absent without an error. */
  lastErrorAt?: string;
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
  /**
   * Only on `includeHidden` answers: true when the answer without `includeHidden` leaves this group
   * out only because its channels are hidden. Absent from an older core.
   */
  emptiedByEdits?: boolean;
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
  /**
   * m3u ClearKey licence from `#KODIPROP` (`inputstream.adaptive.license_key` with
   * `license_type=clearkey`) as written: kid:key pairs, a JSON key map or JWK set, or a URL.
   */
  clearKey?: string;
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
  /** M3U movies in `catalog.item` only: the playlist's stream URL (Xtream and Stalker use their streamUrl). */
  url?: string;
  /** With `url`: the entry's own request headers, applied over the playlist's. */
  headers?: RequestHeaders;
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
  // guide:
  /** UI only, never sent by core: the programme came from the provider's short EPG, not XMLTV. */
  fromProvider?: boolean;
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

/** `sourcePins.*`: the copy of a title Play uses when several sources carry it. */
export interface SourcePin {
  sourceId: string;
  itemId: string;
  updatedAt: string;
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
  /** ClearKey DRM (UI only; the core never sets it). Such a source plays in the built-in player. */
  drm?: PlayerDrm;
}

/** ClearKey for shaka (`drm.clearKeys` / `drm.servers['org.w3.clearkey']`). */
export interface PlayerDrm {
  /** Hex key id to hex key. */
  clearKeys?: Record<string, string>;
  /** ClearKey licence server URL. */
  licenseServer?: string;
}

export type VideoPlayer = 'html5' | 'videojs' | 'embedded-mpv' | 'mpv' | 'vlc';
/**
 * Xtream live container. `auto`: TS when the built-in player can play it (W3C Media Source
 * Extensions), HLS elsewhere and for mpv and VLC (`autoLiveFormat` in the player store).
 */
export type StreamFormat = 'auto' | 'm3u8' | 'ts';
export type Theme = 'light' | 'dark' | 'system';
export type StartupBehavior = 'first-view' | 'restore-last-view';
/** How the desktop window opens (`settings.windowStart`): as it closed, maximized or fullscreen. */
export type WindowStart = 'normal' | 'maximized' | 'fullscreen';
export type EpgViewMode = 'timeline' | 'list';
export type CoverSize = 'small' | 'medium' | 'large';
// appearance:
/** Accent color family (`settings.accent`); applied as `html[data-accent]`. */
export type Accent = 'amber' | 'teal' | 'violet' | 'rose' | 'lime' | 'sky' | 'coral';
/** Spacing density of lists, rails and rows (`settings.density`); applied as `html[data-density]`. */
export type Density = 'comfortable' | 'compact';

/** Every accent, in the order pickers show them (same order as `Accent::ALL` in model.rs). */
export const ACCENTS = ['amber', 'teal', 'violet', 'rose', 'lime', 'sky', 'coral'] as const satisfies readonly Accent[];
/** Every density (same order as `Density::ALL` in model.rs). */
export const DENSITIES = ['comfortable', 'compact'] as const satisfies readonly Density[];
// Compile-time checks that ACCENTS and DENSITIES list every value.
const _allAccentsListed: [Exclude<Accent, (typeof ACCENTS)[number]>] extends [never] ? true : never = true;
const _allDensitiesListed: [Exclude<Density, (typeof DENSITIES)[number]>] extends [never] ? true : never = true;
void _allAccentsListed;
void _allDensitiesListed;
/** Smallest accepted `settings.uiScale` (`settings::UI_SCALE_RANGE` in the core). */
export const UI_SCALE_MIN = 0.9;
/** Largest accepted `settings.uiScale` (`settings::UI_SCALE_RANGE` in the core). */
export const UI_SCALE_MAX = 1.25;
// subtitles:
/** Subtitle text size (`settings.subtitleSize`): 0.8, 1.0, 1.25 and 1.5 times the base size. */
export type SubtitleSize = 'small' | 'medium' | 'large' | 'xlarge';
/** Subtitle text colour (`settings.subtitleColor`). */
export type SubtitleColor = 'white' | 'yellow' | 'cyan' | 'green';
/** What sits behind subtitle text (`settings.subtitleBackground`): text shadow only, translucent box, opaque box. */
export type SubtitleBackground = 'shadow' | 'box' | 'solid';
/** Every subtitle size, in picker order (same order as `SubtitleSize::ALL` in model.rs). */
export const SUBTITLE_SIZES = ['small', 'medium', 'large', 'xlarge'] as const satisfies readonly SubtitleSize[];
/** Every subtitle colour, in picker order (same order as `SubtitleColor::ALL` in model.rs). */
export const SUBTITLE_COLORS = ['white', 'yellow', 'cyan', 'green'] as const satisfies readonly SubtitleColor[];
/** Every subtitle background, in picker order (same order as `SubtitleBackground::ALL` in model.rs). */
export const SUBTITLE_BACKGROUNDS = ['shadow', 'box', 'solid'] as const satisfies readonly SubtitleBackground[];
// Compile-time checks that the lists name every value.
const _allSubtitleSizesListed: [Exclude<SubtitleSize, (typeof SUBTITLE_SIZES)[number]>] extends [never] ? true : never = true;
const _allSubtitleColorsListed: [Exclude<SubtitleColor, (typeof SUBTITLE_COLORS)[number]>] extends [never] ? true : never = true;
const _allSubtitleBackgroundsListed: [Exclude<SubtitleBackground, (typeof SUBTITLE_BACKGROUNDS)[number]>] extends [never]
  ? true
  : never = true;
void _allSubtitleSizesListed;
void _allSubtitleColorsListed;
void _allSubtitleBackgroundsListed;
/** Smallest accepted `settings.subtitlePosition` (`settings::SUBTITLE_POSITION_RANGE` in the core). */
export const SUBTITLE_POSITION_MIN = 0;
/** Largest accepted `settings.subtitlePosition` (`settings::SUBTITLE_POSITION_RANGE` in the core). */
export const SUBTITLE_POSITION_MAX = 40;
// Run 3:
/** Smallest accepted `settings.imageCacheMaxMb` (`settings::IMAGE_CACHE_MAX_MB_RANGE` in the core). */
export const IMAGE_CACHE_MAX_MB_MIN = 50;
/** Largest accepted `settings.imageCacheMaxMb` (`settings::IMAGE_CACHE_MAX_MB_RANGE` in the core). */
export const IMAGE_CACHE_MAX_MB_MAX = 5000;
/** Longest accepted `settings.lastSeenVersion` (`settings::LAST_SEEN_VERSION_MAX_LEN` in the core). */
export const LAST_SEEN_VERSION_MAX_LENGTH = 32;

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
  // watchlist:
  /** The My List rail (movies and series saved with `watchlist.toggle`). */
  myList: boolean;
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
  /**
   * Lists, grids, categories and search hide items whose title or category
   * clearly marks another language; items without a clear language stay.
   */
  englishOnly: boolean;
  /**
   * Live channel lists, the guide, search and zapping hide channels whose
   * provider name marks a lower quality. `null` = off. Radio is never filtered.
   */
  liveMinQuality: ChannelQuality | null;
  /** With `liveMinQuality` set, also hide channels whose name carries no quality tag. */
  liveHideUntagged: boolean;
  /** `null` = `<downloadsDir>/recordings`. Desktop only. */
  recordingsDir: string | null;
  // failover: smart reconnect and live failover.
  /** Live channels switch to the same channel on another source when the stream fails. */
  liveFailover: boolean;
  /** Dropped or stalled streams are retried quietly before an error shows. */
  streamReconnect: boolean;
  // remote:
  /** Remote control also listens on private network addresses for paired phones. Desktop only. */
  remoteLanEnabled: boolean;
  // account:
  /** Hours between scheduled source refreshes (0 = only at startup; 0..168). */
  sourceRefreshIntervalHours: number;
  /** Warn this many days before a subscription expires (0 = off; 0..60). */
  accountExpiryWarnDays: number;
  // guide:
  /** Xtream channels without XMLTV programmes show the provider's short EPG. */
  epgShortFallback: boolean;
  // recording:
  /** Minutes a scheduled recording starts early (0..60). */
  recordingPaddingBeforeMinutes: number;
  /** Minutes a scheduled recording runs past the programme end (0..120). */
  recordingPaddingAfterMinutes: number;
  /** Guide reminders fire while the app runs. */
  remindersEnabled: boolean;
  /** Minutes before the start a reminder fires (0..60). */
  reminderLeadMinutes: number;
  reminderAction: ReminderAction;
  // appearance:
  /** Accent color family for focus rings, selection and primary actions. */
  accent: Accent;
  /** Pure-black surfaces whenever the dark theme is in effect (dark, or system resolving to dark). */
  oledBlack: boolean;
  /** Spacing density of lists, rails and rows. */
  density: Density;
  /**
   * Root font scale, `html { font-size: calc(15px * uiScale) }`. The core
   * accepts `UI_SCALE_MIN..=UI_SCALE_MAX` (0.9..1.25) and rounds to 4 decimals.
   */
  uiScale: number;
  /** Now/next banner inside the player on every live channel change. */
  zapBanner: boolean;
  // subtitles:
  /** Subtitle text size in mpv and the built-in player. */
  subtitleSize: SubtitleSize;
  /** Subtitle text colour. */
  subtitleColor: SubtitleColor;
  /** Shadow only, translucent box (`rgb(0 0 0 / .72)`) or opaque box behind subtitle text. */
  subtitleBackground: SubtitleBackground;
  /**
   * Percent of the picture height subtitles are raised from the bottom: an
   * integer in `SUBTITLE_POSITION_MIN..=SUBTITLE_POSITION_MAX` (0..40).
   */
  subtitlePosition: number;
  // vod:
  /** The VOD grid's "Hide watched" toggle (`hideWatched` on `catalog.movies` / `catalog.series`). */
  vodHideWatched: boolean;
  // Run 3 (machine-local: never in backups).
  /**
   * Size cap of the on-disk image cache in MB: an integer in
   * `IMAGE_CACHE_MAX_MB_MIN..=IMAGE_CACHE_MAX_MB_MAX` (50..5000). Applies in server mode too.
   */
  imageCacheMaxMb: number;
  /** The first-run tour was finished or skipped. `settings.reset` keeps it. */
  tourCompleted: boolean;
  /**
   * App version whose "What's new" was last seen: '' (never) or 1..32 characters of
   * `[0-9A-Za-z.+-]` (`LAST_SEEN_VERSION_MAX_LENGTH`). `settings.reset` keeps it.
   */
  lastSeenVersion: string;
  // desktop (machine-local: never in backups).
  /** How the desktop window opens, applied when it is first shown. The browser ignores it. */
  windowStart: WindowStart;
}

/** Defaults identical to `impl Default for Settings` in model.rs. */
export const DEFAULT_SETTINGS: Settings = {
  player: 'html5',
  streamFormat: 'auto',
  epgUrls: [],
  language: 'en',
  theme: 'system',
  showDashboard: true,
  startupBehavior: 'restore-last-view',
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
    // watchlist:
    myList: true,
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
  englishOnly: false,
  liveMinQuality: null,
  liveHideUntagged: false,
  recordingsDir: null,
  // failover: smart reconnect and live failover.
  liveFailover: true,
  streamReconnect: true,
  // remote:
  remoteLanEnabled: false,
  // account:
  sourceRefreshIntervalHours: 12,
  accountExpiryWarnDays: 7,
  // guide:
  epgShortFallback: true,
  // recording:
  recordingPaddingBeforeMinutes: 1,
  recordingPaddingAfterMinutes: 5,
  remindersEnabled: true,
  reminderLeadMinutes: 2,
  reminderAction: 'notify',
  // appearance:
  accent: 'amber',
  oledBlack: false,
  density: 'comfortable',
  uiScale: 1,
  zapBanner: true,
  // subtitles:
  subtitleSize: 'medium',
  subtitleColor: 'white',
  subtitleBackground: 'box',
  subtitlePosition: 0,
  // vod:
  vodHideWatched: false,
  // Run 3:
  imageCacheMaxMb: 500,
  tourCompleted: false,
  lastSeenVersion: '',
  // desktop:
  windowStart: 'normal',
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
  /**
   * Desktop: the image cache route on the proxy's second loopback listener (`http://127.0.0.1:<port>/<token>/api/img`),
   * so artwork does not wait behind streams for the webview's six connections per host and port; null in server mode.
   */
  imageBase?: string | null;
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

// player: `mpv.stats` result (stream info overlay). Fields are omitted when mpv does not know them.
export interface MpvStats {
  videoCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Bits per second. */
  videoBitrate?: number;
  audioCodec?: string;
  audioChannels?: number;
  /** Bits per second. */
  audioBitrate?: number;
  /** Hardware decoder in use; omitted for software decoding. */
  hwdec?: string;
  /** True once mpv reported its decoder state. */
  hwdecKnown: boolean;
  droppedFrames?: number;
  cacheSeconds?: number;
  container?: string;
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
  /** The playlist had not changed since the last import; the catalog was kept. */
  unchanged?: boolean;
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
  | 'setVolume'
  | 'togglePlay'
  | 'stop'
  | 'seekBy';

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
  | 'internal'
  | 'engine_missing'
  | 'server';

/** JSON body of an RPC error (Tauri rejection value or HTTP error body). */
export interface RpcErrorPayload {
  code: RpcErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

/**
 * `details` of a rejected `sources.add` / `sources.refresh` (C8, C10). `sourceId` is the
 * row `sources.add` inserted before its importer failed (the source keeps `lastError`).
 * `cancelled: true` marks a run stopped by `sources.cancelImport`, `sources.remove` or an
 * edit: the code is `conflict`, and the previous catalog is intact. Use `isCancelledRun`.
 */
export interface SourceRunErrorDetails {
  sourceId?: string;
  cancelled?: boolean;
}

// ---------------------------------------------------------------------------
// App events (C1). `type` -> payload.
// ---------------------------------------------------------------------------

/**
 * `connecting` opens every run, before its first request. `done` with the message
 * `unchanged` means the playlist had not changed and the catalog was kept as is.
 * `cancelled` (C8): the run was stopped by `sources.cancelImport`; the source's
 * previous catalog is left intact (no half-written data).
 */
export type ImportPhase = 'connecting' | 'fetching' | 'parsing' | 'saving' | 'done' | 'error' | 'cancelled';

/** Sub-step of `phase: 'saving'`. An older core sends no step. */
export type ImportSaveStep = 'replacing' | 'indexing';

export interface ImportProgressEvent {
  sourceId: string;
  phase: ImportPhase;
  done: number;
  total?: number;
  message?: string;
  /** Classified error code (C10); set for `phase: 'error'`. */
  code?: RpcErrorCode;
  /** Download attempt in progress (1-based) and how many are allowed; sent with `phase: 'fetching'`. */
  attempt?: number;
  attempts?: number;
  /**
   * Only with phase 'saving': 'replacing' while the old catalog is deleted (no total), 'indexing'
   * while indexes and counts are rebuilt (done = total).
   */
  step?: ImportSaveStep;
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
  /** `seekBy`: seconds from the current position (negative: back). */
  seconds?: number;
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

/**
 * Why `sources.changed` fired. `added`: a new source, no catalog yet. `catalog`: an import replaced
 * a catalog. `config`: settings of a source changed. `removed`: a source went. `status`: only the
 * status moved (a failed or cancelled import, a schedule backoff); the catalog is as it was.
 */
export type SourcesChangeReason = 'added' | 'catalog' | 'config' | 'removed' | 'status';

/** Both fields are optional: an older core sends `{}`. */
export interface SourcesChangedEvent {
  sourceId?: string;
  reason?: SourcesChangeReason;
}

/**
 * `epg.changed`: `{}` when guide data, mappings or enabled urls changed; `{reason: 'status'}` when
 * only a url's status moved (a refresh started, or a 304 kept the stored guide).
 */
export interface EpgChangedEvent {
  reason?: 'status';
}

/** Server mode: the event socket fell behind and `skipped` events were dropped; refetch everything. */
export interface EventsLaggedEvent {
  skipped: number;
}

export interface AppEventMap {
  'import.progress': ImportProgressEvent;
  'sources.changed': SourcesChangedEvent;
  'epg.progress': EpgProgressEvent;
  'epg.changed': EpgChangedEvent;
  'downloads.update': EmptyEvent;
  'downloads.progress': DownloadProgressEvent;
  'remote.command': RemoteCommandEvent;
  'mpv.state': MpvState;
  /** Left click on the embedded mpv video. */
  'mpv.click': EmptyEvent;
  /** Double click on the embedded mpv video (follows an `mpv.click`). */
  'mpv.dblclick': EmptyEvent;
  /** Mouse wheel over the embedded mpv video; `delta` in notches, positive = away from the user. */
  'mpv.wheel': { delta: number };
  /** Right click released on the embedded mpv video, in CSS px relative to the webview. */
  'mpv.contextmenu': { x: number; y: number };
  /** The app is about to quit (tray Quit): save what must survive, then invoke `flush_done`. */
  'app.flush': EmptyEvent;
  'settings.changed': Settings;
  'player.external': PlayerExternalEvent;
  'deeplink.open': DeepLinkEvent;
  'events.lagged': EventsLaggedEvent;
  // recording:
  'reminders.update': EmptyEvent;
  'reminders.fire': ReminderFiredEvent;
  'recordings.update': EmptyEvent;
  'recordings.progress': RecordingProgressEvent;
  // parental:
  /** Every parental state change: PIN set or removed, configure, unlock, lock, lock-list change, unlock expiry. */
  'parental.changed': ParentalStatus;
  // watchlist:
  /** After every My List write. */
  'watchlist.changed': EmptyEvent;
  // Run 2 (C10):
  /** After every custom-list write, and when a source removal cascades list items away. */
  'lists.changed': EmptyEvent;
  /** After every channel edit (rename, hide, restore). */
  'channels.changed': ChannelsChangedEvent;
  /** A source's cached subscription status changed (`account.status`, `account.statusAll`). */
  'account.changed': { sourceId: string };
}

export type AppEventType = keyof AppEventMap;

/** Wire shape of one event. */
export interface AppEvent<T = unknown> {
  type: string;
  payload: T;
}

// failover: `live.alternates` result (crates/iptv-core/src/live).
/** Quality tier read from a channel name (HD, FHD, 4K...). */
export type ChannelQuality = 'sd' | 'hd' | 'fhd' | 'uhd';

/** The same channel on another source (or a duplicate in the same one). */
export interface LiveAlternate {
  channel: Channel;
  sourceName: string;
  sourceKind: SourceKind;
  quality?: ChannelQuality;
  matchedBy: 'epg' | 'name';
}

export interface LiveAlternates {
  /** Normalized channel name ("sky sports 1"); source pins are keyed by it. */
  key: string;
  quality?: ChannelQuality;
  /** Best first: same quality tier, then source order. */
  alternates: LiveAlternate[];
}

// recording:
/** What a due guide reminder does (`settings.reminderAction`). */
export type ReminderAction = 'notify' | 'switch';

export type ReminderStatus = 'pending' | 'fired' | 'missed';

/** A guide reminder. `start`/`end` are RFC 3339 display times (EPG offset applied). */
export interface Reminder {
  id: string;
  ref: ItemRef;
  channelName: string;
  title: string;
  start: string;
  end: string;
  status: ReminderStatus;
}

export type RecordingStatus = 'scheduled' | 'recording' | 'completed' | 'failed' | 'missed' | 'cancelled';

export type RecordingKind = 'programme' | 'channel';

/** Code of a status message the core wrote on a recording (`Recording.errorCode`), for translation. */
export type RecordingErrorCode =
  | 'reconnecting'
  | 'engineMissing'
  | 'missedNotRunning'
  | 'stoppedShutdown'
  | 'closedEarly'
  | 'closedNothing'
  | 'nothingRecorded'
  | 'stopped'
  | 'sourceRemoved'
  | 'streamDropped'
  | 'streamGaps'
  | 'streamNotFound'
  | 'streamRejected'
  | 'streamNoAnswer'
  | 'streamServerError'
  | 'notAStream'
  | 'diskFull'
  | 'ruleRemoved';

/** A scheduled (or finished) recording. `start`/`end` exclude padding. */
export interface Recording {
  id: string;
  ref: ItemRef;
  channelName: string;
  title?: string;
  kind: RecordingKind;
  start: string;
  end: string;
  paddingBeforeMinutes: number;
  paddingAfterMinutes: number;
  status: RecordingStatus;
  error?: string;
  /** Set when `error` is one of the core's own messages; free-text stream errors have none. */
  errorCode?: RecordingErrorCode;
  fileNames: string[];
  bytes: number;
  startedAt?: string;
  endedAt?: string;
  engine?: string;
  /** Set when a series recording rule (`RecordingRule.id`) created it; absent for manual recordings. */
  ruleId?: string;
}

/** `recordings.schedule`: a programme (`title`, `start`, `end`) or a channel for `durationMinutes`. */
export interface ScheduleRecordingArgs {
  ref: ItemRef;
  channelName: string;
  title?: string;
  start?: string;
  end?: string;
  durationMinutes?: number;
}

export interface ScheduleRecordingResult {
  recording: Recording;
  /** More overlapping recordings on this account than it allows connections (not blocking). */
  warning?: { maxConnections: number; overlapping: number };
}

export interface RecordingCapabilities {
  supported: boolean;
  mpv: boolean;
  reason?: string;
}

/** A recording file in My Videos: a scheduled recording's file, or a loose file in the recordings folder. */
export interface RecordingFile {
  id: string;
  fileName: string;
  recordingId?: string;
  channelName?: string;
  title?: string;
  part?: number;
  sizeBytes: number;
  date: string;
  durationSeconds?: number;
  fileAvailable: boolean;
  status?: RecordingStatus;
}

export interface ReminderFiredEvent {
  reminder: Reminder;
  action: ReminderAction;
  /** When it fired; with the reminder id, tells one firing from a later one of the same reminder. */
  firedAt?: string;
}

export interface RecordingProgressEvent {
  id: string;
  bytes: number;
  elapsedSeconds: number;
}

// parental: parental controls (contract C2; crates/iptv-core/src/parental).
/** `hide` drops locked content from every list; `ask` shows it and asks for the PIN before it opens. */
export type ParentalMode = 'hide' | 'ask';

/** `parental.status` and the `parental.changed` payload. Never carries the PIN or its hash. */
export interface ParentalStatus {
  /** A PIN is set. */
  enabled: boolean;
  /** Default 'hide'. */
  mode: ParentalMode;
  /** Default true; categories whose name marks adult content count as locked. */
  autoAdult: boolean;
  /** 0 = until the app restarts; else 1..=720; default 15. */
  unlockMinutes: number;
  /** A session unlock is active now. */
  unlocked: boolean;
  /** RFC 3339; absent when locked or unlocked until restart. */
  unlockedUntil?: string;
  /** Consecutive wrong PINs. */
  failedAttempts: number;
  /** Present while the wrong-PIN lockout is active. */
  retryAfterSeconds?: number;
}

export type ParentalLockKind = 'category' | 'item';

export interface ParentalLock {
  sourceId: string;
  contentType: ContentType;
  kind: ParentalLockKind;
  /** Category id or item id. */
  targetId: string;
  /** Display name snapshot. */
  name: string;
  createdAt: string;
}

/** A lock to add or remove (`parental.setLocked`). */
export type ParentalLockTarget = Omit<ParentalLock, 'createdAt'>;

// watchlist: My List (contract C3; crates/iptv-core/src/watchlist).
/** One My List entry (movies and series only). */
export interface WatchlistEntry {
  ref: ItemRef;
  snapshot: ItemSnapshot;
  addedAt: string;
  watched: boolean;
}

// channeledit: hide and rename channels (Run 2 contract C2; crates/iptv-core/src/channeledit).
/** One channel edit (live or radio). A row with `hidden: false` and no `name` does not exist. */
export interface ChannelEdit {
  ref: ItemRef;
  hidden: boolean;
  /** Custom name; absent = the provider name. */
  name?: string;
  /** Provider name when last edited (shown in the hidden-channels list). */
  originalName: string;
  /** RFC 3339 UTC. */
  updatedAt: string;
}

/** `channels.changed` payload, emitted after every write. */
export interface ChannelsChangedEvent {
  sourceId: string;
}

// lists: custom channel lists (Run 2 contract C3; crates/iptv-core/src/lists).
/** A user-named list of live/radio channels from any sources. */
export interface CustomList {
  id: string;
  /** Trimmed, 1..60 chars, unique (case-insensitive). */
  name: string;
  position: number;
  /** Shown as a dashboard rail. */
  onDashboard: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One channel of a custom list (`lists.items`). */
export interface CustomListEntry {
  ref: ItemRef;
  /** Stored title/logo, for items the provider dropped and for rails. */
  snapshot: ItemSnapshot;
  /** Present when the item is in the catalog now (custom name applied). */
  channel?: Channel;
  /** False when the provider dropped it (rendered greyed with Remove). */
  available: boolean;
  position: number;
  addedAt: string;
}

// vod: VOD browsing (Run 2 contract C4).
/** `catalog.yearFacets`: titles per year, newest first. */
export interface YearFacet {
  year: number;
  count: number;
}

// guide: guide search and series recording rules (Run 2 contract C5).
/** One `epg.search` hit: a programme on one of the source's channels. */
export interface GuideSearchHit {
  ref: ItemRef;
  channelName: string;
  channelNumber?: number;
  logoUrl?: string;
  categoryId?: string;
  /** Raw guide times like `epg.programs` (the UI applies the EPG offset). */
  program: EpgProgram;
}

/** A series recording rule: record every airing of `title` on one channel. */
export interface RecordingRule {
  id: string;
  ref: ItemRef;
  channelName: string;
  title: string;
  enabled: boolean;
  createdAt: string;
  /** Scheduled recordings this rule has made that have not started yet. */
  upcoming: number;
  /** Start of the next of those, RFC 3339. */
  nextStart?: string;
}

// stats: watch statistics (Run 2 contract C7; crates/iptv-core/src/stats).
/** One day of `stats.summary`; `seconds = liveSeconds + vodSeconds`. */
export interface WatchStatsDay {
  /** Client-local date, YYYY-MM-DD. */
  day: string;
  seconds: number;
  liveSeconds: number;
  vodSeconds: number;
}

/** One channel or title in a `stats.summary` top list. */
export interface WatchStatsTop {
  ref: ItemRef;
  title: string;
  posterUrl?: string;
  seconds: number;
  sourceName?: string;
}

/** `stats.summary`: `days` has exactly the asked number of entries ending at `today`, zero-filled. */
export interface WatchStats {
  days: WatchStatsDay[];
  totalSeconds: number;
  /** Live and radio. */
  topChannels: WatchStatsTop[];
  /** Movies and series. */
  topTitles: WatchStatsTop[];
}

// imagecache: disk image cache (Run 3 contract C2; crates/iptv-core/src/imagecache).
/** `images.stats` / `images.clear`: what the cache holds against its cap (`settings.imageCacheMaxMb` in bytes). */
export interface ImageCacheStats {
  bytes: number;
  files: number;
  maxBytes: number;
}

// screenshot: player frames (Run 3 contract C6; crates/iptv-core/src/screenshot). Desktop only.
/** A saved screenshot: `path` is absolute (inside the screenshot folder); `fileName` is for the toast. */
export interface ScreenshotResult {
  path: string;
  fileName: string;
}
