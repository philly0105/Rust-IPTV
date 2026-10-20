//! Shared model types (SPEC C2). Every type here mirrors `src/api/types.ts` 1:1.
//!
//! Rules: JSON is camelCase, string enums are kebab-case, `?` fields in TS are
//! `Option<T>` here and are omitted from JSON when `None`. Timestamps are RFC 3339
//! strings in UTC. This file is frozen after wave 0; additions go through the
//! integration agent.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Implements `as_str`, `ALL`, `Display` and `FromStr` for a kebab-case string enum
/// so the same spelling is used in JSON and in SQLite text columns.
macro_rules! string_enum {
    ($ty:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        impl $ty {
            /// The wire / database spelling of this value.
            pub const fn as_str(&self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
            /// Every variant, in declaration order.
            pub const ALL: &'static [$ty] = &[$(Self::$variant),+];
        }
        impl fmt::Display for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.as_str()) }
        }
        impl FromStr for $ty {
            type Err = crate::error::CoreError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($s => Ok(Self::$variant),)+
                    other => Err(crate::error::CoreError::Invalid(format!(
                        concat!("unknown ", stringify!($ty), " value: {}"), other
                    ))),
                }
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// Kind of playlist source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    M3u,
    Xtream,
    Stalker,
}
string_enum!(SourceKind { M3u => "m3u", Xtream => "xtream", Stalker => "stalker" });

/// Where an M3U playlist comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum M3uOrigin {
    Url,
    File,
    Text,
}
string_enum!(M3uOrigin { Url => "url", File => "file", Text => "text" });

/// Catalog content type. Stored as text in `items.content_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContentType {
    Live,
    Movie,
    Series,
    Radio,
}
string_enum!(ContentType { Live => "live", Movie => "movie", Series => "series", Radio => "radio" });

/// Per-source HTTP headers applied to playlist fetches and playback.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestHeaders {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referrer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

impl RequestHeaders {
    /// True when no header is set.
    pub fn is_empty(&self) -> bool {
        self.user_agent.is_none() && self.referrer.is_none() && self.origin.is_none()
    }
}

/// M3U source configuration (stored in `sources.config_json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct M3uSourceConfig {
    pub origin: M3uOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default)]
    pub headers: RequestHeaders,
    // guide:
    /// Per-source catch-up override for every live channel of the playlist
    /// (see `crate::catchup::m3u`). Absent = use the playlist's attributes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catchup: Option<CatchupOverride>,
}

// guide:
/// Source-wide M3U catch-up override. `kind` is `default`, `append`,
/// `shift`, `flussonic`, `xc` or `none` (catch-up off for every channel).
/// `template` replaces each channel's `catchup-source` and `days` its
/// `catchup-days`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchupOverride {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
}

/// Xtream Codes source configuration. `password` is a secret: never log it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XtreamSourceConfig {
    pub server_url: String,
    pub username: String,
    pub password: String,
    /// Headers for `player_api.php` requests. Without a User-Agent the
    /// client sends `xtream::client::XTREAM_USER_AGENT`.
    #[serde(default, skip_serializing_if = "RequestHeaders::is_empty")]
    pub headers: RequestHeaders,
}

impl fmt::Debug for XtreamSourceConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("XtreamSourceConfig")
            .field("server_url", &self.server_url)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .field("headers", &self.headers)
            .finish()
    }
}

/// Stalker / Ministra portal configuration. `password` is a secret: never log it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StalkerSourceConfig {
    pub portal_url: String,
    pub mac_address: String,
    #[serde(default)]
    pub is_full_portal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default)]
    pub headers: RequestHeaders,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature2: Option<String>,
}

impl fmt::Debug for StalkerSourceConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StalkerSourceConfig")
            .field("portal_url", &self.portal_url)
            .field("mac_address", &self.mac_address)
            .field("is_full_portal", &self.is_full_portal)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("headers", &self.headers)
            .finish_non_exhaustive()
    }
}

/// EPG URLs attached to a source (stored in `sources.epg_json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EpgLinks {
    pub detected_urls: Vec<String>,
    pub manual_urls: Vec<String>,
    pub disabled_urls: Vec<String>,
    // guide:
    /// Guide time shift of every channel of the source, in minutes (source
    /// dialog); it adds to each channel's own shift or `tvg-shift`
    /// (`epg::query::item_shift`). Absent = none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_minutes: Option<i32>,
}

/// A playlist source as returned by `sources.*`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    pub position: i64,
    pub auto_refresh: bool,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_refresh_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Classified code of `last_error` (C10); absent when there is no error
    /// or it was recorded before codes existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<crate::error::RpcErrorCode>,
    // account:
    /// When `last_error` was recorded (RFC 3339); absent without an error or
    /// for errors recorded before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<String>,
    /// Live channels only (radio stations are counted in `radio_count`).
    #[serde(default)]
    pub channel_count: i64,
    #[serde(default)]
    pub radio_count: i64,
    #[serde(default)]
    pub movie_count: i64,
    #[serde(default)]
    pub series_count: i64,
    #[serde(default)]
    pub epg: EpgLinks,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub m3u: Option<M3uSourceConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xtream: Option<XtreamSourceConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stalker: Option<StalkerSourceConfig>,
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// Stable reference to one catalog item. Serialized under the JSON key `ref`
/// wherever it is embedded (`ref` is a Rust keyword, so fields are `item_ref`).
///
/// `item_id`: m3u -> 16 hex chars of sha256(url + '\n' + name); xtream ->
/// stream_id / series_id as decimal string; stalker -> portal id string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub source_id: String,
    pub content_type: ContentType,
    pub item_id: String,
}

impl ItemRef {
    pub fn new(
        source_id: impl Into<String>,
        content_type: ContentType,
        item_id: impl Into<String>,
    ) -> Self {
        Self {
            source_id: source_id.into(),
            content_type,
            item_id: item_id.into(),
        }
    }

    /// Map key used by `epg.nowNext` / `epg.grid`: `${sourceId}|${contentType}|${itemId}`.
    pub fn key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.source_id,
            self.content_type.as_str(),
            self.item_id
        )
    }
}

/// A catalog category (group).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub source_id: String,
    pub content_type: ContentType,
    pub name: String,
    pub hidden: bool,
    pub item_count: i64,
    pub position: i64,
    /// Only in `catalog.categories` answers with `includeHidden`: true when
    /// the answer without it leaves this group out only because hidden
    /// channels (channel edits) left it empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emptied_by_edits: Option<bool>,
}

/// Catch-up / timeshift availability of a channel.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_hours: Option<i64>,
}

/// A live or radio channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub category_id: String,
    pub category_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epg_channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub is_radio: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<ArchiveInfo>,
    /// Per-channel request headers (m3u `#EXTVLCOPT` / `url|Header=` values);
    /// they override the source-level headers for this channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<RequestHeaders>,
    /// m3u catch-up attributes (`catchup`, `catchup-days`, `catchup-source`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catchup: Option<CatchupInfo>,
    /// m3u ClearKey licence from `#KODIPROP` (`inputstream.adaptive.license_key`
    /// with `license_type=clearkey`, or `drm_legacy=org.w3.clearkey|...`), as
    /// written: kid:key pairs, a JSON key map or JWK set, or a licence URL. The
    /// UI parses it and hands the keys to shaka for DASH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_key: Option<String>,
}

/// m3u catch-up attributes of a channel. `kind` is the lowercased `catchup`
/// attribute (`default`, `append`, `shift`, `xc`, `flussonic`, ...); `source`
/// is the `catchup-source` template. `default` / `append` without a source
/// use the standard `?utc={utc}&lutc={lutc}` convention.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchupInfo {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// A movie.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodItem {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<String>,
    pub category_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_extension: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmdb_id: Option<i64>,
    /// Stream URL of an M3U movie, as the playlist lists it. Only
    /// `catalog.item` sets it, and only on M3U sources: Xtream and Stalker
    /// links carry the account and come from `xtream.streamUrl` and
    /// `stalker.streamUrl` at play time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The M3U movie's own request headers (`#EXTVLCOPT`, `url|User-Agent=`);
    /// set with `url`. The playlist's headers apply under them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<RequestHeaders>,
}

/// A series (show).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesItem {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<String>,
    pub category_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmdb_id: Option<i64>,
}

/// One episode of a series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub series_ref: ItemRef,
    pub season: i64,
    pub episode: i64,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_extension: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<String>,
}

/// One season with its episodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub number: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(default)]
    pub episodes: Vec<Episode>,
}

/// Cast or crew member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_url: Option<String>,
}

/// Movie detail page payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodDetail {
    pub item: VodItem,
    #[serde(default)]
    pub cast: Vec<Person>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub director: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trailer_url: Option<String>,
    #[serde(default)]
    pub backdrops: Vec<String>,
    /// The provider's detail call failed; the page is built from the
    /// catalog row alone (the UI shows a hint).
    #[serde(default)]
    pub provider_details_unavailable: bool,
    /// Why the provider's detail call failed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_error: Option<String>,
}

/// Series detail page payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDetail {
    pub item: SeriesItem,
    #[serde(default)]
    pub seasons: Vec<Season>,
    #[serde(default)]
    pub cast: Vec<Person>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub director: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trailer_url: Option<String>,
    #[serde(default)]
    pub backdrops: Vec<String>,
    /// The provider's detail call failed; the page is built from the
    /// catalog row alone (the UI shows a hint).
    #[serde(default)]
    pub provider_details_unavailable: bool,
    /// Why the provider's detail call failed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_error: Option<String>,
}

/// One page of a paged list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

impl<T> Page<T> {
    /// An empty page echoing the requested window.
    pub fn empty(offset: i64, limit: i64) -> Self {
        Self {
            items: Vec::new(),
            total: 0,
            offset,
            limit,
        }
    }

    /// Maps the items while keeping paging metadata.
    pub fn map<U>(self, f: impl FnMut(T) -> U) -> Page<U> {
        Page {
            items: self.items.into_iter().map(f).collect(),
            total: self.total,
            offset: self.offset,
            limit: self.limit,
        }
    }
}

/// Sort keys for paged queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SortKey {
    Name,
    Added,
    Rating,
    Number,
    Year,
}
string_enum!(SortKey { Name => "name", Added => "added", Rating => "rating", Number => "number", Year => "year" });

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SortDir {
    Asc,
    Desc,
}
string_enum!(SortDir { Asc => "asc", Desc => "desc" });

/// Paging + filtering window for catalog queries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageQuery {
    #[serde(default)]
    pub offset: i64,
    #[serde(default = "default_page_limit")]
    pub limit: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<SortKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<SortDir>,
}

fn default_page_limit() -> i64 {
    100
}

impl Default for PageQuery {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: default_page_limit(),
            search: None,
            sort: None,
            dir: None,
        }
    }
}

// ---------------------------------------------------------------------------
// EPG
// ---------------------------------------------------------------------------

/// One programme from XMLTV or a portal short EPG.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgProgram {
    pub channel_id: String,
    pub start: String,
    pub end: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Current and next programme of a channel.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgNowNext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now: Option<EpgProgram>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<EpgProgram>,
}

/// Fetch state of an EPG URL (`EpgSourceStatus.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EpgFetchStatus {
    Idle,
    Fetching,
    Ok,
    Error,
}
string_enum!(EpgFetchStatus { Idle => "idle", Fetching => "fetching", Ok => "ok", Error => "error" });

/// Where an EPG URL was configured (`EpgSourceStatus.origin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EpgOrigin {
    Settings,
    Source,
}
string_enum!(EpgOrigin { Settings => "settings", Source => "source" });

/// Status row for one EPG URL (`epg.sources`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgSourceStatus {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fetch_at: Option<String>,
    pub status: EpgFetchStatus,
    pub program_count: i64,
    pub channel_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub enabled: bool,
    pub origin: EpgOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
}

// ---------------------------------------------------------------------------
// User state
// ---------------------------------------------------------------------------

/// Display snapshot stored with favorites / recent / positions so lists render
/// without joining the catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSnapshot {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    pub content_type: ContentType,
}

/// Saved resume position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPosition {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    pub position_seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ItemSnapshot>,
    /// Marked watched (`userstate.setWatched`); excluded from continue watching.
    #[serde(default)]
    pub watched: bool,
}

/// A favorite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteEntry {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub added_at: String,
    pub position: i64,
    pub snapshot: ItemSnapshot,
}

/// A recently viewed entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub viewed_at: String,
    pub snapshot: ItemSnapshot,
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/// Download lifecycle state. Stored as text in `downloads.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
    Canceled,
}
string_enum!(DownloadStatus {
    Queued => "queued",
    Downloading => "downloading",
    Paused => "paused",
    Completed => "completed",
    Failed => "failed",
    Canceled => "canceled",
});

/// A download row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: i64,
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    pub status: DownloadStatus,
    pub bytes_downloaded: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_available: Option<bool>,
    #[serde(default)]
    pub position_seconds: i64,
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/// How the UI should play a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerKind {
    Hls,
    Dash,
    Direct,
    File,
}
string_enum!(PlayerKind { Hls => "hls", Dash => "dash", Direct => "direct", File => "file" });

/// A resolved, playable source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSource {
    pub url: String,
    pub kind: PlayerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<RequestHeaders>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub item_ref: Option<ItemRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    /// Whole seconds; the UI may send the player position as a fraction (8.967).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de_opt_whole_seconds"
    )]
    pub resume_seconds: Option<i64>,
    #[serde(default)]
    pub is_live: bool,
    #[serde(default)]
    pub is_radio: bool,
}

fn de_opt_whole_seconds<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(Option::<f64>::deserialize(d)?
        .filter(|s| s.is_finite())
        .map(|s| s.trunc() as i64))
}

/// Configured playback backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoPlayer {
    Html5,
    Videojs,
    EmbeddedMpv,
    Mpv,
    Vlc,
}
string_enum!(VideoPlayer {
    Html5 => "html5",
    Videojs => "videojs",
    EmbeddedMpv => "embedded-mpv",
    Mpv => "mpv",
    Vlc => "vlc",
});

/// Preferred Xtream live stream container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamFormat {
    M3u8,
    Ts,
}
string_enum!(StreamFormat { M3u8 => "m3u8", Ts => "ts" });

/// Color theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    Light,
    Dark,
    System,
}
string_enum!(Theme { Light => "light", Dark => "dark", System => "system" });

/// What to show at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupBehavior {
    FirstView,
    RestoreLastView,
}
string_enum!(StartupBehavior { FirstView => "first-view", RestoreLastView => "restore-last-view" });

/// How the desktop window opens (`Settings.windowStart`): with the size and
/// position it had when it closed, maximized, or fullscreen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowStart {
    Normal,
    Maximized,
    Fullscreen,
}
string_enum!(WindowStart { Normal => "normal", Maximized => "maximized", Fullscreen => "fullscreen" });

/// EPG ribbon layout (`Settings.epgViewMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EpgViewMode {
    Timeline,
    List,
}
string_enum!(EpgViewMode { Timeline => "timeline", List => "list" });

/// Poster card size (`Settings.coverSize`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoverSize {
    Small,
    Medium,
    Large,
}
string_enum!(CoverSize { Small => "small", Medium => "medium", Large => "large" });

// recording:
/// What a due guide reminder does (`Settings.reminderAction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReminderAction {
    Notify,
    Switch,
}
string_enum!(ReminderAction { Notify => "notify", Switch => "switch" });

// appearance:
/// Accent color family (`Settings.accent`). The UI maps each value to its
/// `--color-accent*` tokens through `html[data-accent]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Accent {
    Amber,
    Teal,
    Violet,
    Rose,
    Lime,
    Sky,
    Coral,
}
string_enum!(Accent {
    Amber => "amber",
    Teal => "teal",
    Violet => "violet",
    Rose => "rose",
    Lime => "lime",
    Sky => "sky",
    Coral => "coral",
});

/// Spacing density of lists, rails and rows (`Settings.density`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Density {
    Comfortable,
    Compact,
}
string_enum!(Density { Comfortable => "comfortable", Compact => "compact" });

// subtitles:
/// Subtitle text size (`Settings.subtitleSize`): 0.8, 1.0, 1.25 and 1.5 times
/// the player's base size (mpv `sub-scale`, the built-in player's `::cue`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubtitleSize {
    Small,
    Medium,
    Large,
    Xlarge,
}
string_enum!(SubtitleSize {
    Small => "small",
    Medium => "medium",
    Large => "large",
    Xlarge => "xlarge",
});

/// Subtitle text colour (`Settings.subtitleColor`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubtitleColor {
    White,
    Yellow,
    Cyan,
    Green,
}
string_enum!(SubtitleColor {
    White => "white",
    Yellow => "yellow",
    Cyan => "cyan",
    Green => "green",
});

/// What sits behind subtitle text (`Settings.subtitleBackground`): a text
/// shadow only, a translucent box, or an opaque black box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubtitleBackground {
    Shadow,
    Box,
    Solid,
}
string_enum!(SubtitleBackground { Shadow => "shadow", Box => "box", Solid => "solid" });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Dashboard rail toggles. Missing fields default to `true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DashboardRails {
    pub hero: bool,
    pub continue_watching: bool,
    pub live_favorites: bool,
    pub recently_watched_live: bool,
    pub favorite_movies_and_series: bool,
    pub recent_sources: bool,
    pub recently_added: bool,
    pub tmdb_trending: bool,
    // watchlist:
    /// The My List rail (movies and series saved with `watchlist.toggle`).
    pub my_list: bool,
}

impl Default for DashboardRails {
    fn default() -> Self {
        Self {
            hero: true,
            continue_watching: true,
            live_favorites: true,
            recently_watched_live: true,
            favorite_movies_and_series: true,
            recent_sources: true,
            recently_added: true,
            tmdb_trending: true,
            // watchlist:
            my_list: true,
        }
    }
}

/// TMDB enrichment settings. `api_key` is a secret: `Debug` redacts it; never log it.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TmdbSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

impl fmt::Debug for TmdbSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TmdbSettings")
            .field("enabled", &self.enabled)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("language", &self.language)
            .finish()
    }
}

/// Default loopback port of the remote control API.
pub const DEFAULT_REMOTE_PORT: u16 = 7310;

/// Remote control settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteControlSettings {
    pub enabled: bool,
    pub port: u16,
}

impl Default for RemoteControlSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_REMOTE_PORT,
        }
    }
}

/// Application settings, persisted as JSON in the `settings` table (row id 1).
///
/// `#[serde(default)]` sits at struct level so a field missing from older JSON
/// takes its value from `Settings::default()` (for example
/// `playerAutoplayNextEpisode` stays `true`). A per-field `#[serde(default)]`
/// would use the field type's zero value instead, which is wrong for fields whose
/// default is `true`. Every field is therefore defaulted, as C2 requires.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub player: VideoPlayer,
    pub stream_format: StreamFormat,
    pub epg_urls: Vec<String>,
    pub language: String,
    pub theme: Theme,
    pub show_dashboard: bool,
    pub startup_behavior: StartupBehavior,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mpv_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlc_path: Option<String>,
    pub mpv_args: String,
    pub vlc_args: String,
    pub open_stream_on_double_click: bool,
    pub show_captions: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads_dir: Option<String>,
    pub tmdb: TmdbSettings,
    pub dashboard_rails: DashboardRails,
    pub remote_control: RemoteControlSettings,
    pub player_ambient_mode: bool,
    pub player_autoplay_next_episode: bool,
    pub player_up_next_rail: bool,
    pub fullscreen_channel_panel: bool,
    pub vod_auto_failover: bool,
    pub epg_view_mode: EpgViewMode,
    pub cover_size: CoverSize,
    /// Launching an external player first closes the previous external
    /// player this app started (VLC also gets `--one-instance`).
    pub player_reuse_instance: bool,
    /// Where `mpv.record` writes; `null` = `<downloadsDir>/recordings`.
    pub recordings_dir: Option<String>,
    /// UI strips a leading `XX: ` / `XX | ` / `[XX] ` country tag from channel names.
    pub strip_country_prefix: bool,
    /// Minutes added to displayed programme times (-720..=720).
    pub epg_offset_minutes: i32,
    /// Show the external-playback footer.
    pub show_external_bar: bool,
    /// VOD grids hide items rated below this (0..=10; 0 shows everything).
    pub vod_min_rating: f64,
    /// Channel lists, movie and series grids, categories and search hide items
    /// whose title or category clearly marks another language. Items without
    /// a clear language stay (`catalog::language`).
    pub english_only: bool,
    // failover:
    /// A live channel that fails switches to the same channel on another source.
    pub live_failover: bool,
    /// A dropped or stalled stream is retried quietly before the error shows.
    pub stream_reconnect: bool,
    // remote:
    /// The remote control also listens on this computer's private network
    /// addresses so paired phones can use it (desktop only; off by default).
    pub remote_lan_enabled: bool,
    // account:
    /// Auto-refresh sources are re-imported when their last refresh is older
    /// than this many hours (0 = only at startup).
    pub source_refresh_interval_hours: u32,
    /// Warn this many days before a subscription expires (0 = off).
    pub account_expiry_warn_days: u32,
    // guide:
    /// Xtream channels without XMLTV programmes use the panel's short EPG.
    pub epg_short_fallback: bool,
    // recording:
    /// Minutes a scheduled recording starts before the programme (0..=60).
    pub recording_padding_before_minutes: u32,
    /// Minutes a scheduled recording runs past the programme end (0..=120).
    pub recording_padding_after_minutes: u32,
    /// Guide reminders fire while the app runs.
    pub reminders_enabled: bool,
    /// Minutes before the start a reminder fires (0..=60).
    pub reminder_lead_minutes: u32,
    /// Notify, or switch to the channel.
    pub reminder_action: ReminderAction,
    // appearance:
    /// Accent color family used for focus rings, selection and primary actions.
    pub accent: Accent,
    /// Pure-black surfaces whenever the dark theme is in effect (`dark`, or
    /// `system` resolving to dark). Ignored while the light theme shows.
    pub oled_black: bool,
    /// Spacing density of lists, rails and rows.
    pub density: Density,
    /// Root font scale: the UI sets `html { font-size: calc(15px * uiScale) }`.
    /// A finite number in [`crate::settings::UI_SCALE_RANGE`] (0.9..=1.25),
    /// rounded to whole percent on save.
    pub ui_scale: f64,
    /// Now/next banner inside the player on every live channel change.
    pub zap_banner: bool,
    // subtitles:
    /// Subtitle text size in mpv and the built-in player.
    pub subtitle_size: SubtitleSize,
    /// Subtitle text colour.
    pub subtitle_color: SubtitleColor,
    /// Shadow, translucent box (today's `rgb(0 0 0 / .72)` cue background) or
    /// opaque box behind subtitle text.
    pub subtitle_background: SubtitleBackground,
    /// Percent of the picture height subtitles are raised from the bottom, an
    /// integer in [`crate::settings::SUBTITLE_POSITION_RANGE`] (0..=40).
    pub subtitle_position: u32,
    // vod:
    /// The VOD grid's "Hide watched" toggle: `catalog.movies` / `catalog.series`
    /// are asked with `hideWatched`.
    pub vod_hide_watched: bool,
    // Run 3 (machine-local: none of these is in `backup::APP_SETTING_KEYS`):
    /// Size cap of the on-disk image cache in MB, an integer in
    /// [`crate::settings::IMAGE_CACHE_MAX_MB_RANGE`] (50..=5000). Applies to
    /// the desktop app and to the server's cache in server mode.
    pub image_cache_max_mb: u32,
    /// The first-run tour was finished or skipped.
    pub tour_completed: bool,
    /// App version whose "What's new" the user last saw: `''` (never) or 1..=32
    /// characters of `[0-9A-Za-z.+-]` ([`crate::settings::LAST_SEEN_VERSION_MAX_LEN`]).
    pub last_seen_version: String,
    // desktop (machine-local, not in `backup::APP_SETTING_KEYS`):
    /// How the desktop window opens; applied when it is first shown
    /// (`reveal_main` in iptv-tauri). The browser and server mode ignore it.
    pub window_start: WindowStart,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            player: VideoPlayer::Html5,
            stream_format: StreamFormat::M3u8,
            epg_urls: Vec::new(),
            language: "en".to_string(),
            theme: Theme::System,
            show_dashboard: true,
            startup_behavior: StartupBehavior::RestoreLastView,
            last_route: None,
            mpv_path: None,
            vlc_path: None,
            mpv_args: String::new(),
            vlc_args: String::new(),
            open_stream_on_double_click: false,
            show_captions: false,
            downloads_dir: None,
            tmdb: TmdbSettings::default(),
            dashboard_rails: DashboardRails::default(),
            remote_control: RemoteControlSettings::default(),
            player_ambient_mode: false,
            player_autoplay_next_episode: true,
            player_up_next_rail: true,
            fullscreen_channel_panel: true,
            vod_auto_failover: false,
            epg_view_mode: EpgViewMode::Timeline,
            cover_size: CoverSize::Medium,
            player_reuse_instance: true,
            recordings_dir: None,
            strip_country_prefix: false,
            epg_offset_minutes: 0,
            show_external_bar: true,
            vod_min_rating: 0.0,
            english_only: false,
            // failover:
            live_failover: true,
            stream_reconnect: true,
            // remote:
            remote_lan_enabled: false,
            // account:
            source_refresh_interval_hours: 12,
            account_expiry_warn_days: 7,
            // guide:
            epg_short_fallback: true,
            // recording:
            recording_padding_before_minutes: 1,
            recording_padding_after_minutes: 5,
            reminders_enabled: true,
            reminder_lead_minutes: 2,
            reminder_action: ReminderAction::Notify,
            // appearance:
            accent: Accent::Amber,
            oled_black: false,
            density: Density::Comfortable,
            ui_scale: 1.0,
            zap_banner: true,
            // subtitles:
            subtitle_size: SubtitleSize::Medium,
            subtitle_color: SubtitleColor::White,
            subtitle_background: SubtitleBackground::Box,
            subtitle_position: 0,
            // vod:
            vod_hide_watched: false,
            // Run 3:
            image_cache_max_mb: 500,
            tour_completed: false,
            last_seen_version: String::new(),
            // desktop:
            window_start: WindowStart::Normal,
        }
    }
}

/// Persisted main window geometry (`app_state` key `window_state`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// `app.info` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub platform: String,
    pub is_desktop: bool,
    pub log_file: String,
    /// Desktop only: base URL of the in-process loopback media proxy
    /// (`http://127.0.0.1:<port>/api/proxy`); `null` in server mode.
    #[serde(default)]
    pub proxy_base: Option<String>,
    /// Desktop only: the image cache route on a second loopback listener
    /// (`http://127.0.0.1:<port>/<token>/api/img`), so artwork does not wait
    /// behind streams for the webview's six connections per host and port;
    /// `null` in server mode.
    #[serde(default)]
    pub image_base: Option<String>,
    /// True only in a desktop build compiled with the `updater` feature.
    #[serde(default)]
    pub updater_available: bool,
}

// ---------------------------------------------------------------------------
// Embedded mpv
// ---------------------------------------------------------------------------

/// mpv track type (`MpvTrack.type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MpvTrackType {
    Audio,
    Sub,
    Video,
}
string_enum!(MpvTrackType { Audio => "audio", Sub => "sub", Video => "video" });

/// One audio / subtitle / video track reported by mpv.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvTrack {
    pub id: i64,
    #[serde(rename = "type")]
    pub track_type: MpvTrackType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub selected: bool,
}

/// Snapshot of the embedded mpv session (`mpv.state` result and event).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvState {
    pub attached: bool,
    pub loaded: bool,
    pub paused: bool,
    pub time_pos: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    pub volume: f64,
    pub muted: bool,
    #[serde(default)]
    pub tracks: Vec<MpvTrack>,
    pub fullscreen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// True while `mpv.record` is writing the stream to disk.
    #[serde(default)]
    pub recording: bool,
    /// File being recorded, `null` when not recording.
    #[serde(default)]
    pub record_path: Option<String>,
    /// Stretch of the stream mpv holds in its cache and can seek in (seconds on
    /// the `time_pos` clock). For live TV this is the rewind window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seekable: Option<MpvSeekRange>,
    /// mpv's `paused-for-cache`: true while playback waits for the network
    /// to refill the cache (show a buffering indicator). `None` until mpv
    /// reports it (no file loaded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buffering: Option<bool>,
}

/// One seekable range of mpv's demuxer cache.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MpvSeekRange {
    pub start: f64,
    pub end: f64,
}

impl Default for MpvState {
    fn default() -> Self {
        Self {
            attached: false,
            loaded: false,
            paused: true,
            time_pos: 0.0,
            duration: None,
            volume: 100.0,
            muted: false,
            tracks: Vec::new(),
            fullscreen: false,
            error: None,
            recording: false,
            record_path: None,
            seekable: None,
            buffering: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Counts produced by an importer run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub channels: i64,
    pub movies: i64,
    pub series: i64,
    /// The playlist or the portal's answers had not changed since the last
    /// import, so the catalog was kept as is (m3u, Xtream, Stalker).
    /// `run_import` then reports `done` with the message
    /// `unchanged` and sends no `sources.changed`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
}

// ---------------------------------------------------------------------------
// Remote control (SPEC C4 remote section; TS `RemoteStatus`)
// ---------------------------------------------------------------------------

/// Player status published to the remote control UI.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(default)]
    pub is_live: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_number: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epg_now: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(default)]
    pub can_volume: bool,
}

// ---------------------------------------------------------------------------
// TMDB (SPEC C4 tmdb section). Shared so tmdb, catalog and detail code agree.
// ---------------------------------------------------------------------------

/// TMDB media type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TmdbMediaType {
    Movie,
    Tv,
}
string_enum!(TmdbMediaType { Movie => "movie", Tv => "tv" });

/// Card-sized TMDB entry (rails, similar, known-for).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbBrief {
    pub tmdb_id: i64,
    pub media_type: TmdbMediaType,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
}

/// TMDB movie details. Flattens `TmdbBrief`, matching the TS `extends`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbMovie {
    #[serde(flatten)]
    pub brief: TmdbBrief,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<i64>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub cast: Vec<Person>,
    #[serde(default)]
    pub crew: Vec<Person>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub director: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trailer_youtube_key: Option<String>,
    #[serde(default)]
    pub similar: Vec<TmdbBrief>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imdb_id: Option<String>,
}

/// Season summary inside `TmdbTv`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbTvSeasonSummary {
    pub number: i64,
    pub name: String,
    pub episode_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_date: Option<String>,
}

/// TMDB TV show details. Flattens `TmdbBrief`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbTv {
    #[serde(flatten)]
    pub brief: TmdbBrief,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub cast: Vec<Person>,
    #[serde(default)]
    pub crew: Vec<Person>,
    #[serde(default)]
    pub creators: Vec<String>,
    #[serde(default)]
    pub seasons: Vec<TmdbTvSeasonSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trailer_youtube_key: Option<String>,
    #[serde(default)]
    pub similar: Vec<TmdbBrief>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// Episode inside `TmdbSeason`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbEpisode {
    pub number: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub still_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<i64>,
}

/// TMDB season details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbSeason {
    pub number: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(default)]
    pub episodes: Vec<TmdbEpisode>,
}

/// TMDB person (actor page).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbPerson {
    pub id: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub biography: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birthday: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place_of_birth: Option<String>,
    #[serde(default)]
    pub known_for: Vec<TmdbBrief>,
}

// ---------------------------------------------------------------------------
// parental: parental controls (contract C2; `crate::parental` implements)
// ---------------------------------------------------------------------------

/// Default `ParentalStatus.unlockMinutes` (C2).
pub const DEFAULT_PARENTAL_UNLOCK_MINUTES: u32 = 15;

/// How locked content is treated while parental controls are on and locked.
/// `hide` drops it from every catalog and user-state reader; `ask` shows it
/// and the UI asks for the PIN before it opens. Stored as text in
/// `parental_config.mode`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParentalMode {
    #[default]
    Hide,
    Ask,
}
string_enum!(ParentalMode { Hide => "hide", Ask => "ask" });

/// What a parental lock targets. Stored as text in `parental_locks.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParentalLockKind {
    Category,
    Item,
}
string_enum!(ParentalLockKind { Category => "category", Item => "item" });

/// `parental.status` and the `parental.changed` event payload. Never carries
/// the PIN or its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentalStatus {
    /// A PIN is set.
    pub enabled: bool,
    pub mode: ParentalMode,
    /// Categories whose name marks adult content count as locked.
    pub auto_adult: bool,
    /// Length of a session unlock: 0 = until the app restarts, else 1..=720.
    pub unlock_minutes: u32,
    /// A session unlock is active now.
    pub unlocked: bool,
    /// RFC 3339 end of the session unlock; absent when locked or unlocked
    /// until restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlocked_until: Option<String>,
    /// Consecutive wrong PINs.
    pub failed_attempts: u32,
    /// Present while the wrong-PIN lockout is active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

impl Default for ParentalStatus {
    /// No PIN set, with the C2 defaults for the configurable fields.
    fn default() -> Self {
        Self {
            enabled: false,
            mode: ParentalMode::Hide,
            auto_adult: true,
            unlock_minutes: DEFAULT_PARENTAL_UNLOCK_MINUTES,
            unlocked: false,
            unlocked_until: None,
            failed_attempts: 0,
            retry_after_seconds: None,
        }
    }
}

/// One stored lock (`parental.locks`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentalLock {
    pub source_id: String,
    pub content_type: ContentType,
    pub kind: ParentalLockKind,
    /// Category id or item id, depending on `kind`.
    pub target_id: String,
    /// Display name snapshot taken when the lock was added.
    pub name: String,
    pub created_at: String,
}

/// A lock without its timestamp (`parental.setLocked` argument; TS
/// `Omit<ParentalLock, 'createdAt'>`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentalLockTarget {
    pub source_id: String,
    pub content_type: ContentType,
    pub kind: ParentalLockKind,
    pub target_id: String,
    pub name: String,
}

// ---------------------------------------------------------------------------
// watchlist: My List (contract C3; `crate::watchlist` implements)
// ---------------------------------------------------------------------------

/// One My List entry (`watchlist.list`). Only movies and series are listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistEntry {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub snapshot: ItemSnapshot,
    pub added_at: String,
    /// The item counts as watched.
    pub watched: bool,
}

#[cfg(test)]
mod tests {
    #[test]
    fn player_source_takes_a_fractional_resume_position() {
        let src: super::PlayerSource =
            serde_json::from_value(serde_json::json!({"url": "http://h/x", "kind": "direct", "title": "X", "resumeSeconds": 8.967}))
                .unwrap();
        assert_eq!(src.resume_seconds, Some(8));
        let src: super::PlayerSource =
            serde_json::from_value(serde_json::json!({"url": "http://h/x", "kind": "direct", "title": "X", "resumeSeconds": 300}))
                .unwrap();
        assert_eq!(src.resume_seconds, Some(300));
    }

    use super::*;

    #[test]
    fn enums_are_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ContentType::Live).unwrap(),
            "\"live\""
        );
        assert_eq!(
            serde_json::to_string(&VideoPlayer::EmbeddedMpv).unwrap(),
            "\"embedded-mpv\""
        );
        assert_eq!(
            serde_json::to_string(&StartupBehavior::RestoreLastView).unwrap(),
            "\"restore-last-view\""
        );
        assert_eq!(
            serde_json::to_string(&StreamFormat::M3u8).unwrap(),
            "\"m3u8\""
        );
        assert_eq!(
            "embedded-mpv".parse::<VideoPlayer>().unwrap(),
            VideoPlayer::EmbeddedMpv
        );
        assert!("nope".parse::<ContentType>().is_err());
        // appearance, parental: serde and `string_enum!` spell values alike.
        for a in Accent::ALL {
            assert_eq!(serde_json::to_value(a).unwrap(), a.as_str());
            assert_eq!(a.as_str().parse::<Accent>().unwrap(), *a);
        }
        for d in Density::ALL {
            assert_eq!(serde_json::to_value(d).unwrap(), d.as_str());
            assert_eq!(d.as_str().parse::<Density>().unwrap(), *d);
        }
        for m in ParentalMode::ALL {
            assert_eq!(serde_json::to_value(m).unwrap(), m.as_str());
        }
        for k in ParentalLockKind::ALL {
            assert_eq!(serde_json::to_value(k).unwrap(), k.as_str());
        }
        assert_eq!(Accent::ALL.len(), 7);
        assert!("Amber".parse::<Accent>().is_err());
        assert!("cozy".parse::<Density>().is_err());
        // subtitles:
        for s in SubtitleSize::ALL {
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
            assert_eq!(s.as_str().parse::<SubtitleSize>().unwrap(), *s);
        }
        for c in SubtitleColor::ALL {
            assert_eq!(serde_json::to_value(c).unwrap(), c.as_str());
            assert_eq!(c.as_str().parse::<SubtitleColor>().unwrap(), *c);
        }
        for b in SubtitleBackground::ALL {
            assert_eq!(serde_json::to_value(b).unwrap(), b.as_str());
            assert_eq!(b.as_str().parse::<SubtitleBackground>().unwrap(), *b);
        }
        assert_eq!(
            serde_json::to_value(SubtitleSize::Xlarge).unwrap(),
            "xlarge",
            "not kebab-split into x-large"
        );
        assert!("x-large".parse::<SubtitleSize>().is_err());
    }

    /// Matches the frontend DEFAULT_SETTINGS (`src/api/types.ts`).
    #[test]
    fn startup_behavior_defaults_to_restoring_the_last_view() {
        assert_eq!(
            Settings::default().startup_behavior,
            StartupBehavior::RestoreLastView
        );
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["startupBehavior"], "restore-last-view");
        let missing: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(missing.startup_behavior, StartupBehavior::RestoreLastView);
        // A saved choice is kept.
        let saved: Settings = serde_json::from_str(r#"{"startupBehavior":"first-view"}"#).unwrap();
        assert_eq!(saved.startup_behavior, StartupBehavior::FirstView);
    }

    #[test]
    fn settings_defaults_fill_missing_fields() {
        let s: Settings =
            serde_json::from_str(r#"{"theme":"dark","remoteControl":{"enabled":true}}"#).unwrap();
        assert_eq!(s.theme, Theme::Dark);
        assert!(s.player_autoplay_next_episode);
        assert!(s.dashboard_rails.tmdb_trending);
        assert!(s.remote_control.enabled);
        assert_eq!(s.remote_control.port, DEFAULT_REMOTE_PORT);
        assert_eq!(s.language, "en");
        let empty: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Settings::default());
        let round: Settings =
            serde_json::from_value(serde_json::to_value(Settings::default()).unwrap()).unwrap();
        assert_eq!(round, Settings::default());
    }

    /// C1: the appearance fields and the My List rail read their defaults
    /// from JSON stored by older builds, and keep saved values.
    #[test]
    fn appearance_defaults_and_round_trip() {
        let old: Settings = serde_json::from_str(
            r#"{"theme":"dark","dashboardRails":{"hero":false,"tmdbTrending":true}}"#,
        )
        .unwrap();
        assert_eq!(old.accent, Accent::Amber);
        assert!(!old.oled_black);
        assert_eq!(old.density, Density::Comfortable);
        assert_eq!(old.ui_scale, 1.0);
        assert!(old.zap_banner);
        assert!(old.dashboard_rails.my_list, "a missing rail defaults to on");
        assert!(!old.dashboard_rails.hero, "saved rails are kept");

        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["accent"], "amber");
        assert_eq!(v["oledBlack"], false);
        assert_eq!(v["density"], "comfortable");
        assert_eq!(v["uiScale"], 1.0);
        assert_eq!(v["zapBanner"], true);
        assert_eq!(v["dashboardRails"]["myList"], true);

        let saved: Settings = serde_json::from_str(
            r#"{"accent":"coral","oledBlack":true,"density":"compact","uiScale":1.15,"zapBanner":false,"dashboardRails":{"myList":false}}"#,
        )
        .unwrap();
        assert_eq!(saved.accent, Accent::Coral);
        assert!(saved.oled_black);
        assert_eq!(saved.density, Density::Compact);
        assert_eq!(saved.ui_scale, 1.15);
        assert!(!saved.zap_banner);
        assert!(!saved.dashboard_rails.my_list);
        let round: Settings =
            serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap();
        assert_eq!(round, saved);
        assert!(serde_json::from_str::<Settings>(r#"{"accent":"neon"}"#).is_err());
    }

    /// Run 2 C1: subtitle style and the VOD "Hide watched" toggle default
    /// for JSON stored by older builds and keep saved values.
    #[test]
    fn subtitle_and_vod_defaults_and_round_trip() {
        let old: Settings = serde_json::from_str(r#"{"theme":"dark","accent":"teal"}"#).unwrap();
        assert_eq!(old.subtitle_size, SubtitleSize::Medium);
        assert_eq!(old.subtitle_color, SubtitleColor::White);
        assert_eq!(old.subtitle_background, SubtitleBackground::Box);
        assert_eq!(old.subtitle_position, 0);
        assert!(!old.vod_hide_watched);

        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["subtitleSize"], "medium");
        assert_eq!(v["subtitleColor"], "white");
        assert_eq!(v["subtitleBackground"], "box");
        assert_eq!(v["subtitlePosition"], 0);
        assert_eq!(v["vodHideWatched"], false);

        let saved: Settings = serde_json::from_str(
            r#"{"subtitleSize":"xlarge","subtitleColor":"yellow","subtitleBackground":"solid","subtitlePosition":25,"vodHideWatched":true}"#,
        )
        .unwrap();
        assert_eq!(saved.subtitle_size, SubtitleSize::Xlarge);
        assert_eq!(saved.subtitle_color, SubtitleColor::Yellow);
        assert_eq!(saved.subtitle_background, SubtitleBackground::Solid);
        assert_eq!(saved.subtitle_position, 25);
        assert!(saved.vod_hide_watched);
        let round: Settings =
            serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap();
        assert_eq!(round, saved);
        assert!(serde_json::from_str::<Settings>(r#"{"subtitleColor":"red"}"#).is_err());
        assert!(serde_json::from_str::<Settings>(r#"{"subtitlePosition":-1}"#).is_err());
    }

    /// Run 3 C1: the image cache cap and the onboarding markers default for
    /// JSON stored by older builds, keep saved values, and stay machine-local
    /// (a backup never carries them).
    #[test]
    fn run3_defaults_round_trip_and_stay_machine_local() {
        let old: Settings =
            serde_json::from_str(r#"{"theme":"dark","vodHideWatched":true}"#).unwrap();
        assert_eq!(old.image_cache_max_mb, 500);
        assert!(!old.tour_completed);
        assert_eq!(old.last_seen_version, "");

        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["imageCacheMaxMb"], 500);
        assert_eq!(v["tourCompleted"], false);
        assert_eq!(v["lastSeenVersion"], "");

        let saved: Settings = serde_json::from_str(
            r#"{"imageCacheMaxMb":2000,"tourCompleted":true,"lastSeenVersion":"0.1.0"}"#,
        )
        .unwrap();
        assert_eq!(saved.image_cache_max_mb, 2000);
        assert!(saved.tour_completed);
        assert_eq!(saved.last_seen_version, "0.1.0");
        let round: Settings =
            serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap();
        assert_eq!(round, saved);
        assert!(serde_json::from_str::<Settings>(r#"{"imageCacheMaxMb":-1}"#).is_err());
        assert!(serde_json::from_str::<Settings>(r#"{"imageCacheMaxMb":250.5}"#).is_err());
        assert!(serde_json::from_str::<Settings>(r#"{"tourCompleted":"yes"}"#).is_err());
        assert!(serde_json::from_str::<Settings>(r#"{"lastSeenVersion":1}"#).is_err());

        for key in ["imageCacheMaxMb", "tourCompleted", "lastSeenVersion"] {
            assert!(
                !crate::backup::APP_SETTING_KEYS.contains(&key),
                "{key} is machine-local and must not be exported"
            );
        }
    }

    /// Every key `backup.export` / `backup.import` carry is a real top-level
    /// settings field (a typo would silently drop the value), listed once.
    #[test]
    fn backup_app_setting_keys_name_settings_fields() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        let keys = crate::backup::APP_SETTING_KEYS;
        for k in keys {
            assert!(v.get(k).is_some(), "APP_SETTING_KEYS has unknown field {k}");
        }
        let unique: std::collections::BTreeSet<_> = keys.iter().collect();
        assert_eq!(unique.len(), keys.len(), "APP_SETTING_KEYS has duplicates");
        for k in ["accent", "oledBlack", "density", "uiScale", "zapBanner"] {
            assert!(keys.contains(&k), "{k} round-trips through backups (C1)");
        }
    }

    #[test]
    fn parental_and_watchlist_wire_shapes() {
        assert_eq!(
            serde_json::to_value(ParentalStatus::default()).unwrap(),
            serde_json::json!({
                "enabled": false, "mode": "hide", "autoAdult": true, "unlockMinutes": 15,
                "unlocked": false, "failedAttempts": 0
            }),
            "optional fields are omitted, defaults follow C2"
        );
        let locked_out = ParentalStatus {
            enabled: true,
            unlocked_until: Some("2026-10-13T10:00:00Z".into()),
            failed_attempts: 5,
            retry_after_seconds: Some(30),
            ..ParentalStatus::default()
        };
        let v = serde_json::to_value(&locked_out).unwrap();
        assert_eq!(v["unlockedUntil"], "2026-10-13T10:00:00Z");
        assert_eq!(v["retryAfterSeconds"], 30);
        assert_eq!(
            serde_json::from_value::<ParentalStatus>(v).unwrap(),
            locked_out
        );

        let lock = ParentalLock {
            source_id: "s1".into(),
            content_type: ContentType::Live,
            kind: ParentalLockKind::Category,
            target_id: "c9".into(),
            name: "Night".into(),
            created_at: "2026-10-13T08:00:00Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&lock).unwrap(),
            serde_json::json!({
                "sourceId": "s1", "contentType": "live", "kind": "category",
                "targetId": "c9", "name": "Night", "createdAt": "2026-10-13T08:00:00Z"
            })
        );
        let target: ParentalLockTarget = serde_json::from_value(serde_json::json!({
            "sourceId": "s1", "contentType": "movie", "kind": "item", "targetId": "7", "name": "Heat"
        }))
        .unwrap();
        assert_eq!(target.kind, ParentalLockKind::Item);

        let entry = WatchlistEntry {
            item_ref: ItemRef::new("s1", ContentType::Series, "42"),
            snapshot: ItemSnapshot {
                title: "Dark".into(),
                subtitle: None,
                poster_url: None,
                content_type: ContentType::Series,
            },
            added_at: "2026-10-13T08:00:00Z".into(),
            watched: false,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["ref"]["itemId"], "42");
        assert_eq!(v["snapshot"]["contentType"], "series");
        assert_eq!(v["addedAt"], "2026-10-13T08:00:00Z");
        assert_eq!(v["watched"], false);
        assert_eq!(serde_json::from_value::<WatchlistEntry>(v).unwrap(), entry);
    }

    // -----------------------------------------------------------------------
    // Parity with `src/api/types.ts`
    // -----------------------------------------------------------------------

    fn types_ts() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/api/types.ts");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
    }

    /// The text after `marker` up to the bracket that closes the first `open`.
    fn ts_block<'a>(text: &'a str, marker: &str, open: char, close: char) -> &'a str {
        let start = text
            .find(marker)
            .unwrap_or_else(|| panic!("{marker} not found in types.ts"));
        let body = &text[start..];
        let first = body.find(open).expect("opening bracket");
        let mut depth = 0;
        for (i, c) in body[first..].char_indices() {
            if c == open {
                depth += 1;
            } else if c == close {
                depth -= 1;
                if depth == 0 {
                    return &body[first..=first + i];
                }
            }
        }
        panic!("{marker}: unbalanced brackets");
    }

    /// Converts a TypeScript object or array literal (comments, single-quoted
    /// strings, bare keys, trailing commas) to JSON.
    fn ts_literal_to_json(src: &str) -> serde_json::Value {
        enum Tok {
            Punct(char),
            Str(String),
            Word(String),
        }
        let chars: Vec<char> = src.chars().collect();
        let mut toks = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            match c {
                '/' if chars.get(i + 1) == Some(&'/') => {
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                }
                '/' if chars.get(i + 1) == Some(&'*') => {
                    i += 2;
                    while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                        i += 1;
                    }
                    i += 2;
                }
                '\'' | '"' => {
                    let mut s = String::new();
                    i += 1;
                    while chars[i] != c {
                        if chars[i] == '\\' {
                            i += 1;
                        }
                        s.push(chars[i]);
                        i += 1;
                    }
                    i += 1;
                    toks.push(Tok::Str(s));
                }
                '{' | '}' | '[' | ']' | ':' | ',' => {
                    toks.push(Tok::Punct(c));
                    i += 1;
                }
                c if c.is_whitespace() => i += 1,
                _ => {
                    let mut w = String::new();
                    while i < chars.len()
                        && (chars[i].is_alphanumeric() || "_$.+-".contains(chars[i]))
                    {
                        w.push(chars[i]);
                        i += 1;
                    }
                    assert!(
                        !w.is_empty(),
                        "unexpected character {:?} in TS literal",
                        chars[i]
                    );
                    toks.push(Tok::Word(w));
                }
            }
        }
        let mut out = String::new();
        for (n, t) in toks.iter().enumerate() {
            let is_key = matches!(toks.get(n + 1), Some(Tok::Punct(':')));
            match t {
                Tok::Punct(c @ ('}' | ']')) => {
                    if out.ends_with(',') {
                        out.pop();
                    }
                    out.push(*c);
                }
                Tok::Punct(c) => out.push(*c),
                Tok::Str(s) => out.push_str(&serde_json::to_string(s).unwrap()),
                Tok::Word(w) if is_key => out.push_str(&serde_json::to_string(w).unwrap()),
                Tok::Word(w) => out.push_str(w),
            }
        }
        serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}"))
    }

    /// Integers and floats compare by value (`0` in TS, `0.0` in Rust).
    fn numbers_as_f64(v: serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match v {
            Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap())
                .map(Value::Number)
                .unwrap(),
            Value::Array(a) => Value::Array(a.into_iter().map(numbers_as_f64).collect()),
            Value::Object(o) => {
                Value::Object(o.into_iter().map(|(k, v)| (k, numbers_as_f64(v))).collect())
            }
            other => other,
        }
    }

    /// Property names of a TS interface (one property per line).
    fn ts_interface_keys(text: &str, name: &str) -> std::collections::BTreeSet<String> {
        let block = ts_block(text, &format!("export interface {name} {{"), '{', '}');
        block
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.starts_with("//") && !l.starts_with('*') && !l.starts_with("/*"))
            .filter_map(|l| {
                let key = l.split([':', '?']).next()?.trim();
                (!key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_'))
                    .then(|| key.to_string())
            })
            .collect()
    }

    fn json_keys(v: &serde_json::Value) -> std::collections::BTreeSet<String> {
        v.as_object().unwrap().keys().cloned().collect()
    }

    /// `DEFAULT_SETTINGS` in types.ts says it equals `Settings::default()`;
    /// this keeps that true.
    #[test]
    fn ts_default_settings_equal_rust_defaults() {
        let text = types_ts();
        let ts = ts_literal_to_json(ts_block(
            &text,
            "export const DEFAULT_SETTINGS: Settings = {",
            '{',
            '}',
        ));
        let rust = serde_json::to_value(Settings::default()).unwrap();
        let (ts, rust) = (numbers_as_f64(ts), numbers_as_f64(rust));
        if ts != rust {
            let (tk, rk) = (json_keys(&ts), json_keys(&rust));
            let differing: Vec<&String> = tk
                .intersection(&rk)
                .filter(|k| ts[k.as_str()] != rust[k.as_str()])
                .collect();
            panic!(
                "DEFAULT_SETTINGS differs from Settings::default(): only in TS {:?}; only in Rust {:?}; different values {differing:?}",
                tk.difference(&rk).collect::<Vec<_>>(),
                rk.difference(&tk).collect::<Vec<_>>(),
            );
        }
    }

    /// The TS `Settings` and `DashboardRails` interfaces name exactly the
    /// fields Rust serializes (optional ones included).
    #[test]
    fn ts_settings_interfaces_match_rust_fields() {
        let text = types_ts();
        let full = Settings {
            last_route: Some("/".into()),
            mpv_path: Some("mpv".into()),
            vlc_path: Some("vlc".into()),
            downloads_dir: Some("d".into()),
            recordings_dir: Some("r".into()),
            ..Settings::default()
        };
        let v = serde_json::to_value(&full).unwrap();
        assert_eq!(ts_interface_keys(&text, "Settings"), json_keys(&v));
        assert_eq!(
            ts_interface_keys(&text, "DashboardRails"),
            json_keys(&v["dashboardRails"])
        );
    }

    /// `Accent`, `Density`, `ACCENTS`, `DENSITIES` and the uiScale bounds in
    /// types.ts match the Rust enums and `settings::UI_SCALE_RANGE`.
    #[test]
    fn ts_appearance_values_match_rust() {
        let text = types_ts();
        let union = |name: &str| -> Vec<String> {
            let start = text
                .find(&format!("export type {name} = "))
                .unwrap_or_else(|| panic!("type {name} not found"));
            let line = text[start..].lines().next().unwrap();
            line.split('\'')
                .skip(1)
                .step_by(2)
                .map(String::from)
                .collect()
        };
        let list = |marker: &str| -> Vec<String> {
            let v = ts_literal_to_json(ts_block(&text, marker, '[', ']'));
            serde_json::from_value(v).unwrap()
        };
        let accents: Vec<String> = Accent::ALL.iter().map(|a| a.as_str().into()).collect();
        let densities: Vec<String> = Density::ALL.iter().map(|d| d.as_str().into()).collect();
        assert_eq!(union("Accent"), accents);
        assert_eq!(union("Density"), densities);
        assert_eq!(list("export const ACCENTS = ["), accents);
        assert_eq!(list("export const DENSITIES = ["), densities);
        let constant = |name: &str| -> f64 {
            let start = text
                .find(&format!("export const {name} = "))
                .unwrap_or_else(|| panic!("{name} not found"));
            let line = text[start..].lines().next().unwrap();
            line.split('=')
                .nth(1)
                .unwrap()
                .trim()
                .trim_end_matches(';')
                .parse()
                .unwrap()
        };
        let range = crate::settings::UI_SCALE_RANGE;
        assert_eq!(constant("UI_SCALE_MIN"), *range.start());
        assert_eq!(constant("UI_SCALE_MAX"), *range.end());
        assert_eq!(union("ParentalMode"), ["hide", "ask"]);
        assert_eq!(union("ParentalLockKind"), ["category", "item"]);
        // subtitles:
        let names = |all: Vec<&str>| -> Vec<String> { all.into_iter().map(String::from).collect() };
        let sizes = names(SubtitleSize::ALL.iter().map(|v| v.as_str()).collect());
        let colors = names(SubtitleColor::ALL.iter().map(|v| v.as_str()).collect());
        let backgrounds = names(SubtitleBackground::ALL.iter().map(|v| v.as_str()).collect());
        assert_eq!(union("SubtitleSize"), sizes);
        assert_eq!(union("SubtitleColor"), colors);
        assert_eq!(union("SubtitleBackground"), backgrounds);
        assert_eq!(list("export const SUBTITLE_SIZES = ["), sizes);
        assert_eq!(list("export const SUBTITLE_COLORS = ["), colors);
        assert_eq!(list("export const SUBTITLE_BACKGROUNDS = ["), backgrounds);
        let position = crate::settings::SUBTITLE_POSITION_RANGE;
        assert_eq!(
            constant("SUBTITLE_POSITION_MIN"),
            f64::from(*position.start())
        );
        assert_eq!(
            constant("SUBTITLE_POSITION_MAX"),
            f64::from(*position.end())
        );
        // Run 3: image cache cap and the lastSeenVersion length.
        let cap = crate::settings::IMAGE_CACHE_MAX_MB_RANGE;
        assert_eq!(constant("IMAGE_CACHE_MAX_MB_MIN"), f64::from(*cap.start()));
        assert_eq!(constant("IMAGE_CACHE_MAX_MB_MAX"), f64::from(*cap.end()));
        assert_eq!(
            constant("LAST_SEEN_VERSION_MAX_LENGTH"),
            crate::settings::LAST_SEEN_VERSION_MAX_LEN as f64
        );
    }

    #[test]
    fn camel_case_and_ref_rename() {
        let ch = Channel {
            item_ref: ItemRef::new("s1", ContentType::Live, "abc"),
            name: "BBC One".into(),
            number: Some(1),
            logo_url: None,
            category_id: "g".into(),
            category_name: "UK".into(),
            epg_channel_id: None,
            url: None,
            is_radio: false,
            archive: None,
            headers: None,
            catchup: None,
            clear_key: None,
        };
        let v = serde_json::to_value(&ch).unwrap();
        assert_eq!(v["ref"]["sourceId"], "s1");
        assert_eq!(v["ref"]["contentType"], "live");
        assert_eq!(v["categoryName"], "UK");
        assert!(v.get("logoUrl").is_none());
        assert_eq!(ch.item_ref.key(), "s1|live|abc");
    }

    #[test]
    fn secrets_are_redacted_in_debug() {
        let t = TmdbSettings {
            enabled: true,
            api_key: Some("supersecret".into()),
            language: None,
        };
        assert!(!format!("{t:?}").contains("supersecret"));
        let x = XtreamSourceConfig {
            server_url: "http://x".into(),
            username: "u".into(),
            password: "supersecret".into(),
            headers: Default::default(),
        };
        assert!(!format!("{x:?}").contains("supersecret"));
    }

    #[test]
    fn tmdb_movie_flattens_brief() {
        let m: TmdbMovie =
            serde_json::from_str(r#"{"tmdbId":1,"mediaType":"movie","title":"X","genres":["a"]}"#)
                .unwrap();
        assert_eq!(m.brief.tmdb_id, 1);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["title"], "X");
        assert_eq!(v["mediaType"], "movie");
    }
}
