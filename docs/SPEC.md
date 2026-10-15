# Tsrust IPTV: build spec

This is the authoritative spec for the rebuild. Builders implement contracts exactly as written here. Where this document is silent, follow the upstream IPTVnator app (read-only reference) and the brief.

## 1. Stack

- Rust 2021, stable 1.96. Tauri 2. rusqlite (bundled SQLite) behind an r2d2 pool. tokio + reqwest (rustls). axum 0.8 for the server binary, the remote control API, and the mock servers. quick-xml for XMLTV streaming. tracing + tracing-appender for logs.
- Frontend: React 19, TypeScript 5 (type-checked by `tsc-rs`), Vite 7, Tailwind CSS 4 (`@tailwindcss/vite`), react-router 7 (data router), TanStack Query 5, TanStack Virtual 3, zustand 5, i18next + react-i18next, hls.js, shaka-player, lucide-react.
- Tests: `cargo test` (unit + integration), vitest for pure TS, Playwright for e2e against `iptv-server` + `iptv-mock`.
- Package manager: pnpm. Single package at the repo root (no workspace).

## 2. Layout

Owner codes: W0 = scaffold agent, I = integration agent, B1..B11 = Rust builders, U1..U6 = UI builders, T1..T3 = translators, E1 = e2e. "W0 -> I" means W0 creates it and the integration agent owns it after wave 0.

```
Tsrust IPTV/
  Cargo.toml                       workspace members: crates/*          W0 -> I
  rust-toolchain.toml              stable                               W0
  package.json                     scripts: dev, build, typecheck, test, e2e, tauri   W0 -> I
  tsconfig.json  vite.config.ts  index.html  playwright.config.ts  vitest.config.ts   W0 -> I
  .gitignore  .env.example  README.md  "Start Tsrust IPTV.cmd"  Dockerfile           I
  docs/SPEC.md                     this file (orchestrator)
  docs/architecture/<module>.md    one per builder, owned by that builder
  fixtures/                        small sample files                   B11
    sample.m3u  sample.xml  sample.mp4  backup-v1.json  stalker-*.json  xtream-*.json
  vendor/mpv/                      gitignored; mpv.exe + dlls placed by orchestrator after user approval
  crates/
    iptv-core/
      Cargo.toml                                                       W0 -> I
      src/lib.rs                   pub mod list                        W0 -> I
      src/model.rs                 C2 types, verbatim                  W0 (frozen; additions via I)
      src/error.rs                 CoreError, RpcError (C1)            W0
      src/state.rs                 AppState (C1)                       W0
      src/events.rs                AppEvent, EventSink (C1)            W0
      src/http.rs                  reqwest client + retry (C1)         W0
      src/logging.rs               tracing init to rotating file       W0
      src/rpc/mod.rs               RpcRouter + build_router()          W0 -> I (I adds register calls)
      src/rpc/app.rs               app.info                            W0
      src/db/                      pool, migrations runner, migrations/*.sql, corrupt-db recovery   B1 (W0 writes migrations/0001_init.sql from C3)
      src/catalog/                 items/categories queries + writer (C5), catalog.* rpc            B1
      src/sources/                 sources table, sources.* rpc, startup refresh                    B1
      src/m3u/                     streaming parser, importer, m3u.* rpc                            B1
      src/userstate/               favorites, recent, positions, *.rpc                              B2
      src/settings/                settings + window state, settings.* window.* rpc                 B2
      src/backup/                  manifest v1 export/import, backup.* rpc                          B2
      src/xtream/                  client, catalog sync, xtream.* rpc                               B3
      src/stalker/                 session, client, stalker.* rpc                                   B4
      src/epg/                     xmltv streaming parser, store, epg.* rpc                         B5
      src/downloads/               queue, transfer, myvideos, downloads.* myvideos.* rpc            B6
      src/tmdb/                    client, cache, tmdb.* rpc                                        B7
      src/remote/                  loopback axum router, remote-ui/index.html, remote.* rpc         B8
      src/player/                  external launch, embedded mpv (mpv.exe + JSON IPC), player.* mpv.* rpc   B9
      tests/<module>_*.rs          integration tests, owned by the module's builder
    iptv-fixtures/                 lib: generators (C14)               B11
    iptv-mock/                     bin: mock Xtream/Stalker/M3U/XMLTV/range servers (C13)   B11
    iptv-server/                   bin: axum, serves dist/ + /api (C12)                      B10
    iptv-tauri/
      Cargo.toml  tauri.conf.json  build.rs  capabilities/  icons/     W0 -> I
      src/main.rs  src/lib.rs      rpc command, event bridge, plugins   W0 -> I
      src/mpv_window.rs            child HWND for embedded mpv         B9
  src/
    main.tsx  App.tsx              providers, router mount             W0 -> I
    routes.tsx                     route registry (C7)                 W0 -> I (I wires feature routes)
    api/transport.ts  api/events.ts  api/rpc.ts  api/types.ts  api/query.ts     W0 (frozen; additions via I)
    styles/tokens.css  styles/globals.css   design tokens (C10)       U1 (feature-core)
    ui/                            primitives (C11)                    U1
    shell/                         rail, header, context panel, palette, shortcuts, theme, toasts, dashboard   U1
    i18n/index.ts                  i18next setup, namespace list       U1
    i18n/en/<ns>.json              each UI builder owns its namespace file(s)
    i18n/<lang>/*.json             T1..T3 (wave 2)
    features/sources/              sources page, add/edit dialogs      U2
    features/settings/             settings sections, backup UI        U2
    features/live/                 channel browser, EPG ribbon, EPG grid page, catch-up   U3
    features/vod/                  movies, series, detail, actor, recently added, global search, TMDB rails   U4
    features/player/               player store (C8), inline player, controls, mpv surface, external bar, radio   U5
    features/library/              downloads, my videos, global favorites, global recent   U6
  e2e/                             Playwright specs + helpers          E1 (wave 2)
```

## 3. Dependencies (W0 installs all of these; builders request additions in their reports)

Rust workspace deps (`[workspace.dependencies]`): tauri = "2", tauri-build = "2", tauri-plugin-dialog, tauri-plugin-shell, tauri-plugin-opener, tauri-plugin-single-instance, tauri-plugin-updater, tauri-plugin-deep-link, tauri-plugin-window-state, tauri-plugin-notification (all "2"); rusqlite = { version = "0.32", features = ["bundled"] }; r2d2 = "0.8"; r2d2_sqlite = "0.25"; tokio = { features = ["full"] }; reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls", "gzip", "brotli"] }; serde = { features = ["derive"] }; serde_json; quick-xml = { version = "0.37", features = ["serialize"] }; uuid = { features = ["v4"] }; chrono = { features = ["serde"] }; thiserror; anyhow; tracing; tracing-subscriber = { features = ["env-filter", "json"] }; tracing-appender; axum = { version = "0.8", features = ["ws", "macros"] }; tower-http = { features = ["fs", "cors", "trace"] }; futures; sha2; url; dirs; rand; flate2; memchr; percent-encoding; bytes; tokio-util; async-trait; memory-stats; tempfile; md5 (Stalker); windows = { features = ["Win32_UI_WindowsAndMessaging", "Win32_Foundation", "Win32_Graphics_Gdi"] } (iptv-tauri, cfg windows); clap (mock bin); dashmap; parking_lot; once_cell; hex; base64; regex; strsim (name matching).

If a version pin fails to resolve, W0 picks the latest compatible and records it.

After the fix waves: `tower = { version = "0.5", features = ["util"] }` is also a workspace dependency (iptv-server; dev-dependency of iptv-tauri). iptv-tauri additionally depends on `iptv-server` (path; only the `/api/proxy` route, for the loopback media proxy), `tower-http` (CORS on that proxy) and `webview2-com = "0.39"` (cfg windows; WebView2 memory target in `memory.rs`). No crate uses `tauri-plugin-shell`, `tauri-plugin-notification` or `md5` any more: the shell and notification plugins and their capabilities were removed from iptv-tauri, and the Stalker client never needed md5.

Node devDependencies: typescript ^5.9, tsc-rs (latest), vite ^7, @vitejs/plugin-react, tailwindcss ^4, @tailwindcss/vite, @tauri-apps/cli ^2, @playwright/test, @axe-core/playwright, vitest, @testing-library/react, jsdom, @types/react, @types/react-dom, @types/node.
Node dependencies: react ^19, react-dom ^19, react-router ^7, @tanstack/react-query ^5, @tanstack/react-virtual ^3, zustand ^5, i18next, react-i18next, hls.js ^1.6, shaka-player ^4.15 (or 5 if types resolve), @tauri-apps/api ^2, @tauri-apps/plugin-dialog, @tauri-apps/plugin-opener, @tauri-apps/plugin-updater, lucide-react, clsx, cmdk, mpegts.js ^1.8 (MPEG-TS over HTTP in the HTML5 player), tailwind-merge ^3 (class merging in `@/ui`).

## 4. Contracts

All JSON crossing the boundary is camelCase (`#[serde(rename_all = "camelCase")]` on every Rust type in model.rs and on every rpc args/result struct). Timestamps are RFC 3339 strings in UTC. IDs are strings unless stated.

### C1. RPC transport and events

Rust (`iptv-core/src/rpc/mod.rs`, `error.rs`, `events.rs`, `state.rs`, `http.rs`):

```rust
// error.rs
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RpcErrorCode { NotFound, Invalid, Network, Auth, Timeout, Io, Db, Unsupported, Conflict, Internal, EngineMissing /* mpv missing or cannot run (C12) */, Server /* upstream answered HTTP 429 or a 5xx other than 504; retryable (C12) */ }

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}: {message}")]
pub struct RpcError { pub code: RpcErrorCode, pub message: String, pub retryable: bool, #[serde(skip_serializing_if = "Option::is_none")] pub details: Option<serde_json::Value> }
impl RpcError { pub fn new(code: RpcErrorCode, msg: impl Into<String>) -> Self; pub fn not_found(msg) -> Self; pub fn invalid(msg) -> Self; pub fn network(msg) -> Self /*retryable=true*/; pub fn internal(msg) -> Self; pub fn with_details(self, v: Value) -> Self }
// CoreError is the internal error type; `impl From<CoreError> for RpcError`, `From<rusqlite::Error>`, `From<reqwest::Error>` (Timeout -> Timeout, else Network, retryable), `From<std::io::Error>`, `From<serde_json::Error>` (Invalid).
#[derive(Debug, thiserror::Error)] pub enum CoreError { #[error("not found: {0}")] NotFound(String), #[error("invalid: {0}")] Invalid(String), #[error("network: {0}")] Network(String), #[error("auth: {0}")] Auth(String), #[error("timeout: {0}")] Timeout(String), #[error(transparent)] Io(#[from] std::io::Error), #[error(transparent)] Db(#[from] rusqlite::Error), #[error("conflict: {0}")] Conflict(String), #[error("unsupported: {0}")] Unsupported(String), #[error(transparent)] Other(#[from] anyhow::Error) }
pub type CoreResult<T> = Result<T, CoreError>;

// events.rs
#[derive(Debug, Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct AppEvent { #[serde(rename = "type")] pub kind: String, pub payload: serde_json::Value }
pub trait EventSink: Send + Sync { fn emit(&self, event: AppEvent); }
pub struct BroadcastSink(pub tokio::sync::broadcast::Sender<AppEvent>);  // used by server + tests
impl AppEvent { pub fn new(kind: &str, payload: impl Serialize) -> Self }

// state.rs
pub struct AppState {
  pub data_dir: PathBuf,                 // app data root; db at data_dir/iptv.db, logs at data_dir/logs, downloads default data_dir/downloads
  pub db: crate::db::DbPool,             // r2d2 pool, see C3
  pub http: reqwest::Client,             // built by http::client(): 20 s connect, 60 s read, gzip, no redirects >5, UA "TsrustIPTV/<version>"
  pub events: Arc<dyn EventSink>,
  pub settings: Arc<parking_lot::RwLock<crate::model::Settings>>, // loaded at boot by W0 from the settings table (json column) or Default
  pub is_desktop: bool,
  pub extensions: dashmap::DashMap<&'static str, Arc<dyn Any + Send + Sync>>, // modules stash runtime singletons (download queue, mpv session, remote server handle) under their module name
}
impl AppState { pub async fn new(data_dir: PathBuf, events: Arc<dyn EventSink>, is_desktop: bool) -> CoreResult<Arc<Self>>; pub fn conn(&self) -> CoreResult<r2d2::PooledConnection<SqliteConnectionManager>>; pub fn ext<T: Any + Send + Sync>(&self, key: &'static str) -> Option<Arc<T>>; pub fn set_ext<T: Any + Send + Sync>(&self, key: &'static str, v: Arc<T>) }

// http.rs
pub fn client(user_agent: Option<&str>) -> reqwest::Client;
pub async fn with_retry<T, F, Fut>(attempts: u32, op: F) -> CoreResult<T> where F: Fn() -> Fut, Fut: Future<Output = CoreResult<T>>; // backoff 300 ms * 2^n + jitter, retries only Network/Timeout
pub fn apply_source_headers(req: reqwest::RequestBuilder, h: &crate::model::RequestHeaders) -> reqwest::RequestBuilder; // User-Agent, Referer, Origin when present

// rpc/mod.rs
pub type RpcResult = Result<serde_json::Value, RpcError>;
pub type Handler = Arc<dyn Fn(Arc<AppState>, serde_json::Value) -> futures::future::BoxFuture<'static, RpcResult> + Send + Sync>;
pub struct RpcRouter { handlers: HashMap<&'static str, Handler> }
impl RpcRouter {
  pub fn new() -> Self;
  pub fn add<A, R, F, Fut>(&mut self, name: &'static str, f: F)
    where A: DeserializeOwned + Send + 'static, R: Serialize + 'static, F: Fn(Arc<AppState>, A) -> Fut + Send + Sync + 'static, Fut: Future<Output = Result<R, RpcError>> + Send + 'static;
    // args `null`/missing deserialize as A when A is `()` or has all-optional fields (use `#[serde(default)]`)
  pub async fn dispatch(&self, state: Arc<AppState>, cmd: &str, args: serde_json::Value) -> RpcResult; // unknown cmd -> NotFound
  pub fn names(&self) -> Vec<&'static str>;
}
pub fn build_router() -> RpcRouter // W0 registers rpc::app; I appends: crate::sources::rpc::register, catalog, m3u, userstate, settings, backup, xtream, stalker, epg, downloads, tmdb, remote, player
```

Every module exposes `pub fn register(r: &mut RpcRouter)` at `crate::<module>::rpc::register`. Handler names are `"<module>.<verb>"` exactly as listed in C4. Modules that need a background runtime (downloads queue, remote server, mpv session, epg refresher, startup refresh) also expose `pub async fn init(state: Arc<AppState>) -> CoreResult<()>`; `crate::rpc::init_all(state)` (W0 stub, I wires) calls them at boot after `AppState::new`.

Tauri (`iptv-tauri/src/lib.rs`): `#[tauri::command] async fn rpc(state: tauri::State<'_, Arc<AppState>>, cmd: String, args: serde_json::Value) -> Result<serde_json::Value, RpcError>`. Events: the Tauri EventSink calls `app.emit("app-event", event)`.

HTTP (iptv-server, C12): `POST /api/rpc/{cmd}` with JSON body = args (empty body allowed = null). 200 with JSON result; on error, status by code (NotFound 404, Invalid 400, Auth 401, Timeout 504, Network 502, Server 502, EngineMissing 503, Unsupported 501, Conflict 409; Io, Db and Internal 500) with the RpcError JSON as body. `GET /api/events` is a WebSocket; each text frame is one AppEvent JSON.

TypeScript (`src/api/transport.ts`):
```ts
export type RpcName = keyof RpcMap;
export type RpcArgs<K extends RpcName> = RpcMap[K]['args'];
export type RpcResult<K extends RpcName> = RpcMap[K]['result'];
export class RpcError extends Error { code: RpcErrorCode; retryable: boolean; details?: unknown }
export function rpc<K extends RpcName>(cmd: K, ...args: RpcArgs<K> extends void ? [] : [RpcArgs<K>]): Promise<RpcResult<K>>;
export const isDesktop: boolean; // true when window.__TAURI_INTERNALS__ exists
export function proxiedUrl(source: PlayerSource): string; // desktop: file -> asset URL; http(s) with headers or mixed content -> `${app.info.proxyBase}?url=...&sourceId=...&ua=&referer=&origin=` (loopback proxy), else source.url; web: /api/proxy?url=...&sourceId=...[&ua=&referer=&origin=] when headers present or mixed content
// src/api/events.ts
export function onAppEvent<T = unknown>(type: string, handler: (payload: T) => void): () => void;  // Tauri listen('app-event') or WS /api/events; reconnects with backoff
// src/api/query.ts
export function useRpcQuery<K extends RpcName>(cmd: K, args: RpcArgs<K>, opts?: { enabled?: boolean; staleTime?: number; keepPrevious?: boolean }): UseQueryResult<RpcResult<K>, RpcError>;
export function useRpcMutation<K extends RpcName>(cmd: K, opts?: { invalidate?: string[] }): UseMutationResult<RpcResult<K>, RpcError, RpcArgs<K>>;
export function invalidate(prefix: string): void; // invalidates queries whose key[0] starts with prefix, e.g. 'xtream.'
// query keys are [cmd, args]
```

Event names (kind) used across slices: `import.progress {sourceId, phase: 'fetching'|'parsing'|'saving'|'done'|'error'|'cancelled', done: number, total?: number, message?: string, code?: RpcErrorCode}` (`code` is set with `error`, C10; `cancelled` means the run was stopped and the previous catalog is intact, C8); `sources.changed {}`; `epg.progress {url, phase, programs, message?}`; `epg.changed {}`; `downloads.update {}`; `downloads.progress {id, bytesDownloaded, totalBytes?, bytesPerSecond}`; `remote.command {command: 'channelUp'|'channelDown'|'selectNumber'|'selectId'|'volumeUp'|'volumeDown'|'mute'|'setVolume', number?: number, id?: string, level?: number}`; `mpv.state MpvState`; `settings.changed Settings`; `player.external {state: 'started'|'exited', player, title, pid?, exitCode?}`.

### C2. Model types (Rust `model.rs` and TS `src/api/types.ts`, identical shapes)

```ts
export type SourceKind = 'm3u' | 'xtream' | 'stalker';
export type M3uOrigin = 'url' | 'file' | 'text';
export type ContentType = 'live' | 'movie' | 'series' | 'radio';
export interface RequestHeaders { userAgent?: string; referrer?: string; origin?: string; }
export interface M3uSourceConfig { origin: M3uOrigin; url?: string; filePath?: string; headers: RequestHeaders; }
export interface XtreamSourceConfig { serverUrl: string; username: string; password: string; }
export interface StalkerSourceConfig { portalUrl: string; macAddress: string; isFullPortal: boolean; username?: string; password?: string; headers: RequestHeaders; serialNumber?: string; deviceId1?: string; deviceId2?: string; signature1?: string; signature2?: string; }
export interface EpgLinks { detectedUrls: string[]; manualUrls: string[]; disabledUrls: string[]; }
export interface Source { id: string; kind: SourceKind; name: string; position: number; autoRefresh: boolean; createdAt: string; updatedAt?: string; lastRefreshAt?: string; lastError?: string; channelCount: number; movieCount: number; seriesCount: number; epg: EpgLinks; m3u?: M3uSourceConfig; xtream?: XtreamSourceConfig; stalker?: StalkerSourceConfig; }
export interface ItemRef { sourceId: string; contentType: ContentType; itemId: string; }
// itemId: m3u -> 16 hex chars of sha256(url + '\n' + name); xtream -> stream_id / series_id as decimal string; stalker -> portal id string
export interface Category { id: string; sourceId: string; contentType: ContentType; name: string; hidden: boolean; itemCount: number; position: number; }
export interface ArchiveInfo { enabled: boolean; durationHours?: number; }
export interface Channel { ref: ItemRef; name: string; number?: number; logoUrl?: string; categoryId: string; categoryName: string; epgChannelId?: string; url?: string; isRadio: boolean; archive?: ArchiveInfo; }
export interface VodItem { ref: ItemRef; title: string; titleBase?: string; year?: number; posterUrl?: string; backdropUrl?: string; rating?: number; added?: string; categoryId: string; categoryName?: string; containerExtension?: string; durationSeconds?: number; plot?: string; genres?: string[]; tmdbId?: number; }
export interface SeriesItem { ref: ItemRef; title: string; titleBase?: string; year?: number; posterUrl?: string; backdropUrl?: string; rating?: number; added?: string; categoryId: string; categoryName?: string; plot?: string; genres?: string[]; tmdbId?: number; }
export interface Episode { id: string; seriesRef: ItemRef; season: number; episode: number; title: string; plot?: string; durationSeconds?: number; posterUrl?: string; containerExtension?: string; added?: string; }
export interface Season { number: number; name?: string; posterUrl?: string; episodes: Episode[]; }
export interface Person { id?: number; name: string; role?: string; profileUrl?: string; }
export interface VodDetail { item: VodItem; cast: Person[]; director?: string; trailerUrl?: string; backdrops: string[]; }
export interface SeriesDetail { item: SeriesItem; seasons: Season[]; cast: Person[]; director?: string; trailerUrl?: string; backdrops: string[]; }
export interface Page<T> { items: T[]; total: number; offset: number; limit: number; }
export type SortKey = 'name' | 'added' | 'rating' | 'number' | 'year';
export interface PageQuery { offset: number; limit: number; search?: string; sort?: SortKey; dir?: 'asc' | 'desc'; }
export interface EpgProgram { channelId: string; start: string; end: string; title: string; description?: string; category?: string; icon?: string; }
export interface EpgNowNext { now?: EpgProgram; next?: EpgProgram; }
export interface ItemSnapshot { title: string; subtitle?: string; posterUrl?: string; contentType: ContentType; }
export interface PlaybackPosition { ref: ItemRef; episodeId?: string; positionSeconds: number; durationSeconds?: number; updatedAt: string; snapshot?: ItemSnapshot; }
export interface FavoriteEntry { ref: ItemRef; addedAt: string; position: number; snapshot: ItemSnapshot; }
export interface RecentEntry { ref: ItemRef; viewedAt: string; snapshot: ItemSnapshot; }
export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled';
export interface Download { id: number; ref: ItemRef; episodeId?: string; title: string; subtitle?: string; url: string; fileName?: string; filePath?: string; posterUrl?: string; status: DownloadStatus; bytesDownloaded: number; totalBytes?: number; errorMessage?: string; createdAt: string; updatedAt: string; completedAt?: string; fileAvailable?: boolean; positionSeconds: number; }
export type PlayerKind = 'hls' | 'dash' | 'direct' | 'file';
export interface PlayerSource { url: string; kind: PlayerKind; headers?: RequestHeaders; title: string; subtitle?: string; posterUrl?: string; ref?: ItemRef; episodeId?: string; resumeSeconds?: number; isLive: boolean; isRadio: boolean; }
export type VideoPlayer = 'html5' | 'videojs' | 'embedded-mpv' | 'mpv' | 'vlc';
export type StreamFormat = 'm3u8' | 'ts';
export type Theme = 'light' | 'dark' | 'system';
export type StartupBehavior = 'first-view' | 'restore-last-view';
export interface DashboardRails { hero: boolean; continueWatching: boolean; liveFavorites: boolean; recentlyWatchedLive: boolean; favoriteMoviesAndSeries: boolean; recentSources: boolean; recentlyAdded: boolean; tmdbTrending: boolean; }
export interface TmdbSettings { enabled: boolean; apiKey?: string; language?: string; }
export interface RemoteControlSettings { enabled: boolean; port: number; } // default port 7310
export interface Settings { player: VideoPlayer; streamFormat: StreamFormat; epgUrls: string[]; language: string; theme: Theme; showDashboard: boolean; startupBehavior: StartupBehavior; lastRoute?: string; mpvPath?: string; vlcPath?: string; mpvArgs: string; vlcArgs: string; openStreamOnDoubleClick: boolean; showCaptions: boolean; downloadsDir?: string; tmdb: TmdbSettings; dashboardRails: DashboardRails; remoteControl: RemoteControlSettings; playerAmbientMode: boolean; playerAutoplayNextEpisode: boolean; playerUpNextRail: boolean; fullscreenChannelPanel: boolean; vodAutoFailover: boolean; epgViewMode: 'timeline' | 'list'; coverSize: 'small' | 'medium' | 'large'; }
export interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean; }
export interface AppInfo { version: string; dataDir: string; platform: string; isDesktop: boolean; logFile: string; }
export interface MpvTrack { id: number; type: 'audio' | 'sub' | 'video'; title?: string; lang?: string; selected: boolean; }
export interface MpvState { attached: boolean; loaded: boolean; paused: boolean; timePos: number; duration?: number; volume: number; muted: boolean; tracks: MpvTrack[]; fullscreen: boolean; error?: string; }
export interface EpgSourceStatus { url: string; lastFetchAt?: string; status: 'idle' | 'fetching' | 'ok' | 'error'; programCount: number; channelCount: number; error?: string; enabled: boolean; origin: 'settings' | 'source'; sourceId?: string; }
export interface ImportSummary { channels: number; movies: number; series: number; }
```

Rust mirrors these 1:1 with `Option<T>` for `?` fields, `f64` for rating, `i64` for counts/positions, `Vec<T>` for arrays, `ItemRef` deriving `Hash, Eq, Clone`. Enums are `#[serde(rename_all = "kebab-case")]` string enums (`ContentType::Live` -> "live", `VideoPlayer::EmbeddedMpv` -> "embedded-mpv"). Settings has `impl Default` with: player html5, streamFormat m3u8, language "en", theme system, showDashboard true, startupBehavior first-view, mpvArgs "", vlcArgs "", openStreamOnDoubleClick false, showCaptions false, tmdb {enabled false}, all dashboardRails true, remoteControl {enabled false, port 7310}, playerAmbientMode false, autoplayNext true, upNextRail true, fullscreenChannelPanel true, vodAutoFailover false, epgViewMode timeline, coverSize medium. Every Settings field has `#[serde(default)]` so older JSON loads.

### C3. SQLite schema (`crates/iptv-core/src/db/migrations/0001_init.sql`, written by W0 verbatim, owned by B1 afterwards)

Pool: `pub type DbPool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>`; `pub fn open(path: &Path) -> CoreResult<DbPool>` sets `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, pool max 8. `pub fn migrate(conn: &mut Connection) -> CoreResult<()>` applies `migrations/NNNN_*.sql` (embedded via `include_str!`) in order, tracked in `schema_migrations`. If opening or migrating fails with a corruption error, rename the db to `iptv.db.corrupt-<timestamp>` and recreate (log a warning). Long imports use one write transaction per source. W0 writes `db/mod.rs` with `open`, `migrate`, and the pool type so AppState compiles; B1 owns and extends it afterwards.

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('m3u','xtream','stalker')), name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, auto_refresh INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, last_refresh_at TEXT, last_error TEXT,
  config_json TEXT NOT NULL,            -- M3uSourceConfig | XtreamSourceConfig | StalkerSourceConfig (camelCase JSON)
  epg_json TEXT NOT NULL DEFAULT '{"detectedUrls":[],"manualUrls":[],"disabledUrls":[]}'
);
CREATE TABLE m3u_raw (source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, raw TEXT NOT NULL, sha256 TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE categories (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, category_id TEXT NOT NULL,
  name TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, content_type, category_id)
);
CREATE TABLE items (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL,
  category_id TEXT NOT NULL, title TEXT NOT NULL, title_base TEXT, number INTEGER, logo_url TEXT, poster_url TEXT, backdrop_url TEXT,
  rating REAL, added TEXT, year INTEGER, epg_channel_id TEXT, url TEXT, container_extension TEXT, is_radio INTEGER NOT NULL DEFAULT 0,
  archive_hours INTEGER, extra_json TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, content_type, item_id)
);
CREATE INDEX idx_items_cat ON items(source_id, content_type, category_id, position);
CREATE INDEX idx_items_title ON items(source_id, content_type, title COLLATE NOCASE);
CREATE INDEX idx_items_added ON items(content_type, added DESC);
CREATE INDEX idx_items_number ON items(source_id, number);
CREATE INDEX idx_items_epg ON items(epg_channel_id);
CREATE VIRTUAL TABLE items_fts USING fts5(title, content='items', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, title) VALUES (new.rowid, new.title); END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, title) VALUES ('delete', old.rowid, old.title); END;
CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, title) VALUES ('delete', old.rowid, old.title); INSERT INTO items_fts(rowid, title) VALUES (new.rowid, new.title); END;
CREATE TABLE favorites (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, position INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT NOT NULL, PRIMARY KEY (source_id, content_type, item_id));
CREATE TABLE recent (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, snapshot_json TEXT NOT NULL, PRIMARY KEY (source_id, content_type, item_id));
CREATE INDEX idx_recent_viewed ON recent(viewed_at DESC);
CREATE TABLE playback_positions (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, episode_id TEXT NOT NULL DEFAULT '', position_seconds INTEGER NOT NULL DEFAULT 0, duration_seconds INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, snapshot_json TEXT, PRIMARY KEY (source_id, content_type, item_id, episode_id));
CREATE INDEX idx_positions_updated ON playback_positions(updated_at DESC);
CREATE TABLE epg_sources (url TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'settings', source_id TEXT, last_fetch_at TEXT, status TEXT NOT NULL DEFAULT 'idle', error TEXT, channel_count INTEGER NOT NULL DEFAULT 0, program_count INTEGER NOT NULL DEFAULT 0, etag TEXT);
CREATE TABLE epg_channels (epg_url TEXT NOT NULL REFERENCES epg_sources(url) ON DELETE CASCADE, channel_id TEXT NOT NULL, display_name TEXT NOT NULL, icon TEXT, PRIMARY KEY (epg_url, channel_id));
CREATE INDEX idx_epg_channels_name ON epg_channels(display_name COLLATE NOCASE);
CREATE TABLE epg_programs (epg_url TEXT NOT NULL REFERENCES epg_sources(url) ON DELETE CASCADE, channel_id TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT, icon TEXT);  -- start/stop unix seconds UTC
CREATE INDEX idx_epg_programs_chan ON epg_programs(channel_id, start);
CREATE INDEX idx_epg_programs_stop ON epg_programs(stop);
CREATE TABLE epg_channel_map (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, epg_channel_id TEXT, PRIMARY KEY (source_id, content_type, item_id));  -- manual override; NULL = explicitly unmapped
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, content_type TEXT NOT NULL, item_id TEXT NOT NULL, episode_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL, subtitle TEXT, url TEXT NOT NULL, file_name TEXT, file_path TEXT, poster_url TEXT, headers_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','downloading','paused','completed','failed','canceled')),
  bytes_downloaded INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER, resume_validator TEXT, error_message TEXT, position_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT,
  UNIQUE (source_id, content_type, item_id, episode_id)
);
CREATE INDEX idx_downloads_status ON downloads(status);
CREATE TABLE tmdb_cache (media_type TEXT NOT NULL, lookup_key TEXT NOT NULL, tmdb_id INTEGER, payload_json TEXT, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (media_type, lookup_key));
CREATE TABLE vod_source_pins (match_key TEXT PRIMARY KEY, source_id TEXT NOT NULL, item_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO schema_migrations(version) VALUES (1);
```

Window state lives in `app_state` under key `window_state`; last route under `settings.lastRoute`.

### C4. RPC command catalog (`src/api/rpc.ts` RpcMap, written by W0; each Rust module registers exactly these names)

Notation: `name: args -> result`. `void` args means no payload. Types from C2.

app (W0): `app.info: void -> AppInfo`; `app.openLogDir: void -> void`; `app.openPath: {path} -> void` (opener; existing local folders and media, subtitle or playlist files only. Network (UNC) paths are refused unless they are at or under the configured downloads or recordings folder; verbatim `\\?\` and device `\\.\` paths are always refused); `app.ping: void -> {ok: true}`.

sources (B1): `sources.list: void -> Source[]` (ordered by position); `sources.get: {id} -> Source`; `sources.add: {kind; name; autoRefresh?; m3u?: {origin; url?; filePath?; text?; headers?}; xtream?: XtreamSourceConfig; stalker?: StalkerSourceConfig} -> Source` (validates, inserts, then runs the kind's importer: m3u -> `crate::m3u`, xtream -> `crate::xtream`, stalker -> `crate::stalker`; emits `import.progress`; on importer failure the source stays with `lastError` set and the error is returned); `sources.update: {id; patch: {name?; autoRefresh?; position?; m3u?; xtream?; stalker?; epg?: Partial<EpgLinks>}} -> Source` (config change does not re-import); `sources.remove: {id} -> void`; `sources.reorder: {ids: string[]} -> void`; `sources.refresh: {id} -> Source` (re-import; m3u refetch, xtream/stalker resync); `sources.refreshAll: void -> {refreshed: string[]; failed: {id; error; code?}[]}` (sources with autoRefresh; `code` per C10); `sources.counts: {id} -> {channelCount; movieCount; seriesCount}`; `sources.cancelImport: {id} -> boolean` (C8: cancels the source's running import or refresh; true when one was running and is now cancelling, false when nothing was running).
Importer dispatch: B1 declares in `sources/mod.rs`:
```rust
#[async_trait::async_trait]
pub trait Importer: Send + Sync { fn kind(&self) -> SourceKind; async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary>; }
pub fn register_importer(state: &AppState, imp: Arc<dyn Importer>);   // stored in state.extensions under "importers" as Arc<DashMap<SourceKind, Arc<dyn Importer>>>
```
B3 and B4 call `register_importer` from their `init(state)`; B1's m3u importer registers in B1's own `init`. `sources.add` looks the importer up by kind; a missing importer yields `Unsupported`.

catalog (B1): `catalog.categories: {sourceId; contentType; includeHidden?: boolean} -> Category[]`; `catalog.setCategoryHidden: {sourceId; contentType; categoryId; hidden} -> void`; `catalog.setCategoriesHidden: {sourceId; contentType; hiddenIds: string[]} -> void` (replace set); `catalog.channels: {sourceId; categoryId?; query: PageQuery; includeHidden?; radio?: boolean} -> Page<Channel>` (contentType live, or radio when radio=true); `catalog.movies: {sourceId; categoryId?; query: PageQuery} -> Page<VodItem>`; `catalog.series: {sourceId; categoryId?; query: PageQuery} -> Page<SeriesItem>`; `catalog.item: {ref} -> Channel | VodItem | SeriesItem` (shape by contentType); `catalog.channelByNumber: {sourceId; number} -> Channel | null`; `catalog.neighbors: {ref; categoryId?} -> {prev?: Channel; next?: Channel}` (for channel up/down inside the current list); `catalog.search: {query; sourceId?; contentTypes?: ContentType[]; limit?: number} -> {live: Channel[]; movies: VodItem[]; series: SeriesItem[]}` (FTS prefix match, hidden categories excluded); `catalog.recentlyAdded: {sourceId?; contentType: 'movie'|'series'; limit} -> VodItem[] | SeriesItem[]`; `catalog.sameTitle: {ref} -> VodItem[]` (other sources, same title_base + year; multi-source resolution); `catalog.allLiveChannels: {sourceId} -> Channel[]` (used only by remote control publication; capped at 20000).

live (failover slice): `live.alternates: {ref} -> LiveAlternates` where `LiveAlternates = {key: string; quality?: 'sd'|'hd'|'fhd'|'uhd'; alternates: {channel: Channel; sourceName; sourceKind; quality?; matchedBy: 'epg'|'name'}[]}` (the same live or radio channel on other sources, best first; Invalid for other content types, NotFound for an unknown item). Settings gain `liveFailover: boolean` (default true) and `streamReconnect: boolean` (default true). See `docs/architecture/failover.md`.

m3u (B1): `m3u.raw: {sourceId} -> {text: string; sha256: string; fetchedAt: string}`; `m3u.parsePreview: {text} -> {channelCount; groups: string[]; epgUrls: string[]}` (first 2 MB only).
M3U parsing: `#EXTM3U` header attrs (`url-tvg`, `x-tvg-url` -> detectedUrls, comma-separated), `#EXTINF:-1 attr="v" ...,Name` with attrs tvg-id, tvg-name, tvg-logo, tvg-chno, group-title, radio, catchup, catchup-days, catchup-source; `#EXTGRP:`; `#EXTVLCOPT:http-user-agent=` / `http-referrer=` per channel (kept in extra_json); `#KODIPROP`; lines are read with a `BufRead` line iterator, never the whole file (for `text` origin the text is already in memory; still stream through the same parser); items whose url ends with .mp4/.mkv/.avi and group-title containing "movie"/"vod" become content_type movie; `radio="true"` -> radio; everything else live. Group id = sha256(group name) first 16 hex.

userstate (B2): `favorites.list: {sourceId?} -> FavoriteEntry[]`; `favorites.toggle: {ref; snapshot: ItemSnapshot} -> {isFavorite: boolean}`; `favorites.contains: {refs: ItemRef[]} -> ItemRef[]` (the subset that are favorites); `favorites.reorder: {sourceId?; refs: ItemRef[]} -> void`; `favorites.remove: {ref} -> void`; `recent.list: {sourceId?; limit?} -> RecentEntry[]`; `recent.add: {ref; snapshot} -> void`; `recent.remove: {ref} -> void`; `recent.clear: {sourceId?} -> void`; `positions.get: {ref; episodeId?} -> PlaybackPosition | null`; `positions.set: {ref; episodeId?; positionSeconds; durationSeconds?; snapshot?} -> void` (deleted when positionSeconds >= 0.95*duration); `positions.forSeries: {ref} -> PlaybackPosition[]`; `positions.continueWatching: {limit} -> PlaybackPosition[]` (snapshot filled); `positions.remove: {ref; episodeId?} -> void`.

settings (B2): `settings.get: void -> Settings`; `settings.update: {patch: Partial<Settings>} -> Settings` (emits settings.changed; refreshes AppState.settings cache); `settings.reset: void -> Settings`; `window.getState: void -> WindowState | null`; `window.setState: {state: WindowState} -> void`; `settings.detectPlayers: void -> {mpvPath?: string; vlcPath?: string}` (delegates to `crate::player::detect()` which B9 exposes as `pub fn detect(settings: &Settings) -> DetectedPlayers { pub mpv_path: Option<String>, pub vlc_path: Option<String> }`).

backup (B2): `backup.export: {includeSecrets: boolean; path?: string} -> {json: string; fileName: string; path?: string}` (with `path`, desktop only: the core writes the file atomically and returns `json: ""` plus the saved `path`; server mode answers Unsupported, a path inside the app data dir answers Invalid); `backup.import: {json: string; mode: 'merge'|'replace'} -> {imported: number; skipped: number; warnings: string[]}` (format C15).

xtream (B3): `xtream.sync: {sourceId; contentTypes?: ContentType[]} -> ImportSummary`; `xtream.vodDetail: {ref} -> VodDetail`; `xtream.seriesDetail: {ref} -> SeriesDetail`; `xtream.streamUrl: {ref; episodeId?} -> PlayerSource` (live `{server}/live/{u}/{p}/{id}.{m3u8|ts}` by settings.streamFormat when the panel's `allowed_output_formats` lists it or lists nothing, else the first allowed of m3u8 > ts > the panel's first format, kind hls/direct; movie `{server}/movie/{u}/{p}/{id}.{ext}`; episode `{server}/series/{u}/{p}/{episodeId}.{ext}`); `xtream.catchupUrl: {ref; start: string; durationMinutes: number} -> PlayerSource` (`{server}/timeshift/{u}/{p}/{duration}/{YYYY-MM-DD:HH-mm}/{id}.ts`, kind direct); `xtream.shortEpg: {ref; limit?} -> EpgProgram[]` (player_api get_short_epg, base64 titles decoded); `xtream.accountInfo: {sourceId} -> {status; expDate?; activeCons; maxConnections; isTrial; createdAt?; serverTime?; timezone?; allowedOutputFormats: string[]}`; `xtream.test: {config: XtreamSourceConfig} -> {ok: boolean; message?: string; name?: string}`.
Xtream API: `GET {server}/player_api.php?username&password[&action=...]`. Actions: get_live_categories, get_vod_categories, get_series_categories, get_live_streams, get_vod_streams, get_series, get_vod_info&vod_id, get_series_info&series_id, get_short_epg&stream_id&limit. XMLTV at `{server}/xmltv.php?username&password` is added to `source.epg.detectedUrls` on sync. Rating strings parsed leniently. `stream_icon`, `cover`, `backdrop_path[]`, `tv_archive`, `tv_archive_duration`, `epg_channel_id`, `num`, `added` (unix seconds string -> RFC3339), `container_extension`, `category_id`, `category_ids[]` (first wins), `is_adult` kept in extra_json. Catalog responses are streamed to disk-free parsing: use `reqwest` bytes then `serde_json::from_slice` into `Vec<RawItem>` per content type (one type at a time) and feed `catalog::replace_catalog` with an iterator; drop each Vec before the next type.

stalker (B4): `stalker.sync: {sourceId} -> ImportSummary` (itv genres + all channels, radio; VOD/series categories only); `stalker.movies: {sourceId; categoryId?; query: PageQuery} -> Page<VodItem>` (live from portal `type=vod&action=get_ordered_list&category&p&sortby`, page size 14 mapped to offset/limit); `stalker.series: {sourceId; categoryId?; query} -> Page<SeriesItem>`; `stalker.vodDetail: {ref} -> VodDetail`; `stalker.seriesDetail: {ref} -> SeriesDetail` (seasons from `get_ordered_list&movie_id`, VOD-as-series when `is_series=1`); `stalker.streamUrl: {ref; episodeId?} -> PlayerSource` (`create_link` with `cmd`, extracts the URL after the `ffmpeg ` / `auto ` prefix; episode via `series=<n>`); `stalker.catchupUrl: {ref; start; durationMinutes} -> PlayerSource` (`type=tv_archive&action=create_link`); `stalker.epg: {ref; limit?; from?} -> EpgProgram[]` (`type=itv&action=get_short_epg` or `get_epg_info`; `limit` caps the airing and upcoming programmes; with `from` (RFC 3339) the archived programmes since then, at most 7 days back, are added from `get_simple_data_table` per day); `stalker.search: {sourceId; query; contentType} -> Page<VodItem|SeriesItem>`; `stalker.accountInfo: {sourceId} -> {mac; status?; expDate?; tariff?; raw: object}`; `stalker.test: {config} -> {ok; message?}`.
Stalker protocol: base `{portalUrl}` normalized to `.../portal.php` (also try `/stalker_portal/server/load.php` and `/c/portal.php` on discovery). Headers: `User-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3`, `Cookie: mac={mac}; stb_lang=en; timezone=Europe/Paris`, `X-User-Agent: Model: MAG250; Link: WiFi`, `Authorization: Bearer {token}` after handshake. Handshake: `?type=stb&action=handshake&token=&JsHttpRequest=1-xml` -> `js.token`; then `type=stb&action=get_profile&...`; token cached per source in `app_state` (`stalker_token:<sourceId>`); on 401/"Authorization failed" re-handshake once and retry. Lists: `type=itv&action=get_genres`, `type=itv&action=get_all_channels` (fields: id, name, number, logo, tv_genre_id, cmd, tv_archive_duration, xmltv_id), `type=radio&action=get_ordered_list`, `type=vod&action=get_categories`, `type=series&action=get_categories`, `type=vod|series&action=get_ordered_list&category=<id>&p=<page>&sortby=added|name`, `action=create_link&type=itv|vod&cmd=<cmd>&series=<n>`. Logos relative to portal base are made absolute. Token-free panels (isFullPortal=false) skip handshake. Every response is `{"js": ...}`; `js.data` for lists with `total_items`, `max_page_items`.

epg (B5): `epg.sources: void -> EpgSourceStatus[]` (union of settings.epgUrls and every source's detected+manual urls minus disabled); `epg.refresh: {url?} -> void` (all enabled or one; runs in background; emits epg.progress and epg.changed); `epg.nowNext: {refs: ItemRef[]} -> Record<string, EpgNowNext>` (key = `${sourceId}|${contentType}|${itemId}`); `epg.programs: {ref; from: string; to: string} -> EpgProgram[]`; `epg.grid: {refs: ItemRef[]; from; to} -> Record<string, EpgProgram[]>`; `epg.channelsSearch: {query; limit?} -> {channelId: string; displayName: string; icon?: string; epgUrl: string}[]`; `epg.setMapping: {ref; epgChannelId: string | null} -> void`; `epg.clearMapping: {ref} -> void`; `epg.resolve: {ref} -> {epgChannelId?: string; via: 'manual'|'item'|'name'|'none'}`; `epg.setEnabled: {url; enabled} -> void`.
Resolution order for a ref: manual map row (NULL = none) > `items.epg_channel_id` present in `epg_channels` > case-insensitive match of item title (stripped of suffixes like " HD", " FHD", " 4K", country prefixes "UK:") against `epg_channels.display_name` > none. XMLTV parsing: streaming via quick-xml `Reader::from_reader(BufReader)`; gzip-detected by magic bytes; dates `YYYYMMDDHHmmss ±HHMM`; programmes older than 2 days or beyond 14 days skipped; batched inserts of 2000 per transaction into staging rows keyed by epg_url, then delete old rows for that epg_url and rename in one transaction (or delete+insert inside one tx). B5's `init` refreshes stale EPG sources (older than 12 h) 10 s after boot.

downloads (B6): `downloads.list: void -> Download[]`; `downloads.get: {id} -> Download`; `downloads.start: {ref; episodeId?; title; subtitle?; url; headers?; posterUrl?; fileNameHint?} -> Download`; `downloads.pause: {id}`; `downloads.resume: {id}`; `downloads.cancel: {id}`; `downloads.retry: {id}`; `downloads.remove: {id; deleteFile: boolean}`; `downloads.reveal: {id} -> void`; `downloads.setDir: {path} -> void`; `downloads.dir: void -> {path}`; `downloads.setPosition: {id; positionSeconds} -> void`; `myvideos.list: void -> Download[]` (completed, with fileAvailable); `myvideos.playSource: {id} -> PlayerSource` (kind file; url = Tauri asset URL `convertFileSrc` compatible path on desktop, i.e. the absolute file path which the UI converts, or `/api/files/{id}` on server). Max 2 concurrent transfers; Range resume with ETag/Last-Modified validator; `.part` reservation: `name.part`, `name (1).part`...; final rename never overwrites; cancel deletes `.part`; failure keeps `.part` when total known. Emits downloads.update and downloads.progress (throttled to 4/s per id). Queue restored from DB on `init` (downloading -> queued).

tmdb (B7): `tmdb.movie: {title; year?; tmdbId?} -> TmdbMovie | null`; `tmdb.tv: {title; year?; tmdbId?} -> TmdbTv | null`; `tmdb.season: {tmdbId; season} -> TmdbSeason | null`; `tmdb.person: {personId} -> TmdbPerson | null`; `tmdb.trending: void -> TmdbBrief[]`; `tmdb.similar: {mediaType: 'movie'|'tv'; tmdbId} -> TmdbBrief[]`; `tmdb.testKey: {apiKey} -> {ok; message?}`; `tmdb.clearCache: void -> void`.
Types: `TmdbBrief {tmdbId; mediaType: 'movie'|'tv'; title; year?; posterUrl?; backdropUrl?; rating?; overview?}`, `TmdbMovie extends TmdbBrief {runtime?; genres: string[]; cast: Person[]; crew: Person[]; director?; trailerYoutubeKey?; similar: TmdbBrief[]; imdbId?}`, `TmdbTv extends TmdbBrief {genres; cast; crew; creators: string[]; seasons: {number; name; episodeCount; posterUrl?; airDate?}[]; trailerYoutubeKey?; similar; status?}`, `TmdbSeason {number; name; overview?; episodes: {number; name; overview?; stillUrl?; airDate?; runtime?}[]}`, `TmdbPerson {id; name; biography?; profileUrl?; birthday?; placeOfBirth?; knownFor: TmdbBrief[]}`. These TS types live in `src/api/types.ts` (W0 writes them). Images via `https://image.tmdb.org/t/p/w500` (poster) and `w1280` (backdrop). Disabled when `settings.tmdb.enabled` is false: every call returns null without network. API key resolution: settings.tmdb.apiKey, else env `TMDB_API_KEY` from `.env` in the data dir or cwd. Caching per C3 tmdb_cache with TTL 7 days (details), 1 day (trending), negative cache 3 days. Match gate: normalized title equality or year match + strsim >= 0.85.

remote (B8): `remote.start: void -> {url}`; `remote.stop: void -> void`; `remote.status: void -> {running: boolean; url?: string; port: number}`; `remote.reportStatus: {status: RemoteStatus} -> void`; `remote.publishChannels: {channels: {id: string; name: string; number?: number; logoUrl?: string}[]} -> void`. `RemoteStatus {sourceName?: string; isLive: boolean; channelName?: string; channelNumber?: number; epgNow?: string; volume?: number; muted?: boolean; canVolume: boolean}` (in types.ts).
HTTP (bound to 127.0.0.1:{settings.remoteControl.port}): `GET /` remote UI (single embedded HTML file, mobile-first, polls status 1/s); `GET /api/remote-control/status -> RemoteStatus & {updatedAt}`; `GET /api/remote-control/channels -> published list`; `POST /api/remote-control/channel/up|down`; `POST /api/remote-control/channel/select {number}`; `POST /api/remote-control/channel/select-id {id}`; `POST /api/remote-control/volume {delta?: number; level?: number; mute?: boolean}`. Every request: reject when Host is not loopback or when Origin is present and not `http://127.0.0.1:{port}` / `http://localhost:{port}` (403). Commands become `remote.command` AppEvents. The `id` in select-id is `${sourceId}|${itemId}`. `init` starts the server when settings.remoteControl.enabled.

player (B9): `player.capabilities: void -> {embeddedMpv: boolean; mpvPath?: string; vlcPath?: string; reason?: string}`; `player.detect: void -> {mpvPath?; vlcPath?}` (search settings paths, vendor/mpv/mpv.exe beside the exe and in cwd, PATH, `C:\Program Files\VideoLAN\VLC\vlc.exe`, scoop/choco locations); `player.openExternal: {player: 'mpv'|'vlc'; source: PlayerSource} -> {pid: number}` (mpv: `--title=<title> --user-agent=<ua> --referrer=<ref> --http-header-fields=Origin:<o> --force-media-title=<title> <url>` plus `settings.mpvArgs` split shell-style; vlc: `--meta-title=<t> --http-user-agent=<ua> --http-referrer=<ref> <url>`; emits player.external on start and exit); `mpv.attach: {bounds: {x; y; width; height}} -> MpvState` (creates child HWND via the `ChildWindowFactory` registered in `AppState.extensions["mpv_window_factory"]` by iptv-tauri at boot; starts `mpv.exe --wid=<hwnd> --input-ipc-server=\\.\pipe\tsrust-iptv-mpv-<pid>-<session> --idle=yes --keep-open=yes --no-osc --no-input-default-bindings --force-window=yes --hwdec=auto-safe`); `mpv.load: {source: PlayerSource} -> void` (loadfile with headers via `http-header-fields`/`user-agent` properties, seeks to resumeSeconds); `mpv.command: {cmd: (string|number|boolean)[]} -> unknown` (raw JSON IPC command); `mpv.setProperty: {name; value} -> void`; `mpv.setBounds: {bounds} -> void`; `mpv.detach: void -> void` (quit mpv, destroy HWND); `mpv.state: void -> MpvState`; property observers for pause, time-pos, duration, volume, mute, track-list, fullscreen push `mpv.state` events (throttled 4/s). On non-Windows, `mpv.*` returns Unsupported.
Child window: B9 declares in `iptv-core/src/player/mod.rs`: `pub struct Bounds { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }` and `pub trait ChildWindowFactory: Send + Sync { fn create(&self, bounds: Bounds) -> CoreResult<isize /*hwnd*/>; fn set_bounds(&self, hwnd: isize, bounds: Bounds) -> CoreResult<()>; fn destroy(&self, hwnd: isize) -> CoreResult<()>; }`. `iptv-tauri/src/mpv_window.rs` (B9) implements it with the `windows` crate: a `WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS` window parented to the main Tauri window's HWND, created on the main thread via `app.run_on_main_thread` and a oneshot channel. Bounds are CSS pixels times the window scale factor (the UI passes CSS px; the factory multiplies by `window.scale_factor()`). `iptv-tauri/src/lib.rs` (W0 -> I) calls `state.set_ext("mpv_window_factory", Arc::new(MpvWindowFactory::new(app_handle)))` after setup; W0 leaves a `// I: register mpv_window_factory` marker.

### C5. Catalog writer and reader API (Rust, `crate::catalog`, owned by B1, consumed by B3, B4, B5, B2)

```rust
pub struct ItemRow { pub source_id: String, pub content_type: ContentType, pub item_id: String, pub category_id: String, pub title: String, pub title_base: Option<String>, pub number: Option<i64>, pub logo_url: Option<String>, pub poster_url: Option<String>, pub backdrop_url: Option<String>, pub rating: Option<f64>, pub added: Option<String>, pub year: Option<i64>, pub epg_channel_id: Option<String>, pub url: Option<String>, pub container_extension: Option<String>, pub is_radio: bool, pub archive_hours: Option<i64>, pub extra: serde_json::Value, pub position: i64 }
impl Default for ItemRow;  // empty strings / None / false / Value::Object(empty)
pub struct CategoryRow { pub category_id: String, pub name: String, pub position: i64 }
pub fn replace_catalog(conn: &mut Connection, source_id: &str, content_type: ContentType, categories: &[CategoryRow], items: &mut dyn Iterator<Item = ItemRow>) -> CoreResult<u64>;
  // one transaction: delete categories+items of (source, content_type), insert categories (preserving `hidden` for category_ids that existed), insert items in batches of 1000 via prepared statement, recompute item_count. Returns item count.
pub fn categories(conn: &Connection, source_id: &str, content_type: ContentType, include_hidden: bool) -> CoreResult<Vec<Category>>;
pub fn query(conn: &Connection, q: &CatalogQuery) -> CoreResult<Page<ItemRow>>;  pub struct CatalogQuery { pub source_id: String, pub content_type: ContentType, pub category_id: Option<String>, pub page: PageQuery, pub include_hidden: bool }
pub fn get(conn: &Connection, r: &ItemRef) -> CoreResult<Option<ItemRow>>;
pub fn search(conn: &Connection, query: &str, source_id: Option<&str>, types: &[ContentType], limit: usize) -> CoreResult<Vec<ItemRow>>;
pub fn title_base(title: &str) -> (String, Option<i64>);  // strips "(2019)", "[4K]", quality tags, leading "EN - " style prefixes; returns base + year
pub fn update_counts(conn: &Connection, source_id: &str) -> CoreResult<()>; // refreshes sources channel/movie/series counts (B1 stores counts in a `source_counts` view or computes on read; sources.list returns them)
impl From<ItemRow> for Channel; impl From<ItemRow> for VodItem; impl From<ItemRow> for SeriesItem;
```

### C6. Import progress

`crate::sources::progress(state: &AppState, source_id: &str, phase: &str, done: u64, total: Option<u64>, message: Option<&str>)` (B1) emits `import.progress`. Importers must call it at least every 2000 items. `sources.add` and `sources.refresh` run the importer and await it; the RPC returns when done (UI shows progress from events).

### C7. UI routes (`src/routes.tsx`, react-router data router; I wires feature route objects exported by each slice)

Each feature exports `export const <name>Routes: RouteObject[]` from `src/features/<name>/routes.tsx` (U1 exports `shellRoutes` for dashboard from `src/shell/routes.tsx`). The shell layout route (`/`) renders the rail, header, context panel, outlet, player dock, and external playback footer. W0 writes `routes.tsx` with the layout route and a placeholder index; I replaces the children with the feature route arrays.

```
/                                  -> redirect per settings (dashboard | /sources | lastRoute)
/dashboard                                                   U1
/sources                                                     U2
/settings  -> /settings/general ; /settings/:section (general | playback | players | epg | metadata | appearance | remote | backup | shortcuts | about)   U2
/favorites   (global)    /recent  (global)   /downloads   /my-videos   /my-videos/:id     U6
/search?q=                                                   U4
/epg?source=<id>  (multi-channel grid)                       U3
/s/:sourceId/live            /s/:sourceId/live/:categoryId     /s/:sourceId/radio           U3  (works for every source kind)
/s/:sourceId/favorites       /s/:sourceId/recent               U6
/s/:sourceId/movies          /s/:sourceId/movies/c/:categoryId  /s/:sourceId/movie/:itemId     U4
/s/:sourceId/series          /s/:sourceId/series/c/:categoryId  /s/:sourceId/series/:itemId    U4
/s/:sourceId/actor/:personId                                     U4
/s/:sourceId/search?q=                                           U4
```
For every source kind `/s/:id` redirects to `/s/:id/live`. Rail links per source come from `src/shell/railLinks.ts` (U1) using `source.kind` to decide which of live/radio/movies/series/favorites/recent appear (m3u: live, radio when any, favorites, recent, movies when movieCount > 0; xtream/stalker: all).

### C8. Player store (`src/features/player/store.ts`, U5; every other UI slice consumes it)

```ts
export type PlayerMode = 'inline' | 'embedded-mpv' | 'external' | 'radio';
export interface PlayerState { source?: PlayerSource; mode: PlayerMode; status: 'idle'|'loading'|'playing'|'paused'|'error'; error?: string; isFullscreen: boolean; dock: 'stage'|'mini'|'hidden'; volume: number; muted: boolean; positionSeconds: number; durationSeconds?: number; queue: PlayerSource[]; }
export interface PlayerActions { play(source: PlayerSource, opts?: { queue?: PlayerSource[]; mode?: PlayerMode }): Promise<void>; stop(): void; togglePlay(): void; seekBy(seconds: number): void; seekTo(seconds: number): void; setVolume(v: number): void; adjustVolume(delta: number): void; toggleMute(): void; toggleFullscreen(): void; setDock(d: PlayerState['dock']): void; next(): void; prev(): void; }
export const usePlayerStore: UseBoundStore<StoreApi<PlayerState & PlayerActions>>;
export function playItem(args: { ref: ItemRef; episodeId?: string; title: string; subtitle?: string; posterUrl?: string; isLive: boolean; isRadio?: boolean; sourceKind: SourceKind }): Promise<void>; // resolves PlayerSource via xtream.streamUrl / stalker.streamUrl / catalog.item(url) per source kind, applies settings.player (external -> player.openExternal; embedded-mpv -> mpv.*; else inline), records recent.add and positions on progress (every 5 s and on stop)
export function playSource(source: PlayerSource): Promise<void>; // same but with a prebuilt source (catch-up, my videos)
export function useChannelZap(): { up(): void; down(): void; selectNumber(n: number): void };  // uses catalog.neighbors and catalog.channelByNumber for the current live source; the live view registers the current list context via usePlayerStore.setState({ zapContext: { sourceId, categoryId } }) (zapContext is part of PlayerState: `zapContext?: { sourceId: string; categoryId?: string }`)
```
`<PlayerDock />` (U5) is rendered once by the shell layout (U1 imports it from `@/features/player`). `<InlinePlayer />` renders hls.js for kind 'hls', shaka for 'dash', `<video>` for direct/file, with unified controls. The live view (U3) renders `<PlayerStage />` (U5 export) inside its layout; while a `<PlayerStage />` is mounted the dock renders the video there (portal) and `dock` is 'stage'; when it unmounts the dock falls back to 'mini' (bottom-right floating) until stopped. Resume: the store persists `{source, positionSeconds}` to `sessionStorage['player.resume']` every 5 s; on boot, the shell calls `restorePlayback()` (U5 export) which replays it.

### C9. i18n

`src/i18n/index.ts` (U1) initializes i18next with `resources` loaded via `import.meta.glob('./*/*.json', { eager: true })`, namespaces: `common, shell, sources, settings, live, vod, player, library`. `common` is U1's. Keys are flat camelCase strings (`"addSource": "Add source"`), no nesting, no dots. Interpolation `{{count}}`. Language list (19): ar, ary (Moroccan Arabic), by (Belarusian), de, el, en, es, fr, hu, it, ja, ko, nl, pl, pt, ru, tr, zh, zhtw. Settings language value is the folder name. Translators (T1..T3) produce every non-en folder from the en namespace files after wave 1. Use `useTranslation('live')` per feature.

### C10. Design tokens (`src/styles/tokens.css`, U1)

CSS custom properties on `:root[data-theme="dark"]` and `:root[data-theme="light"]`: `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-surface-3`, `--color-border`, `--color-fg`, `--color-fg-muted`, `--color-fg-subtle`, `--color-accent`, `--color-accent-hover`, `--color-accent-fg`, `--color-danger`, `--color-success`, `--color-warning`, `--color-live` (live badge), `--radius-sm`, `--radius`, `--radius-lg`, `--shadow-1`, `--shadow-2`, `--font-sans`, `--font-mono`, `--rail-width`, `--header-height`, `--panel-width`. Tailwind 4 `@theme` maps them so slices use `bg-surface`, `bg-surface-2`, `text-fg`, `text-fg-muted`, `border-border`, `bg-accent`, `text-accent-fg`, `rounded-lg` etc. `html` carries `data-theme` (U1 theme provider) and `data-reduced-motion="true"` when the media query matches; all transitions use `motion-safe:`.

### C11. UI primitives (`src/ui/index.ts`, U1)

`Button {variant: 'primary'|'secondary'|'ghost'|'danger'; size: 'sm'|'md'|'lg'; icon?; loading?}`, `IconButton {label (aria); icon}`, `Input`, `Textarea`, `Select {options: {value,label}[]}`, `Toggle {checked; onChange; label}`, `Dialog {open; onClose; title; children; footer?; size?}`, `Tabs {items: {id,label}[]; value; onChange}`, `Skeleton {className}`, `SkeletonList {rows}`, `SkeletonGrid {count}`, `EmptyState {icon; title; description?; action?: ReactNode}`, `ErrorState {error: unknown; onRetry?: () => void}` (renders RpcError message and a next-step hint by code), `VirtualList<T> {items; itemHeight; render; onEndReached?; selectedIndex?; overscan?; className?}`, `VirtualGrid<T> {items; minColumnWidth; aspect; render; onEndReached?}`, `Toast` via `useToast(): {toast(opts: {title; description?; variant?: 'info'|'success'|'error'; action?: {label; onClick}}) }`, `Kbd`, `Badge`, `ProgressBar {value; max?}`, `Poster {src?; alt; aspect: 'poster'|'wide'|'square'}` (lazy, blurred placeholder, fallback glyph), `SearchInput`, `Pagination {offset; limit; total; onChange}`, `Menu {items}`, `Tooltip`.

### C12. Server binary (B10)

`iptv-server --port 7180 --data-dir <dir> --static <dist path>` (defaults: port from `PORT` env or 7180, data dir `./data`, static `./dist`). Routes: `POST /api/rpc/{cmd}`, `GET /api/events` (WS, broadcast of AppEvent), `GET /api/proxy?url=<enc>&sourceId=<id>` (streams the upstream response; injects source headers; for `.m3u8` responses rewrites absolute and relative segment/playlist URIs to `/api/proxy?url=...&sourceId=...`; no buffering of whole body), `GET /api/files/{downloadId}` (Range-capable file serving of completed downloads), `GET /api/health -> {ok, version}`, static SPA fallback for everything else. CORS: same-origin only.

### C13. Mock servers (B11, `iptv-mock`)

`iptv-mock --port 7290` serves:
- Xtream at `/xtream/player_api.php` (user `demo`, pass `secret`; others -> `{"user_info":{"auth":0}}`): 3 live categories / 40 live channels (ids 101..140, with `tv_archive=1` on 101..105, `epg_channel_id` "bbc1.uk" etc.), 2 vod categories / 30 movies (ids 201..230, with cover, rating, added, container_extension "mp4"), 2 series categories / 10 series (ids 301..310) each with 2 seasons x 3 episodes (episode ids 3001..), `get_vod_info`, `get_series_info`, `get_short_epg` (4 programs around now), `/xtream/xmltv.php` (XMLTV for the 40 channels, 3 days), stream endpoints `/xtream/live/demo/secret/{id}.m3u8` (valid HLS playlist with 3 x 2 s segments at `/xtream/seg/{n}.ts`, segments served from `fixtures/seg.ts`, a valid MPEG-TS clip), `/xtream/live/demo/secret/{id}.ts`, `/xtream/movie/demo/secret/{id}.mp4` (serves `fixtures/sample.mp4`, Range-capable), `/xtream/series/demo/secret/{id}.mp4`, `/xtream/timeshift/demo/secret/{dur}/{start}/{id}.ts`.
- Stalker at `/stalker/portal.php` (mac `00:1A:79:00:00:01` only; token `mock-token-1`): handshake, get_profile, itv get_genres/get_all_channels (30 channels), radio get_ordered_list, vod get_categories/get_ordered_list (paged 14), series get_categories/get_ordered_list, create_link (returns `ffmpeg http://127.0.0.1:{port}/xtream/live/demo/secret/101.m3u8` style), tv_archive create_link, get_short_epg. Requests without a valid Bearer after handshake get `Authorization failed`.
- M3U at `/m3u/sample.m3u` (`fixtures/sample.m3u`: 25 channels, 4 groups, `url-tvg` header pointing at `/xmltv/sample.xml`, one `radio="true"`, logos) and `/m3u/large.m3u?channels=50000` (generated on the fly, streamed).
- XMLTV at `/xmltv/sample.xml` and `/xmltv/large.xml?mb=120` (streamed generator) and `/xmltv/sample.xml.gz`.
- Files: `/files/video.bin` (20 MB deterministic bytes, Range + ETag), `/files/flaky.bin` (same but the first request drops after 5 MB; second succeeds), `/files/nolen.bin` (no Content-Length, no Range).
- `GET /health`. All responses include `Access-Control-Allow-Origin: *`.
`fixtures/sample.mp4` and `fixtures/seg.ts` are generated by B11 (a few seconds of a solid-color clip; B11 may generate them with ffmpeg if present on PATH, else commit a minimal valid file produced by the Rust generator).

### C14. Fixtures lib (`iptv-fixtures`, B11)

`pub fn m3u_text(channels: usize, groups: usize) -> String`; `pub fn write_m3u(path: &Path, channels: usize, groups: usize) -> io::Result<()>` (streamed); `pub fn write_xmltv(path: &Path, megabytes: usize) -> io::Result<()>` (streamed; ~400 channels, programs sized to hit the target); `pub fn backup_manifest_v1() -> String` (one m3u, one xtream, one stalker entry with favorites, recent, hidden, positions; portal urls use the `{mock}` placeholder replaced by callers); `pub fn sample_m3u() -> &'static str` (= fixtures/sample.m3u); `pub fn sample_xmltv() -> &'static str`; `pub async fn spawn_mock() -> MockHandle { pub port: u16, pub base: String }` (starts the mock router in-process on a free port for Rust tests; `impl Drop` shuts down). The mock router lives in `iptv-mock` as `pub fn router() -> axum::Router` (lib + bin targets) and `iptv-fixtures` depends on it.

### C15. Backup manifest v1 (B2)

Exactly the old app's `PlaylistBackupManifestV1` (old repo `libs/shared/interfaces/src/lib/playlist-backup.interface.ts`): `{kind: "iptvnator-playlist-backup", version: 1, exportedAt, includeSecrets, settings?: {epgUrls}, playlists: Entry[]}` with m3u entries `{portalType:'m3u', exportedId, title, autoRefresh, position?, source: {kind:'url'|'file'|'text', rawM3u, url?, userAgent?, referrer?, origin?, filePathHint?}, userState: {favorites: string[] /*channel urls*/, recentlyViewed: {url?, name?, ...}[], hiddenGroupTitles: string[]}}`, xtream `{portalType:'xtream', connection: {serverUrl, username, password?}, userState: {hiddenCategories: {categoryType:'live'|'movies'|'series', xtreamId}[], favorites: {contentType:'live'|'movie'|'series', xtreamId, addedAt?, position?}[], recentlyViewed: {contentType, xtreamId, viewedAt}[], playbackPositions: {contentXtreamId, contentType:'vod'|'episode', seriesXtreamId?, seasonNumber?, episodeNumber?, positionSeconds, durationSeconds?, updatedAt?}[], sourcePins?: {matchKey, contentId, updatedAt?}[]}}`, stalker `{portalType:'stalker', connection: {portalUrl, macAddress, isFullStalkerPortal?, username?, password?, userAgent?, referrer?, origin?, stalkerSerialNumber?, stalkerDeviceId1?, stalkerDeviceId2?, stalkerSignature1?, stalkerSignature2?}, userState: {favorites: StalkerPortalItem[], recentlyViewed: StalkerPortalItem[]}}` where StalkerPortalItem has at least `{id, name, type: 'itv'|'vod'|'series'|'radio', logo?, cmd?, added?}`. Import: m3u entries import from rawM3u text; favorites matched by channel url; hidden groups by name; xtream/stalker entries create sources and run sync (skipping sync with a warning when the portal is unreachable), then apply user state by provider id (missing items become warnings, not errors). Export produces the same shape so the old app can read it. Unknown fields are ignored; unknown `version` is rejected with Invalid.

### C16. Shell hooks (`src/shell/index.ts`, U1)

`useShell(): { setHeader(h: { title: string; subtitle?: string; actions?: ReactNode; search?: { value; onChange; placeholder } }): void; setContextPanel(node: ReactNode | null): void; }` (call inside a `useEffect`, cleanup resets); `registerCommands(cmds: Command[]): () => void` with `Command { id; title; group: string; shortcut?: string; keywords?: string[]; run(): void }`; `useShortcut(combo: string, handler: (e: KeyboardEvent) => void, opts: { description: string; area: string; enabled?: boolean; allowInInput?: boolean }): void` (combo syntax `mod+k`, `shift+/`, `arrowleft`, `space`, `digit`); `shortcutRegistry.list(): {combo; description; area}[]` powers the `?` overlay; every `useShortcut` call is listed automatically. Required shortcuts (from the old README): mod+k palette, mod+f global search, mod+r recent, mod+b toggle live sidebar, 0-9 channel number entry, space/k play-pause, f fullscreen, arrowleft/right seek 5 s, arrowup/down volume 5 %, m mute, ? overlay, escape close. The shell owns the global ones (palette, search, recent, overlay, escape); U5 owns playback ones; U3 owns sidebar toggle and digit entry.

### Amendments after fix waves

These additions were made by the fix waves after review rounds 1 and 2. They extend C1, C2, C4 and C12 above; where they differ, they win. `src/api/rpc.ts` (`RpcMap`, `RPC_COMMANDS`) and `src/api/types.ts` are the code form, and the router parity test in `crates/iptv-core/src/rpc/mod.rs` keeps the Rust registrations equal to `RPC_COMMANDS`.

C2 model additions (Rust `model.rs` mirrors each one; every new Settings field is `#[serde(default)]`):

```ts
export interface Source { /* ...C2 */ radioCount: number; }  // channelCount counts live channels only
export interface CatchupInfo { type: 'default' | 'append' | 'shift' | 'xc' | 'flussonic' | (string & {}); days?: number; source?: string; } // type lowercased
export interface Channel { /* ...C2 */ headers?: RequestHeaders; catchup?: CatchupInfo; } // per-channel #EXTVLCOPT / `url|Header=` headers, merged over the source headers
export interface VodDetail { /* ...C2 */ providerDetailsUnavailable: boolean; providerError?: string; } // same two fields on SeriesDetail
export interface PlaybackPosition { /* ...C2 */ watched: boolean; } // default false
export interface Settings {
  /* ...C2 */
  stripCountryPrefix: boolean;   // default false; strip a leading `XX: ` / `XX | ` / `[XX] ` tag when rendering channel names
  epgOffsetMinutes: number;      // default 0 (i32, -720..720); shifts displayed programme times
  playerReuseInstance: boolean;  // default true; close the previous external player before launching the next (VLC also gets --one-instance --playlist-enqueue)
  showExternalBar: boolean;      // default true; show the external-playback footer
  vodMinRating: number;          // default 0 (f64, 0..10); VOD grids hide items rated below it
  englishOnly: boolean;          // default false; catalog readers drop items whose title or category clearly marks another language
  recordingsDir: string | null;  // default null = `<downloadsDir>/recordings`; desktop only
}
export interface AppInfo {
  /* ...C2 */
  proxyBase: string | null;      // desktop: loopback media proxy base `http://127.0.0.1:<port>/api/proxy`; null in server mode
  updaterAvailable: boolean;     // true only in a desktop build compiled with the `updater` feature
}
export interface MpvState { /* ...C2 */ recording: boolean; recordPath: string | null; }
```

C4 command additions:

- app: `app.pendingDeepLinks: void -> string[]` (returns and clears `iptv://` links the Tauri shell queued before the UI listened; later links arrive as the `deeplink.open {urls}` event).
- sources: `sources.removeAll: void -> null` (removes every source through the `sources.remove` path; emits `sources.changed`).
- userstate: `userstate.setWatched: {ref; episodeId?; watched: boolean} -> void` (`watched: true` writes the position row with `watched: true` and position = duration when known; `false` clears the row). `positions.continueWatching` excludes watched rows.
- epg: `epg.clearAll: void -> void` (deletes every programme and guide channel and resets each EPG url's status; urls, enabled flags and manual mappings are kept; emits `epg.changed`).
- player: `player.stopExternal: void -> {stopped: boolean}` (ends the external mpv/VLC this app launched last; players started outside the app are never touched); `mpv.record: {start: boolean} -> {recording: boolean; path: string | null}` (start writes the live stream through mpv's `stream-record` property to `<recordingsDir>/<title>-<yyyyMMdd-HHmm>.ts`; stop clears it; Windows desktop only).

C4 argument changes: `mpv.attach: {bounds; volume?: number (0..100); muted?: boolean} -> MpvState` (applied before the first state event); `catalog.channelByNumber: {sourceId; number; contentType?: 'live' | 'radio'} -> Channel | null` (default: live first).

C12 proxy: `/api/proxy` also accepts `ua`, `referer` and `origin` query parameters that override the source-level headers. The desktop app serves the same route on a loopback listener inside the Tauri process (`crates/iptv-tauri/src/proxy.rs`, `allow_private_targets` on, Host and Origin guards) and reports it as `app.info.proxyBase`; see `docs/architecture/desktop.md`.

- catalog (U4-fix5): `catalog.movies` / `catalog.series` args gain `minRating?: number` (`{sourceId; categoryId?; query: PageQuery; minRating?}`). When > 0 the core keeps only items with `rating >= minRating` (unrated items drop out) and `total` counts the filtered set, so VOD grids apply `settings.vodMinRating` with normal paging. Stalker VOD (`stalker.movies`/`stalker.series`) has no rating filter; its grids filter loaded pages.
- catalog (English only): with `settings.englishOnly` on, `catalog.channels/movies/series`, `catalog.categories`, `catalog.search`, `catalog.neighbors`, `catalog.recentlyAdded` and `catalog.allLiveChannels` drop items whose title prefix or category clearly marks a language other than English (see `docs/architecture/settings.md`); `total` and `itemCount` count what remains. `catalog.channelByNumber` and `catalog.sameTitle` are unfiltered. The UI refetches `catalog.*` when the setting flips; Stalker VOD grids filter loaded pages.
- proxy (S-fix2): the desktop `app.info.proxyBase` carries a random per-launch token as its first path segment (`http://127.0.0.1:<port>/<token>/api/proxy`). The loopback proxy answers 403 to any request without it and prefixes the token onto the root-relative `/api/proxy?` URIs in rewritten HLS playlists. Clients use `proxyBase` verbatim (`${proxyBase}?url=...`) and never build a proxy path themselves.
- epg (U3-fix5): `epg.nowNext` args gain `offsetMinutes?: number` (`{refs; offsetMinutes?}`, -720..720, default 0; outside that range is `invalid`). The core picks "now"/"next" at `now - offsetMinutes` and returns programme times unshifted; callers pass `settings.epgOffsetMinutes` and shift the times for display, so every view agrees with the ribbon on what is airing.
- player (M-docs3): `mpv.command` is an allowlist, not a raw IPC passthrough: it accepts only `seek`, `get_property`, `get_property_string` and the property commands `set`/`set_property`/`set_property_string`/`add`/`multiply`/`cycle`/`cycle-values` aimed at `SETTABLE_PROPERTIES`; any other first element (including mpv prefixes such as `no-osd`/`async`/`raw`, and `keybind`/`keypress`/`run`/`script-*`) is `invalid`.
- sources (B-robust3): `sources.remove`, and `sources.update` when it changes the m3u/Xtream/Stalker settings, cancel the source's running import instead of waiting for it, and so does `sources.cancelImport` (C8). Every importer checks the token: m3u downloads stop at once, Xtream checks between content types and saves all types in one transaction, Stalker checks before saving and also saves in one transaction, and the catalog writers check it before committing. A cancelled run rolls back, keeps the previous catalog, emits `import.progress` with `phase: 'cancelled'` and records no `lastError`. The cancelled call (`sources.add` / `sources.refresh`) fails with `conflict` and `details: {sourceId, cancelled: true}`; the message is "the import stopped because the source was removed or its settings changed. Refresh the source to import it again." after a remove or settings change, and "import stopped: cancelled by user. ..." after `sources.cancelImport`. A playlist body under 1 KB/s over 60 s fails with `timeout`.
- guide (features 2026-10): `epg.shortEpg: {ref; limit?} -> EpgProgram[]` (Xtream `get_short_epg` for channels without XMLTV programmes airing; programmes not yet ended, default 4, max 10; empty when `settings.epgShortFallback` is off or the source is not Xtream; cached per channel 20 min, deduplicated, at most 3 panel calls at once) and `catchup.programs: {ref; from; to} -> EpgProgram[]` (Xtream `get_simple_data_table` programmes overlapping `[from, to)`; empty for other kinds). Model: `EpgProgram.fromProvider?: boolean` (set by the UI on fallback programmes), `Settings.epgShortFallback: boolean` (default true), `M3uSourceConfig.catchup?: CatchupOverride` with `CatchupOverride { type: 'default' | 'append' | 'shift' | 'flussonic' | 'xc' | 'none'; template?: string; days?: number }` (validated by `sources.add`/`sources.update`, applied to channel rows at read time, kept in backups). UI route `/live/archive/:sourceId/:channelId` (U3, lazy): the catch-up archive browser. See docs/architecture/epg.md, xtream.md and m3u.md.
- sources UI (U-craft3): the Sources page localizes `Source.lastError` by matching the core's English wording (`src/features/sources/lib/sourceError.ts`: "Could not reach <host>", "<host> did not respond in time", "answered the playlist download: HTTP <status>", the credential-rejection lines, and OS refused/DNS causes) and shows the raw text in a "Technical details" disclosure; unmatched text is shown as is. Rewording those core messages needs the matching pattern updated, or the card falls back to the raw text.
- player (player slice): `mpv.stats: void -> MpvStats` (desktop only; `unsupported` in server mode) reads the stream info snapshot from mpv: `videoCodec`, `width`, `height`, `fps`, `videoBitrate`, `audioCodec`, `audioChannels`, `audioBitrate`, `hwdec` + `hwdecKnown`, `droppedFrames`, `cacheSeconds`, `container`; every field but `hwdecKnown` is optional and absent when mpv has no value. Player features: audio and subtitle delay (Sync menu, G/H and Shift+G/Shift+H, reset per stream; audio delay is mpv only, built-in engines shift text-track cues), a stream info panel (I), previous channel (B), a channel history popover (Shift+B, last 10 live channels), J/L 10 s seek, and previous episode (Shift+P and a series page button). No settings fields or migrations.
- remote (LAN mode): Settings gains `remoteLanEnabled: boolean` (default false; not in backups). In the desktop app, when it is on, the remote control also listens on each private IPv4 address (RFC 1918 and link-local, one listener per address, never `0.0.0.0`); server mode ignores it. Non-loopback peers must use a bound LAN IP literal as `Host` (and `Origin`, when sent) and carry a `tsr_remote` session cookie (HttpOnly, SameSite=Strict) obtained with `POST /api/remote-control/pair {code}`; loopback is unchanged. Pairing codes are one-time, live 5 minutes, and are rate limited (5 failures per peer per 60 s; past 200 failures in total, peers that already failed are refused while peers with no failures still get their code checked). The cookie is scoped to `Path=/api/remote-control`. Sessions are stored as SHA-256 hashes in `app_state` (`remote_paired_devices`). `remote.status` gains `lanAddresses?: {ip; interface; url}[]` and `lanError?: string`. New RPCs (desktop only, `unsupported` in server mode): `remote.pairingCode: {address?: string} -> {url; address; expiresAt; expiresInSecs; qr: {size; path}}`; `remote.devices: void -> {id; name: {browser; os?}; pairedAt; lastSeen}[]`; `remote.revokeDevice: {id} -> void`; `remote.resetPairing: void -> void`. See `docs/architecture/remote-control.md`.
- account (features 2026-10, account slice): subscription status and scheduled refresh. See `docs/architecture/account.md` and `sources.md`.
  - C2: `Source.lastErrorAt?: string` (RFC 3339, set with `lastError`; migration 0009). `Settings.sourceRefreshIntervalHours: number` (default 12, 0..168, 0 = only at startup) and `Settings.accountExpiryWarnDays: number` (default 7, 0..60, 0 = off); both in the backup manifest's `settings`.
  - C4: `account.status: {sourceId; refresh?: boolean} -> AccountStatus | null` (null for M3U; `refresh` asks the provider, at most once per 20 s per source); `account.statusAll: void -> AccountStatus[]`; `sources.schedule: void -> {intervalHours; sources: {sourceId; nextRefreshAt; retrying}[]}`. `AccountStatus = {sourceId; kind; status?; expDate?; isTrial; activeCons?; maxConnections?; checkedAt; error?}`.
  - C1 event: `account.changed {sourceId}` when a cached status changes.
  - C13: the mock Xtream panel adds the users `expiring`, `expired` and `full` (password `secret`); `full` streams answer 403 "Max connections reached".
  - Features: source cards show expiry, trial and connection badges, "Next refresh in ...", and "Failed ... ago"; the dashboard lists expiring and expired subscriptions (dismissible per expiry date); a playback failure on a full account reads "Connection limit reached (2 of 2 in use)".
- recording (recording slice): migration `0010_recordings.sql` adds the `reminders` and `recordings` tables. Settings gain `recordingPaddingBeforeMinutes` (default 1, 0..60), `recordingPaddingAfterMinutes` (5, 0..120), `remindersEnabled` (true), `reminderLeadMinutes` (2, 0..60) and `reminderAction: 'notify' | 'switch'` ('notify'). New commands: `reminders.list|add|remove` and `recordings.capabilities|list|schedule|cancel|remove|library|playSource|reveal|delete`; events `reminders.update`, `reminders.fire {reminder, action}`, `recordings.update`, `recordings.progress {id, bytes, elapsedSeconds}`. Programme times on these commands are display time (EPG offset applied). The server adds `GET /api/recordings/{id}`; the desktop shell adds the `native_notify {title, body}` Tauri command (`tauri-plugin-notification`). New route `/scheduled` (Library). See `docs/architecture/recording.md`.
- round two, run 1 (look and paid features): appearance, parental controls, My List, multi-view, sleep timer and zap banner.
  - C2 Settings: `accent: 'amber' | 'teal' | 'violet' | 'rose' | 'lime' | 'sky' | 'coral'` (default `amber`), `oledBlack` (false), `density: 'comfortable' | 'compact'` (`comfortable`), `uiScale` (1, 0.9..1.25, rounded to 4 decimals), `zapBanner` (true), and `dashboardRails.myList` (true). All five top-level fields are in the backup manifest's `settings`. See `docs/architecture/appearance.md`.
  - parental (`docs/architecture/parental.md`): migration `0011_parental.sql` (`parental_config`, `parental_locks`); commands `parental.status|setPin|disable|configure|unlock|lockNow|locks|setLocked|check|adultCategories`; event `parental.changed {ParentalStatus}`. Hide mode filters every catalog and user-state reader, and the provider detail commands (`xtream.vodDetail|seriesDetail`, `stalker.vodDetail|seriesDetail`) refuse a hidden title with `not_found` as `catalog.item` does; `sources.remove` and `sources.removeAll` (when the sources have locks) and backup `replace` need an active unlock while a PIN is set. Backups carry locks (`userState.tsrustParentalLocks`) and options (`settings.tsrustParental`), never PIN material.
  - watchlist (`docs/architecture/watchlist.md`): migration `0012_watchlist.sql`; commands `watchlist.list|toggle|contains|remove|reorder`; event `watchlist.changed {}`; backups carry `userState.tsrustWatchlist`.
  - C7 routes: `/my-list` (My List), `/multiview` (the wall; frontend only, state in localStorage `tsrust.multiview`, see `docs/architecture/multiview.md`), and the settings sections `recording` and `parental` (`/settings/:section` is now general | playback | players | epg | recording | metadata | appearance | parental | remote | backup | shortcuts | about).
  - C8 player: sleep timer and zap banner (`docs/architecture/players.md`, "Sleep timer, zap banner and glass"); every playback start passes the parental gate (`ensurePlaybackAllowed`).
  - C10 tokens: accent blocks per `data-accent`, the OLED block on `data-oled`, density and scale on `data-density` and `--ui-scale`, and the glass tokens (`--color-glass*`, `--color-on-glass*`, `--blur-glass`).
- round two, run 2 (organise and find): channel edits, custom lists, VOD filters, guide search and series recording, subtitles, and watch stats.
  - C3 schema: migrations `0013_catalog_edits.sql` (`channel_edits`; an `items` year index), `0014_custom_lists.sql` (`custom_lists`, `custom_list_items`), `0015_guide.sql` (the `epg_programs_fts` FTS5 index, `recording_rules`, `recording_rule_skips`) and `0016_watch_log.sql` (`watch_log`).
  - C2 Settings: `subtitleSize: 'small' | 'medium' | 'large' | 'xlarge'` (`medium`), `subtitleColor: 'white' | 'yellow' | 'cyan' | 'green'` (`white`), `subtitleBackground: 'shadow' | 'box' | 'solid'` (`box`), `subtitlePosition` (0, a whole number 0..40) and `vodHideWatched` (false). All five are in the backup manifest's `settings`. See `docs/architecture/settings.md`.
  - channel edits (`docs/architecture/channel-edits.md`): `channels.edits|setHidden|rename|reset`; every write emits `channels.changed {sourceId}`. Channel readers leave hidden channels out and show renamed ones under their new name (which readers, in the doc).
  - custom lists (`docs/architecture/lists.md`): `lists.list|create|update|remove|reorder|items|addItems|removeItems|reorderItems|containing|neighbors`; every write emits `lists.changed {}`. `lists.items` leaves out hidden and parentally hidden channels; `lists.reorderItems` takes any subset of the list's refs (unlisted refs keep their slots).
  - VOD browsing (`docs/architecture/vod-browsing.md`): `catalog.movies` / `catalog.series` args gain `yearFrom?`, `yearTo?` and `hideWatched?`; new `catalog.yearFacets` (its `hideWatched?` counts only what Hide watched keeps) and `positions.watchedContains`.
  - guide search and series recording (`guide-search.md`, `recording.md`): `epg.search {sourceId; query; from?; to?; limit?}` and `recordings.rules|addRule|setRuleEnabled|removeRule`; rule changes emit `recordings.update`.
  - subtitles (`subtitles.md`): `mpv.addSubtitle {path}` (desktop only) loads an external subtitle file into embedded mpv; the built-in player parses SRT, VTT and ASS in the UI.
  - watch stats (`stats.md`): `stats.record|summary|clear`, no event; Hide mode leaves locked items out of `stats.summary`.
  - C1 invalidation (`src/api/query.ts`): `lists.changed` refreshes `lists.`; `channels.changed` refreshes `catalog.`, `channels.`, `lists.`, `favorites.`, `recent.` and `epg.search`; `sources.changed` and `import.progress` also refresh `lists.`. `parental.changed` refreshes `lists.`, `epg.search` and `stats.` along with the Run 1 prefixes when Hide mode's filter changes (`src/features/parental/status.ts`).
  - C7 routes: `/lists` (all lists), `/lists/:listId` (one list) and `/stats` (watch stats), all lazy.
  - C9 i18n: new namespaces `lists`, `channels`, `guide` and `stats`, in all 19 languages.
  - Backups (`backup.md`): per playlist `tsrustChannelEdits`, `tsrustRecordingRules` and `tsrustWatchLog`; custom lists at the top level as `tsrustCustomLists`.
- round two, run 3 (speed and first run): image cache, query and bundle performance, cheaper blur, screenshots, and the first-run tour with What's new.
  - C2 Settings: `imageCacheMaxMb` (500, a whole number 50..5000; applies in server mode too, to the server's cache), `tourCompleted` (false) and `lastSeenVersion` (`''`, or 1..32 characters of `[0-9A-Za-z.+-]`); anything else is `invalid`. All three are machine-local: they are not in `APP_SETTING_KEYS`, so backups leave them out. `settings.reset` keeps `tourCompleted` and `lastSeenVersion` (a reset neither replays the tour nor shows What's new for an unchanged version) and resets `imageCacheMaxMb`. See `docs/architecture/settings.md`.
  - image cache (`docs/architecture/image-cache.md`): migration `0017_image_cache.sql` (`image_cache` index; files under `<data dir>/image-cache/<2 hex>/<sha256>`), LRU eviction to 90 % of the cap, one fetch per URL at a time, failures remembered for 10 min. Commands `images.stats: void -> ImageCacheStats` (also evicts down to the cap) and `images.clear: void -> ImageCacheStats`, with `ImageCacheStats = {bytes; files; maxBytes}`; no events (the UI refetches `images.stats` itself). HTTP `GET <base>/img?url=<absolute http(s) url>&sourceId=<id?>`: `/api/img` in server mode (before the SPA catch-all) and `/<token>/api/img` on the desktop loopback proxy. 200 carries the stored image type, `Cache-Control: private, max-age=604800`, `X-Image-Cache: hit|miss` and the `harden()` headers (CSP `sandbox; default-src 'none'`, `nosniff`; SVG is accepted); 400 bad URL, 403 guard refusal, 404 upstream 404, 415 not an image, 502 other upstream failures.
  - image URLs in the UI: `imageUrl(src, sourceId?)` in `src/api/images.ts` turns http(s) URLs into the cache route (data:, blob:, asset: and relative URLs unchanged). `Poster` takes `sourceId` and `priority`; `Poster` and `ChannelLogo` retry the original URL once after a cache-route error, then show initials. Settings > General has the image cache row (size against the cap, Clear, a 250 MB to 5 GB cap select).
  - C1 query cache (`docs/architecture/performance.md`): defaults are staleTime 30 s and gcTime 10 min, with per-prefix times from `queryDefaultsFor(cmd)` (settings and app info never stale; sources and categories 5 min; channel and VOD pages 2 min; guide windows 5 min with gcTime 2 min; `tmdb.` never stale with gcTime 30 min; `positions.` and `stats.` 15 s). Event invalidation is unchanged; writes that send no event (`recent.add`, `positions.set`) invalidate their own prefix in the player store. VOD posters prefetch their detail after the pointer rests 120 ms (`usePrefetchIntent`).
  - entry budget: `pnpm size:check` (`tools/check-bundle.mjs`, after `pnpm build`) lists every chunk and fails when `dist/assets/index-*.js` is over 268,000 bytes. New features stay out of the entry chunk through lazy imports.
  - C10 blur: `backdrop-filter` only through the `.glass-blur` utility (`--blur-glass` at most 10 px; `prefers-reduced-transparency: reduce` swaps it for a solid glass colour), never on always-visible chrome (the header is opaque, multi-view tile labels are solid). `Poster` fades in by opacity only. `src/perf-budget.test.ts` enforces this with an empty allowlist.
  - screenshots (`docs/architecture/screenshot.md`; desktop only, `unsupported` in server mode): `screenshot.save {dataBase64; format: 'png' | 'jpeg'; title?} -> {path; fileName}`, `screenshot.mpv {title?; withSubtitles?} -> {path; fileName}` (needs an attached embedded mpv, else `conflict`), `screenshot.open {path}` and `screenshot.reveal {path?}`. Files go to `<Pictures>/Tsrust IPTV` (or `<data dir>/screenshots`) as `<title> <YYYY-MM-DD HH-MM-SS>.png`; server mode downloads the PNG in the browser. Entry points: the camera button, the mpv context menu and `s` in the Playback area (a focused Live list row, the multi-view wall and a focused VOD grid keep their own `s`).
  - onboarding (`docs/architecture/onboarding.md`): new i18n namespace `onboarding`. `OnboardingHost` (lazy in the shell) decides at startup: a fresh profile stores `lastSeenVersion` silently and starts the 3-step tour once a source exists; an upgrade from a build without onboarding marks the tour done and shows What's new for the running version; a changed version shows What's new for newer releases. The tour anchors on `[data-tour="live" | "vod" | "search"]` (rail and header, see ui-shell.md). The command palette ("Take the tour", "What's new") and Settings > About open them by hand. The app version is not bumped.

## 5. Run commands and ports

```
pnpm install                                   # node deps
cargo build --workspace                        # all crates
pnpm typecheck                                 # tsc-rs --noEmit -p tsconfig.json
pnpm build                                     # vite build -> dist/
pnpm size:check                                # after pnpm build: entry chunk <= 268,000 bytes
pnpm test                                      # vitest run
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm dev                                       # vite on 5173 (desktop dev uses pnpm tauri dev)
pnpm tauri dev / pnpm tauri build
cargo run -p iptv-mock -- --port 7290
cargo run -p iptv-server -- --port 7180 --data-dir ./.data --static ./dist
pnpm e2e                                       # playwright: webServer starts iptv-mock (7290) and iptv-server (7180) with fresh data dir
```
Ports: W0 7200; B1 7201; B2 7202; B3 7203; B4 7204; B5 7205; B6 7206; B7 7207; B8 7208 (remote control tests pick free ports); B9 7209; B10 7210; B11 7211 (mock default 7290 for e2e only); U1 7220; U2 7221; U3 7222; U4 7223; U5 7224; U6 7225; T1..T3 none; E1 7230 (+7231 mock); I 7240. Reviewers: 7300..7320. Any Rust test that needs a mock server binds port 0 and reads the assigned port.

## 6. Checks

1. (SC1) `cargo test --workspace` exits 0.
2. (SC1) `cargo clippy --workspace --all-targets -- -D warnings` exits 0.
3. (SC1) `pnpm build` exits 0 and `pnpm typecheck` (tsc-rs) exits 0; `pnpm test` exits 0.
4. (SC2) `cargo test -p iptv-core --release --test m3u_perf` asserts: 50k-channel generated M3U parsed and persisted in < 3 s and peak RSS delta < 200 MB (memory-stats).
5. (SC3) `cargo test -p iptv-core --release --test epg_perf` asserts: 120 MB generated XMLTV ingested in < 15 s with peak RSS delta < 150 MB.
6. (SC4) `pnpm e2e xtream.spec.ts stalker.spec.ts`: add portal via UI, browse live/movies/series, open detail, play (player reaches 'playing'), favorite toggles and appears in /favorites, search finds a movie, catch-up opens a timeshift source.
7. (SC5) `pnpm e2e m3u.spec.ts`: add from URL, from pasted text, and from file upload; groups listed; search filters; typing `1` `2` zaps to channel 12; favorite; EPG ribbon shows now/next for a channel with XMLTV data.
8. (SC6) `cargo test -p iptv-core --test backup_import` imports `fixtures/backup-v1.json` (an export shaped like the old app's) and asserts sources, favorites, recent, hidden groups, positions, and epgUrls; export then re-import round-trips.
9. (SC7) `cargo test -p iptv-core --test downloads` against mock: pause/resume continues from byte offset; cancel removes `.part`; a second download of the same file name yields `name (1).ext`; flaky endpoint retries and completes; existing destination never overwritten.
10. (SC8) `cargo test -p iptv-core --test remote_control`: channel/up emits remote.command; request with `Origin: http://evil.example` gets 403; request with Host `192.168.1.5` gets 403.
11. (SC9) Manual: launch the packaged app, add the 50k-channel mock playlist, idle 60 s, record `tasklist` for the app exe and WebView2 child processes; sum < 150 MB. Recorded in run file.
12. (SC10) `pnpm e2e shortcuts.spec.ts a11y.spec.ts`: every C16 shortcut listed in the `?` overlay and functional; no horizontal scrollbar at 800x600 and 2560x1440 on dashboard, live, movies, settings; axe serious/critical = 0 on those pages.
13. (SC11) Manual: in `pnpm tauri dev` with mpv in vendor/, Settings > Players > Embedded MPV, play `fixtures/sample.mp4` from My Videos; screenshot saved to run dir.
14. (SC12) `pnpm e2e resume.spec.ts`: start a movie, seek to 30 s, reload, the player resumes the same movie at >= 28 s; live channel reload restores the same channel.
15. (SC13) BLOCKED until TMDB_API_KEY is in `.env`: manual run, movie detail shows TMDB plot and cast.
16. (spec) `pnpm e2e smoke.spec.ts`: fresh data dir shows the onboarding empty state on /sources; after adding the mock Xtream portal the dashboard shows rails; settings theme toggle persists across reload; backup export downloads a JSON file and import restores on a fresh data dir.
17. (spec) `cargo run -p iptv-server` serves `/api/health`, `/api/rpc/app.info`, and the SPA; `/api/proxy` rewrites an m3u8 from the mock.
18. (spec) Tauri build: `pnpm tauri build` produces an NSIS installer under `target/release/bundle` smaller than 25 MB (recorded).
