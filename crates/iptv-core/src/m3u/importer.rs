//! M3U importer: fetch (URL / file / pasted text) -> streaming parse -> one
//! write transaction that rewrites the source's catalog, stores `m3u_raw`, and
//! records the header EPG URLs. A failure anywhere rolls the transaction back,
//! so the previous catalog survives a failed refresh.

use super::body::{sniff, too_large_error, MinRate, MAX_PLAYLIST_BYTES, SNIFF_BYTES};
use super::parser::{has_movie_extension, url_extension, M3uEntry, M3uReader};
use crate::catalog::{self, CatalogWriter, CategoryRow, ItemRow};
use crate::db::now_rfc3339;
use crate::error::{CoreError, CoreResult};
use crate::model::{
    ContentType, EpgLinks, ImportSummary, M3uOrigin, M3uSourceConfig, Source, SourceKind,
};
use crate::sources::{self, Importer, ProgressGate};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

/// Progress cadence (items) during parse + save; the events also pass a
/// [`ProgressGate`] (at most one per 250 ms).
pub const PROGRESS_EVERY: u64 = 2000;
/// Content types an m3u source owns (all rewritten on import).
pub const M3U_TYPES: [ContentType; 4] = [
    ContentType::Live,
    ContentType::Radio,
    ContentType::Movie,
    ContentType::Series,
];
/// Download attempts for a playlist URL (network errors and 5xx only).
pub const FETCH_ATTEMPTS: u32 = 3;
/// Read buffer for parsing files.
const READ_BUF: usize = 256 * 1024;
/// Largest playlist whose text is also stored inline in `m3u_raw.raw`.
/// Bigger file / URL playlists keep only the sha there (raw = '') and a copy
/// on disk at [`cached_playlist_path`], so an import never holds the whole
/// file in memory. Read the text with [`stored_text`].
pub const RAW_INLINE_MAX: u64 = 8 * 1024 * 1024;

/// On-disk copy of a large playlist (see [`RAW_INLINE_MAX`]).
pub fn cached_playlist_path(data_dir: &Path, source_id: &str) -> PathBuf {
    data_dir.join("playlists").join(format!("{source_id}.m3u"))
}

/// Stores playlist text that arrived in memory (a backup restore) the way an
/// import stores a downloaded playlist: inline when it fits in
/// [`RAW_INLINE_MAX`], otherwise written to [`cached_playlist_path`].
/// Returns what belongs in `m3u_raw.raw`: the text itself, or `""` when it
/// went to disk. The write goes through a temp file and a rename, so a
/// failure never leaves a truncated copy behind.
pub fn place_raw_text<'a>(data_dir: &Path, source_id: &str, text: &'a str) -> CoreResult<&'a str> {
    if text.len() as u64 <= RAW_INLINE_MAX {
        return Ok(text);
    }
    let dest = cached_playlist_path(data_dir, source_id);
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = dest.with_extension("m3u.part");
    std::fs::write(&part, text.as_bytes())
        .and_then(|()| std::fs::rename(&part, &dest))
        .map_err(|e| {
            let _ = std::fs::remove_file(&part);
            CoreError::Io(std::io::Error::new(
                e.kind(),
                format!("cannot store the playlist at {}: {e}", dest.display()),
            ))
        })?;
    Ok("")
}

/// Deletes the on-disk playlist copy of a source, if any.
pub fn remove_cached_playlist(state: &AppState, source_id: &str) {
    let p = cached_playlist_path(&state.data_dir, source_id);
    if let Err(err) = std::fs::remove_file(&p) {
        if err.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%err, source_id, "could not remove cached playlist copy");
        }
    }
}

/// The stored playlist of a source: `(text, sha256, fetched_at)`. The text
/// comes from `m3u_raw.raw`, or from the on-disk copy when the playlist was
/// too large to store inline. `None` when the source was never imported.
pub fn stored_text(
    conn: &Connection,
    data_dir: &Path,
    source_id: &str,
) -> CoreResult<Option<(String, String, String)>> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT raw, sha256, fetched_at FROM m3u_raw WHERE source_id = ?1",
            [source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((raw, sha, fetched_at)) = row else {
        return Ok(None);
    };
    if !raw.is_empty() {
        return Ok(Some((raw, sha, fetched_at)));
    }
    let cached = cached_playlist_path(data_dir, source_id);
    if cached.is_file() {
        return Ok(Some((read_text_lossy(&cached)?, sha, fetched_at)));
    }
    Ok(Some((raw, sha, fetched_at)))
}

/// Version of the parse + classify rules. It is hashed into every stored
/// playlist sha ([`playlist_hasher`]), so bumping it makes the next refresh of
/// every M3U source (URL, file and pasted text) re-import an unchanged
/// playlist once and pick up parser and classifier fixes. Bump it whenever a
/// change alters the rows an import writes.
pub const IMPORT_VERSION: u32 = 2;

/// sha256 state for a playlist body, seeded with [`IMPORT_VERSION`]. Every
/// `m3u_raw.sha256` is computed this way (64 hex chars).
pub fn playlist_hasher() -> Sha256 {
    let mut h = Sha256::new();
    h.update(format!("tsrust-m3u-import-v{IMPORT_VERSION}\n").as_bytes());
    h
}

/// The stored sha of a playlist body (see [`playlist_hasher`]).
pub fn playlist_sha(bytes: &[u8]) -> String {
    let mut h = playlist_hasher();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// First 16 hex chars of sha256(s).
pub fn hash16(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    hex::encode(&d[..8])
}

/// m3u item id: 16 hex chars of sha256(url + '\n' + name) (C2).
pub fn item_id(url: &str, name: &str) -> String {
    let mut h = Sha256::new();
    h.update(url.as_bytes());
    h.update(b"\n");
    h.update(name.as_bytes());
    hex::encode(&h.finalize()[..8])
}

/// m3u category id: 16 hex chars of sha256(group name) (C4 m3u notes).
pub fn group_id(group: &str) -> String {
    hash16(group)
}

/// Content type of an entry: `radio="true"` -> radio; an Xtream-style
/// `/movie/` or `/series/` URL path (the `get.php?type=m3u_plus` shape) or a
/// file-only container (`.mkv`, `.avi`, `.mov`, `.m4v`) -> movie, whatever the
/// group; an `.mp4` URL in a group whose title mentions movie / vod / film ->
/// movie (`.mp4` alone is ambiguous: looping live channels use it too); else
/// live. Series episodes are movies until M3U series grouping exists.
pub fn classify(e: &M3uEntry) -> ContentType {
    if e.radio {
        return ContentType::Radio;
    }
    let path = url_path_lower(&e.url);
    if path.contains("/movie/") || path.contains("/series/") {
        return ContentType::Movie;
    }
    if [".mkv", ".avi", ".mov", ".m4v"]
        .iter()
        .any(|ext| path.ends_with(ext))
    {
        return ContentType::Movie;
    }
    if has_movie_extension(&e.url) {
        let g = e.group.as_deref().unwrap_or("").to_lowercase();
        if g.contains("movie") || g.contains("vod") || g.contains("film") {
            return ContentType::Movie;
        }
    }
    ContentType::Live
}

/// The lowercased path of a stream URL (no scheme, host, query or fragment).
fn url_path_lower(url: &str) -> String {
    let no_query = url.split(['?', '#']).next().unwrap_or(url);
    let after_scheme = no_query
        .split_once("://")
        .map_or(no_query, |(_, rest)| rest);
    let path = after_scheme.find('/').map_or("", |i| &after_scheme[i..]);
    path.to_ascii_lowercase()
}

/// Turns parser entries into catalog rows: stable ids (with a suffix for exact
/// duplicates), categories in first-seen order per content type, channel
/// numbers (tvg-chno, else one running index shared by live and radio, so a
/// radio number never repeats a live one).
pub struct RowBuilder {
    source_id: String,
    seen_ids: HashSet<String>,
    /// Group name -> [`group_id`].
    group_ids: HashMap<String, String>,
    categories: HashMap<ContentType, (Vec<CategoryRow>, HashSet<String>)>,
    channel_counter: i64,
    position: i64,
}

impl RowBuilder {
    pub fn new(source_id: &str) -> Self {
        Self {
            source_id: source_id.to_string(),
            seen_ids: HashSet::new(),
            group_ids: HashMap::new(),
            categories: HashMap::new(),
            channel_counter: 0,
            position: 0,
        }
    }

    pub fn row(&mut self, e: M3uEntry) -> ItemRow {
        let ct = classify(&e);
        let mut id = item_id(&e.url, &e.name);
        if self.seen_ids.contains(&id) {
            let mut n = 2u32;
            loop {
                let candidate = hash16(&format!("{}\n{}\n#{n}", e.url, e.name));
                if !self.seen_ids.contains(&candidate) {
                    id = candidate;
                    break;
                }
                n += 1;
            }
        }
        self.seen_ids.insert(id.clone());

        let group = e.group.as_deref().unwrap_or("");
        // One sha256 per group, not per entry (IN-10).
        let cat_id = match self.group_ids.get(group) {
            Some(id) => id.clone(),
            None => {
                let id = group_id(group);
                self.group_ids.insert(group.to_string(), id.clone());
                id
            }
        };
        let (cats, cat_ids) = self.categories.entry(ct).or_default();
        if !cat_ids.contains(&cat_id) {
            cat_ids.insert(cat_id.clone());
            let name = if group.trim().is_empty() {
                catalog::FALLBACK_CATEGORY_NAME.to_string()
            } else {
                group.to_string()
            };
            cats.push(CategoryRow {
                category_id: cat_id.clone(),
                name,
                position: cats.len() as i64,
            });
        }

        let number = match ct {
            ContentType::Live | ContentType::Radio => {
                self.channel_counter += 1;
                Some(e.tvg_chno.unwrap_or(self.channel_counter))
            }
            _ => None,
        };

        let mut extra = serde_json::Map::new();
        if let Some(v) = &e.tvg_name {
            extra.insert("tvgName".into(), v.clone().into());
        }
        if let Some(v) = &e.tvg_shift {
            extra.insert("tvgShift".into(), v.clone().into());
        }
        let has_catchup = e.catchup.is_some() || e.catchup_source.is_some();
        let catchup_type = e
            .catchup
            .as_deref()
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "default".into());
        let catchup_ok = has_catchup && catalog::catchup_usable(&catchup_type);
        if has_catchup {
            let mut c = serde_json::Map::new();
            c.insert("type".into(), catchup_type.into());
            if let Some(d) = e.catchup_days {
                c.insert("days".into(), d.into());
            }
            if let Some(s) = &e.catchup_source {
                c.insert("source".into(), s.clone().into());
            }
            extra.insert("catchup".into(), c.into());
        }
        if e.user_agent.is_some() || e.referrer.is_some() || e.origin.is_some() {
            let mut h = serde_json::Map::new();
            if let Some(v) = &e.user_agent {
                h.insert("userAgent".into(), v.clone().into());
            }
            if let Some(v) = &e.referrer {
                h.insert("referrer".into(), v.clone().into());
            }
            if let Some(v) = &e.origin {
                h.insert("origin".into(), v.clone().into());
            }
            extra.insert("headers".into(), h.into());
        }
        if !e.vlc_opts.is_empty() {
            let m: serde_json::Map<String, serde_json::Value> = e
                .vlc_opts
                .iter()
                .map(|(k, v)| (k.clone(), v.clone().into()))
                .collect();
            extra.insert("vlcOpts".into(), m.into());
        }
        if !e.kodi_props.is_empty() {
            let m: serde_json::Map<String, serde_json::Value> = e
                .kodi_props
                .iter()
                .map(|(k, v)| (k.clone(), v.clone().into()))
                .collect();
            extra.insert("kodiProps".into(), m.into());
        }

        let (title_base, year) = if ct == ContentType::Movie {
            let (b, y) = catalog::title_base(&e.name);
            (Some(b), y)
        } else {
            (None, None)
        };
        let archive_hours = if catchup_ok {
            // Clamped: `catchup-days="9223372036854775807"` overflowed `* 24`.
            e.catchup_days
                .and_then(crate::xtream::meta::archive_days_to_hours)
        } else {
            None
        };
        let position = self.position;
        self.position += 1;
        let container_extension = if ct == ContentType::Movie {
            url_extension(&e.url)
        } else {
            None
        };

        ItemRow {
            source_id: self.source_id.clone(),
            content_type: ct,
            item_id: id,
            category_id: cat_id,
            title: e.name,
            title_base,
            number,
            logo_url: if ct == ContentType::Movie {
                None
            } else {
                e.tvg_logo.clone()
            },
            poster_url: if ct == ContentType::Movie {
                e.tvg_logo
            } else {
                None
            },
            backdrop_url: None,
            rating: None,
            added: None,
            year,
            epg_channel_id: e.tvg_id,
            url: Some(e.url),
            container_extension,
            is_radio: ct == ContentType::Radio,
            archive_hours,
            extra: serde_json::Value::Object(extra),
            position,
        }
    }

    /// Categories per content type, in first-seen order.
    pub fn categories(&self) -> Vec<(ContentType, Vec<CategoryRow>)> {
        M3U_TYPES
            .iter()
            .map(|ct| {
                (
                    *ct,
                    self.categories
                        .get(ct)
                        .map(|(v, _)| v.clone())
                        .unwrap_or_default(),
                )
            })
            .collect()
    }

    /// The categories of `ct` after the first `from`, in first-seen order.
    pub fn categories_from(&self, ct: ContentType, from: usize) -> &[CategoryRow] {
        self.categories
            .get(&ct)
            .and_then(|(v, _)| v.get(from..))
            .unwrap_or_default()
    }
}

/// Where the playlist bytes are for one import.
enum Payload {
    /// A file on disk: the user's file (`temp: false`) or a downloaded temp
    /// file that may be moved into the playlist cache (`temp: true`).
    File { path: PathBuf, temp: bool },
    /// Pasted text (already stored in `m3u_raw`).
    Text(String),
}

/// Deletes the downloaded temp file on drop.
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        if self.0.exists() {
            if let Err(err) = std::fs::remove_file(&self.0) {
                tracing::warn!(%err, file = %self.0.display(), "could not remove temporary playlist file");
            }
        }
    }
}

/// The m3u [`Importer`] registered by `m3u::init`.
pub struct M3uImporter;

#[async_trait::async_trait]
impl Importer for M3uImporter {
    fn kind(&self) -> SourceKind {
        SourceKind::M3u
    }

    async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary> {
        import_source(state, source).await
    }
}

fn file_path_of(cfg: &M3uSourceConfig) -> CoreResult<PathBuf> {
    match cfg.origin {
        M3uOrigin::File => cfg
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                CoreError::Invalid(
                    "this playlist has no file path; edit the source and choose a file".into(),
                )
            }),
        M3uOrigin::Url => {
            let url = cfg.url.as_deref().unwrap_or("").trim();
            let parsed = url::Url::parse(url)
                .map_err(|e| CoreError::Invalid(format!("invalid playlist URL: {e}")))?;
            parsed
                .to_file_path()
                .map_err(|_| CoreError::Invalid("invalid file:// playlist URL".into()))
        }
        M3uOrigin::Text => Err(CoreError::Invalid("text playlists have no file".into())),
    }
}

fn is_file_url(cfg: &M3uSourceConfig) -> bool {
    cfg.origin == M3uOrigin::Url
        && cfg
            .url
            .as_deref()
            .map(|u| u.trim().to_ascii_lowercase().starts_with("file://"))
            .unwrap_or(false)
}

/// Server mode never reads playlists from the server's disk: the path comes
/// from the browser, so it would expose any readable file.
fn refuse_server_files(state: &AppState) -> CoreResult<()> {
    if crate::http::is_server_mode(state) {
        return Err(CoreError::Unsupported(SERVER_FILE_MESSAGE.into()));
    }
    Ok(())
}

/// Why file playlists are refused in server mode.
pub const SERVER_FILE_MESSAGE: &str = "Playlist files on the server's disk cannot be opened from the browser. Upload the playlist text instead.";

/// Full m3u import for `source` (see module docs).
pub async fn import_source(state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary> {
    let cfg = source
        .m3u
        .clone()
        .ok_or_else(|| CoreError::Invalid("source has no m3u configuration".into()))?;
    let source_id = source.id.clone();
    let _tmp_guard;
    // A downloaded body, and its HTTP validators (stored once it is in).
    let mut fetched = false;
    let mut validators: Option<Validators> = None;

    // 1. Acquire bytes + sha256.
    let (payload, sha) = match cfg.origin {
        M3uOrigin::Text => {
            let missing = || {
                CoreError::Invalid(
                    "the pasted playlist text is missing; edit the source and paste it again"
                        .into(),
                )
            };
            // The text is hashed like a download (with IMPORT_VERSION), so the
            // unchanged check below re-imports it once after a parser change.
            let sid = source_id.clone();
            let raw = state
                .db_call(move |c| {
                    Ok(c.query_row(
                        "SELECT raw FROM m3u_raw WHERE source_id = ?1",
                        [&sid],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?)
                })
                .await?
                .ok_or_else(missing)?;
            // A large pasted / restored playlist lives on disk (raw = '').
            let cached = cached_playlist_path(&state.data_dir, &source_id);
            if raw.is_empty() && cached.is_file() {
                let sha = hash_file(cached.clone()).await?;
                (
                    Payload::File {
                        path: cached,
                        temp: false,
                    },
                    sha,
                )
            } else {
                let sha = playlist_sha(raw.as_bytes());
                (Payload::Text(raw), sha)
            }
        }
        M3uOrigin::File => {
            refuse_server_files(&state)?;
            let path = file_path_of(&cfg)?;
            let sha = hash_file(path.clone()).await?;
            (Payload::File { path, temp: false }, sha)
        }
        M3uOrigin::Url if is_file_url(&cfg) => {
            refuse_server_files(&state)?;
            let path = file_path_of(&cfg)?;
            let sha = hash_file(path.clone()).await?;
            (Payload::File { path, temp: false }, sha)
        }
        M3uOrigin::Url => {
            let url = cfg.url.clone().unwrap_or_default();
            let tmp_dir = state.data_dir.join("tmp");
            tokio::fs::create_dir_all(&tmp_dir).await?;
            let tmp = tmp_dir.join(format!(
                "m3u-{}-{}.part",
                source_id,
                uuid::Uuid::new_v4().simple()
            ));
            _tmp_guard = TempFile(tmp.clone());
            // The last body's ETag / Last-Modified, when that body is the
            // imported one: the server may answer 304 instead (ST-3).
            let known = if source.last_refresh_at.is_some() {
                let sid = source_id.clone();
                state
                    .db_call(move |c| stored_validators(c, &sid))
                    .await?
                    .filter(|v| v.url == url)
            } else {
                None
            };
            match fetch_conditional(&state, &source_id, &url, &cfg, &tmp, known.as_ref()).await? {
                Download::NotModified => {
                    tracing::info!(%source_id, "playlist not modified (HTTP 304)");
                    return keep_unchanged(&state, &source_id).await;
                }
                Download::Body {
                    sha,
                    etag,
                    last_modified,
                } => {
                    validators = (etag.is_some() || last_modified.is_some()).then(|| Validators {
                        url,
                        sha: sha.clone(),
                        version: IMPORT_VERSION,
                        etag,
                        last_modified,
                    });
                    fetched = true;
                    (
                        Payload::File {
                            path: tmp,
                            temp: true,
                        },
                        sha,
                    )
                }
            }
        }
    };

    // 2. Unchanged since the last successful import: keep the catalog.
    let sid = source_id.clone();
    let prev_sha: Option<String> = state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT sha256 FROM m3u_raw WHERE source_id = ?1",
                [&sid],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await?;
    if source.last_refresh_at.is_some() && prev_sha.as_deref() == Some(sha.as_str()) {
        let summary = keep_unchanged(&state, &source_id).await?;
        if fetched {
            save_validators(&state, &source_id, validators).await;
        }
        return Ok(summary);
    }

    // A remove or a settings change cancelled this import while it was
    // downloading: do not write a catalog for it.
    if sources::import_cancel().is_some_and(|t| t.is_cancelled()) {
        return Err(sources::import_cancelled_error());
    }

    // 3. Parse + write in one transaction on the blocking pool, one import
    // at a time (ST-2); the slot is held until the write ends.
    let slot = sources::save_slot(&state).await?;
    sources::progress(&state, &source_id, "parsing", 0, None, None);
    let st = state.clone();
    let pool = state.db.clone();
    let origin = cfg.origin;
    // This run's cancel token, taken here (task-local) before waiting for the
    // write lock: if that wait outlasts CANCEL_GRACE, the run is dropped and
    // its writer token unregistered, so a token looked up later would be
    // missing and the cancelled import would commit. The DB-keyed writer
    // token is only a fallback for callers outside a run.
    let run_cancel = sources::import_cancel();
    let sid = source_id.clone();
    let summary = tokio::task::spawn_blocking(move || -> CoreResult<ImportSummary> {
        let _slot = slot;
        let mut conn = pool.get()?;
        let cancel = run_cancel.or_else(|| sources::writer_cancel_token(&conn, &sid));
        write_catalog(&st, &mut conn, &sid, payload, &sha, origin, cancel)
    })
    .await?
    .map_err(|e| state.note_db_error(e))?;
    if fetched {
        save_validators(&state, &source_id, validators).await;
    }
    Ok(summary)
}

/// `app_state` key of a URL source's [`Validators`] (dropped with the
/// source, see `sources::store::delete`).
fn validators_key(source_id: &str) -> String {
    format!("m3u_validators:{source_id}")
}

/// The HTTP validators of the last downloaded playlist body (ST-3).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Validators {
    /// The playlist URL they came from.
    url: String,
    /// The body's [`playlist_sha`].
    sha: String,
    /// [`IMPORT_VERSION`] when the body was imported.
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
}

/// The stored validators, when they belong to the imported body (its sha
/// is `m3u_raw.sha256`) and to this [`IMPORT_VERSION`]: after a parser
/// change the body has to be fetched and imported again.
fn stored_validators(conn: &Connection, source_id: &str) -> CoreResult<Option<Validators>> {
    let stored: Option<Validators> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [validators_key(source_id)],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| serde_json::from_str(&v).ok());
    let Some(stored) = stored else {
        return Ok(None);
    };
    let sha: Option<String> = conn
        .query_row(
            "SELECT sha256 FROM m3u_raw WHERE source_id = ?1",
            [source_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok((stored.version == IMPORT_VERSION && sha.as_deref() == Some(stored.sha.as_str()))
        .then_some(stored))
}

/// Stores the validators of a body that is now the imported one, or drops
/// them when its server sent none. A failure only costs a full download on
/// the next refresh.
async fn save_validators(state: &Arc<AppState>, source_id: &str, validators: Option<Validators>) {
    let sid = source_id.to_string();
    let result = state
        .db_call(move |c| {
            match validators {
                Some(v) => {
                    c.execute(
                        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        params![validators_key(&sid), serde_json::to_string(&v)?],
                    )?;
                }
                None => {
                    c.execute(
                        "DELETE FROM app_state WHERE key = ?1",
                        [validators_key(&sid)],
                    )?;
                }
            }
            Ok(())
        })
        .await;
    if let Err(err) = result {
        tracing::warn!(%err, source_id, "could not store the playlist validators");
    }
}

/// The playlist is unchanged since the last successful import: keeps the
/// catalog and only touches `fetched_at`.
async fn keep_unchanged(state: &Arc<AppState>, source_id: &str) -> CoreResult<ImportSummary> {
    let sid = source_id.to_string();
    let (channels, movies, series) = state
        .db_call(move |c| {
            c.execute(
                "UPDATE m3u_raw SET fetched_at = ?2 WHERE source_id = ?1",
                params![sid, now_rfc3339()],
            )?;
            catalog::source_counts(c, &sid)
        })
        .await?;
    tracing::info!(source_id, "playlist unchanged; catalog kept");
    sources::progress(
        state,
        source_id,
        "saving",
        0,
        None,
        Some(sources::UNCHANGED_MESSAGE),
    );
    Ok(ImportSummary {
        channels,
        movies,
        series,
        unchanged: true,
    })
}

/// Streams `payload` through the parser into the catalog inside one IMMEDIATE
/// transaction, then stores the raw text and detected EPG URLs.
///
/// `cancel` is the import run's token, taken by the caller before the
/// transaction: it is checked once the write lock is held, while parsing, and
/// right before the commit, so a cancelled run never commits (C8).
fn write_catalog(
    state: &AppState,
    conn: &mut Connection,
    source_id: &str,
    payload: Payload,
    sha: &str,
    origin: M3uOrigin,
    cancel: Option<tokio_util::sync::CancellationToken>,
) -> CoreResult<ImportSummary> {
    let check_cancel = || -> CoreResult<()> {
        if cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
            return Err(sources::import_cancelled_error());
        }
        Ok(())
    };
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    check_cancel()?;
    let mut builder = RowBuilder::new(source_id);
    let started = std::time::Instant::now();

    // Read before the writer deletes the old rows: lets user state follow
    // items whose id changed (token rotation) and tells a first import apart.
    let mut remapper = super::remap::Remapper::before(&tx, source_id)?;
    if remapper.old_rows > 0 {
        // The writer deletes the previous rows first (L3-perf-core-4).
        sources::progress_step(state, source_id, sources::SaveStep::Replacing, 0);
    }
    let (header, stats, summary) = {
        let mut writer = CatalogWriter::begin(&tx, source_id, &M3U_TYPES, cancel.clone())?;
        let reader: Box<dyn std::io::BufRead + '_> = match &payload {
            Payload::File { path: p, .. } => Box::new(BufReader::with_capacity(
                READ_BUF,
                std::fs::File::open(p).map_err(|e| file_error(p, e))?,
            )),
            Payload::Text(t) => Box::new(std::io::Cursor::new(t.as_bytes())),
        };
        let mut parser = M3uReader::new(reader);
        let mut n = 0u64;
        // Parse progress: every PROGRESS_EVERY rows, at most every 250 ms.
        let mut gate = ProgressGate::default();
        let mut reported = 0u64;
        // Categories already declared to the writer, per type: a row's group
        // is known before the row is written, so its verdict is final.
        let mut declared: HashMap<ContentType, usize> = HashMap::new();
        for entry in parser.by_ref() {
            let row = builder.row(entry);
            let seen = declared.entry(row.content_type).or_default();
            let new = builder.categories_from(row.content_type, *seen);
            if !new.is_empty() {
                writer.declare_categories(row.content_type, new);
                *seen += new.len();
            }
            if writer.insert(&row)? {
                remapper.saw(&row);
            }
            n += 1;
            if n % PROGRESS_EVERY == 0 {
                check_cancel()?;
                if gate.due(std::time::Instant::now()) {
                    sources::progress(state, source_id, "parsing", n, None, None);
                    reported = n;
                }
            }
        }
        if reported > 0 && reported != n {
            // The final count, whatever the gate skipped.
            sources::progress(state, source_id, "parsing", n, None, None);
        }
        if let Some(err) = parser.take_io_error() {
            return Err(CoreError::Io(err));
        }
        let stats = parser.stats();
        let header = parser.header().clone();
        if !stats.saw_header && stats.entries == 0 {
            return Err(CoreError::Invalid(
                "this is not an M3U playlist (no #EXTM3U header and no #EXTINF entries); check the URL or file".into(),
            ));
        }
        // A bare `#EXTM3U` (panels answer that during maintenance or after an
        // account lapses) must not wipe the catalog: returning here drops the
        // transaction, so the previous rows stay.
        if writer.inserted() == 0 {
            return Err(CoreError::Invalid(if remapper.old_rows > 0 {
                "The playlist came back empty; kept the previous channels. The provider may be down or the account may have expired; try again later.".into()
            } else {
                "The playlist is empty: it has no channels. Check the URL, or ask the provider whether the account is active.".into()
            }));
        }
        remapper.apply(&tx, source_id)?;
        // Every row is in: indexes, the search index and the counts follow.
        // Clients without the step show "Saving n of n", as before.
        sources::progress_step(state, source_id, sources::SaveStep::Indexing, n);
        let summary = ImportSummary {
            channels: (writer.inserted_of(ContentType::Live)
                + writer.inserted_of(ContentType::Radio)) as i64,
            movies: writer.inserted_of(ContentType::Movie) as i64,
            series: writer.inserted_of(ContentType::Series) as i64,
            unchanged: false,
        };
        writer.finish(&builder.categories())?;
        (header, stats, summary)
    };

    // Raw playlist (needed by m3u.raw, backups, and the unchanged check).
    // Small playlists are stored inline; large ones keep only the sha and an
    // on-disk copy, written after the commit (see RAW_INLINE_MAX).
    let now = now_rfc3339();
    let mut keep_copy: Option<(PathBuf, bool)> = None;
    match &payload {
        Payload::Text(_) => {
            tx.execute(
                "UPDATE m3u_raw SET sha256 = ?2, fetched_at = ?3 WHERE source_id = ?1",
                params![source_id, sha, now],
            )?;
        }
        Payload::File { path: p, temp } => {
            // The limit applies to the decoded text: a small gzip file can
            // unpack far past it (L1-core-17). A file already over the limit
            // is not read just to measure it, and neither is a gzip file the
            // parser already decoded past it (IN-6).
            let size = std::fs::metadata(p).map_err(|e| file_error(p, e))?.len();
            let text = if size <= RAW_INLINE_MAX && stats.bytes <= RAW_INLINE_MAX {
                Some(read_text_lossy(p)?)
            } else {
                None
            };
            let raw = match text {
                Some(text) if text.len() as u64 <= RAW_INLINE_MAX => text,
                _ => {
                    keep_copy = Some((p.clone(), *temp));
                    String::new()
                }
            };
            tx.execute(
                "INSERT INTO m3u_raw (source_id, raw, sha256, fetched_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(source_id) DO UPDATE SET raw = excluded.raw, sha256 = excluded.sha256, fetched_at = excluded.fetched_at",
                params![source_id, raw, sha, now],
            )?;
        }
    }

    // Header EPG URLs -> detectedUrls (manual / disabled lists untouched).
    let epg_json: Option<String> = tx
        .query_row(
            "SELECT epg_json FROM sources WHERE id = ?1",
            [source_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(epg_json) = epg_json else {
        return Err(CoreError::NotFound(
            "the source was removed during import".into(),
        ));
    };
    let mut epg: EpgLinks = serde_json::from_str(&epg_json).unwrap_or_default();
    if epg.detected_urls != header.epg_urls {
        epg.detected_urls = header.epg_urls.clone();
        tx.execute(
            "UPDATE sources SET epg_json = ?2 WHERE id = ?1",
            params![source_id, serde_json::to_string(&epg)?],
        )?;
    }
    // Last check: a cancelled run never commits.
    check_cancel()?;
    tx.commit()?;
    // The catalog rewrite grew the WAL by about the catalog's size: fold it
    // back so it does not stay hundreds of MB (never waits on a busy reader).
    crate::db::checkpoint_truncate(conn);
    let cache = cached_playlist_path(&state.data_dir, source_id);
    match keep_copy {
        // Already the cached copy (a large text playlist): nothing to move.
        Some((p, _)) if p == cache => {}
        Some((p, temp)) => {
            if let Err(err) = store_copy(&p, &cache, temp) {
                tracing::warn!(%err, source_id, "could not keep a copy of the playlist; m3u.raw will be empty");
            }
        }
        None => remove_cached_playlist(state, source_id),
    }
    tracing::info!(
        source_id,
        origin = origin.as_str(),
        entries = stats.entries,
        skipped = stats.skipped,
        lines = stats.lines,
        ms = started.elapsed().as_millis() as u64,
        "m3u import complete"
    );
    if stats.skipped > 0 {
        tracing::warn!(
            source_id,
            skipped = stats.skipped,
            "m3u lines skipped (no URL, junk, or overlong)"
        );
    }
    Ok(summary)
}

/// Moves (downloaded temp file) or copies (user file) `src` to `dest`
/// without reading it into memory.
fn store_copy(src: &Path, dest: &Path, temp: bool) -> std::io::Result<()> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if temp && std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest).map(|_| ())
}

fn file_error(p: &Path, e: std::io::Error) -> CoreError {
    match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::NotFound(format!(
            "playlist file not found: {}; choose the file again",
            p.display()
        )),
        _ => CoreError::Io(std::io::Error::new(
            e.kind(),
            format!("cannot read playlist file {}: {e}", p.display()),
        )),
    }
}

/// Reads a file as text, replacing invalid UTF-8 and dropping a leading BOM.
fn read_text_lossy(p: &Path) -> CoreResult<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(p)
        .map_err(|e| file_error(p, e))?
        .read_to_end(&mut bytes)?;
    // Decoded like the parser reads it (UTF-16, UTF-8 BOM, Windows-1252
    // lines), so the stored raw text matches the imported catalog.
    Ok(crate::m3u::parser::decode_playlist_text(bytes))
}

/// sha256 of a file, streamed.
async fn hash_file(path: PathBuf) -> CoreResult<String> {
    tokio::task::spawn_blocking(move || -> CoreResult<String> {
        let mut f = std::fs::File::open(&path).map_err(|e| file_error(&path, e))?;
        if !f.metadata()?.is_file() {
            return Err(CoreError::Invalid(format!(
                "{} is not a file",
                path.display()
            )));
        }
        let mut h = playlist_hasher();
        let mut buf = vec![0u8; READ_BUF];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Ok(hex::encode(h.finalize()))
    })
    .await?
}

/// Time a playlist server may take before the response head. Large provider
/// playlists are often generated on request and take 20-60 s to start. Xtream
/// list actions get the same deadline (IN-2).
#[cfg(not(test))]
pub(crate) const PLAYLIST_HEADER_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(120);
#[cfg(test)]
pub(crate) const PLAYLIST_HEADER_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(1500);

/// Longest gap between two body chunks of a playlist download.
#[cfg(not(test))]
const BODY_IDLE: std::time::Duration = crate::http::BODY_IDLE_TIMEOUT;
#[cfg(test)]
const BODY_IDLE: std::time::Duration = std::time::Duration::from_millis(500);

/// A non-2xx answer to a playlist download, with what to do about it. The
/// error code follows [`crate::http::status_error`].
fn playlist_status_error(status: reqwest::StatusCode, host: &str) -> CoreError {
    let hint = match status.as_u16() {
        401 | 403 => "Check the playlist URL and account details; some providers also require a specific User-Agent.",
        404 | 410 => "Check the playlist URL; the provider may have changed it.",
        408 | 429 | 500..=599 => "The server is busy or down; try again later.",
        _ => "Check the playlist URL.",
    };
    crate::http::status_error_with_hint(
        status,
        &format!("{host} answered the playlist download"),
        hint,
    )
}

/// `import.progress` of a download retry: the C6 fields plus `attempt` (the
/// 1-based try starting now) and `attempts` (tries allowed). Both are
/// additive; other progress events do not carry them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryProgress<'a> {
    source_id: &'a str,
    phase: &'static str,
    done: u64,
    message: &'a str,
    attempt: u32,
    attempts: u32,
}

/// Emits the `import.progress` of a retry (try `attempt` of `attempts`).
/// Shared by the M3U download and the Xtream client.
pub(crate) fn emit_retry(state: &AppState, source_id: &str, attempt: u32, attempts: u32) {
    let message = format!("Retrying the download (try {attempt} of {attempts})");
    state.emit(
        "import.progress",
        RetryProgress {
            source_id,
            phase: "fetching",
            done: 0,
            message: &message,
            attempt,
            attempts,
        },
    );
}

/// The last error of a download that was retried: says how many tries were
/// made (the error itself only describes the last one). Same variant, so the
/// same error code. Appended, not prefixed: the UI reads the host from the
/// start of the message (`sourceError.ts` HOST_PATTERNS).
pub(crate) fn after_tries(err: CoreError, tries: u32) -> CoreError {
    if tries < 2 {
        return err;
    }
    let say = |m: String| format!("{m} The download failed after {tries} tries.");
    match err {
        CoreError::Network(m) => CoreError::Network(say(m)),
        CoreError::Timeout(m) => CoreError::Timeout(say(m)),
        CoreError::Server(m) => CoreError::Server(say(m)),
        other => other,
    }
}

/// [`fetch_conditional`] without validators: the body's sha256.
#[cfg(test)]
async fn fetch_to_file(
    state: &Arc<AppState>,
    source_id: &str,
    url: &str,
    cfg: &M3uSourceConfig,
    dest: &Path,
) -> CoreResult<String> {
    match fetch_conditional(state, source_id, url, cfg, dest, None).await? {
        Download::Body { sha, .. } => Ok(sha),
        Download::NotModified => Err(CoreError::Invalid("unexpected HTTP 304".into())),
    }
}

/// What [`fetch_conditional`] got.
enum Download {
    /// The body is in `dest`.
    Body {
        sha: String,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    /// HTTP 304 to the validators sent: the stored body is current.
    NotModified,
}

/// Downloads `url` with the source headers into `dest` (streamed, never held
/// in memory), retrying transient failures, but not a server that stalled in
/// the middle of the body or sent it slower than [`MinRate`] allows. Stops
/// with [`sources::import_cancelled_error`] as soon as the running import is
/// cancelled ([`sources::import_cancel`]). Returns the body's sha256 and
/// validators. With `known`, the request carries `If-None-Match` /
/// `If-Modified-Since`, and a 304 answer is [`Download::NotModified`].
async fn fetch_conditional(
    state: &Arc<AppState>,
    source_id: &str,
    url: &str,
    cfg: &M3uSourceConfig,
    dest: &Path,
    known: Option<&Validators>,
) -> CoreResult<Download> {
    let safe_url = crate::logging::redact_url(url);
    sources::progress(state, source_id, "fetching", 0, None, None);
    // The playlist URL is the source's own address, so its host:port is
    // trusted; redirects elsewhere stay guarded in server mode.
    let own = url::Url::parse(url.trim())
        .ok()
        .and_then(|u| crate::http::Authority::of(&u));
    crate::http::check_fetch(state, url, own.as_ref()).await?;
    let client = crate::http::guarded_client(state, own.as_ref());
    let host = url::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "the server".to_owned());
    // Err((error, stalled)): `stalled` when the body stopped arriving.
    let attempt = || async {
        let mut req = crate::http::apply_source_headers(client.get(url), &cfg.headers);
        if let Some(v) = known {
            if let Some(etag) = &v.etag {
                req = req.header(reqwest::header::IF_NONE_MATCH, etag.as_str());
            }
            if let Some(at) = &v.last_modified {
                req = req.header(reqwest::header::IF_MODIFIED_SINCE, at.as_str());
            }
        }
        let resp = crate::http::send_within(req, PLAYLIST_HEADER_TIMEOUT)
            .await
            .map_err(|e| (e, false))?;
        if known.is_some() && resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(Download::NotModified);
        }
        if !resp.status().is_success() {
            return Err((playlist_status_error(resp.status(), &host), false));
        }
        let validator = |name: reqwest::header::HeaderName| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let etag = validator(reqwest::header::ETAG);
        let last_modified = validator(reqwest::header::LAST_MODIFIED);
        let total = resp.content_length();
        if total.is_some_and(|n| n > MAX_PLAYLIST_BYTES) {
            return Err((too_large_error(&host), false));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| (e.into(), false))?;
        let mut hasher = playlist_hasher();
        let mut done: u64 = 0;
        let mut gate = ProgressGate::default();
        let mut rate = MinRate::standard();
        // The first bytes, until judged by `sniff` (None once judged).
        let mut head: Option<Vec<u8>> = Some(Vec::with_capacity(SNIFF_BYTES));
        let mut stream = resp.bytes_stream();
        loop {
            let chunk = match crate::http::next_body_chunk(&mut stream, &host, BODY_IDLE).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(e) => {
                    let stalled = matches!(e, CoreError::Timeout(_));
                    return Err((e, stalled));
                }
            };
            rate.on_bytes(chunk.len(), &host).map_err(|e| (e, true))?;
            if let Some(buf) = head.as_mut() {
                let take = (SNIFF_BYTES - buf.len()).min(chunk.len());
                buf.extend_from_slice(&chunk[..take]);
                if buf.len() >= SNIFF_BYTES {
                    if let Some(err) = sniff(buf, content_type.as_deref(), &host) {
                        return Err((err, false));
                    }
                    head = None;
                }
            }
            if done + chunk.len() as u64 > MAX_PLAYLIST_BYTES {
                return Err((too_large_error(&host), false));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| (e.into(), false))?;
            done += chunk.len() as u64;
            if gate.due(std::time::Instant::now()) {
                sources::progress(state, source_id, "fetching", done, total, None);
            }
        }
        if let Some(buf) = head.as_ref() {
            if let Some(err) = sniff(buf, content_type.as_deref(), &host) {
                return Err((err, false));
            }
        }
        // No fsync: the temp file is parsed at once, and the kept copy is a
        // cache a refresh replaces (IN-10; syncing 100 MB took seconds).
        file.flush().await.map_err(|e| (e.into(), false))?;
        sources::progress(
            state,
            source_id,
            "fetching",
            done,
            total.or(Some(done)),
            None,
        );
        Ok::<_, (CoreError, bool)>(Download::Body {
            sha: hex::encode(hasher.finalize()),
            etag,
            last_modified,
        })
    };
    // Outside `sources::run_import` (tests) nothing cancels.
    let cancel = sources::import_cancel().unwrap_or_default();
    let mut n = 0;
    loop {
        // Dropping the attempt mid-body is safe: it only owns the response
        // and `dest`, which the caller deletes.
        let result = tokio::select! {
            r = attempt() => r,
            () = cancel.cancelled() => {
                tracing::info!(url = %safe_url, "playlist download cancelled");
                return Err(sources::import_cancelled_error());
            }
        };
        match result {
            Ok(download) => return Ok(download),
            Err((err, stalled)) => {
                tracing::warn!(url = %safe_url, error = %err, attempt = n + 1, "playlist download failed");
                // A head that did not arrive within PLAYLIST_HEADER_TIMEOUT
                // comes from a slow generator; it will be as slow again.
                if stalled || !err.is_retryable() || matches!(err, CoreError::Timeout(_)) {
                    return Err(err);
                }
                if n + 1 >= FETCH_ATTEMPTS {
                    return Err(after_tries(err, n + 1));
                }
                tokio::select! {
                    () = tokio::time::sleep(crate::http::backoff_delay(n)) => {}
                    () = cancel.cancelled() => return Err(sources::import_cancelled_error()),
                }
                n += 1;
                emit_retry(state, source_id, n + 1, FETCH_ATTEMPTS);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::m3u::parser::parse_str;

    /// Local HTTP stub answering every connection with `head` (then holding
    /// the socket open); returns its URL and a connection counter.
    async fn raw_stub(head: &'static str) -> (String, Arc<std::sync::atomic::AtomicU32>) {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((mut sock, _)) = listener.accept().await {
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(head.as_bytes()).await;
                held.push(sock);
            }
        });
        (format!("http://127.0.0.1:{}/list.m3u", addr.port()), hits)
    }

    async fn fetch(url: &str) -> (CoreResult<String>, std::time::Duration) {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(
            tmp.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        let cfg = M3uSourceConfig {
            origin: M3uOrigin::Url,
            url: Some(url.into()),
            file_path: None,
            headers: Default::default(),
            catchup: None,
        };
        let started = std::time::Instant::now();
        let r = fetch_to_file(&state, "s", url, &cfg, &tmp.path().join("x.part")).await;
        (r, started.elapsed())
    }

    /// L2-sources-home-8: progress is due on the first chunk, then at most
    /// every 250 ms, however small or large the chunks are.
    #[test]
    fn download_progress_gate_reports_first_chunk_then_every_250ms() {
        let t0 = std::time::Instant::now();
        let ms = |n| t0 + std::time::Duration::from_millis(n);
        let mut gate = ProgressGate::default();
        assert!(gate.due(t0), "first chunk reported at once");
        assert!(!gate.due(ms(100)));
        assert!(!gate.due(ms(249)));
        assert!(gate.due(ms(250)));
        assert!(!gate.due(ms(300)));
        assert!(gate.due(ms(600)));
    }

    /// L2-sources-home-8: a slow host (64 KiB every 150 ms) shows bytes
    /// arriving from the first chunk on, not only after each full MiB.
    #[tokio::test]
    async fn slow_download_reports_progress_from_the_first_chunk() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let chunk = {
                let mut c = b"#EXTM3U\n".to_vec();
                let line = b"#EXTINF:-1,Ch\nhttp://h/a.ts\n";
                while c.len() + line.len() <= 64 * 1024 {
                    c.extend_from_slice(line);
                }
                c
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: audio/x-mpegurl\r\nContent-Length: {}\r\n\r\n",
                chunk.len() * 6
            );
            let _ = sock.write_all(head.as_bytes()).await;
            for _ in 0..6 {
                if sock.write_all(&chunk).await.is_err() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        });
        let tmp = tempfile::tempdir().unwrap();
        let (sink, mut rx) = crate::events::BroadcastSink::channel(256);
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
            .await
            .unwrap();
        let url = format!("http://127.0.0.1:{port}/slow.m3u");
        let cfg = M3uSourceConfig {
            origin: M3uOrigin::Url,
            url: Some(url.clone()),
            file_path: None,
            headers: Default::default(),
            catchup: None,
        };
        let started = std::time::Instant::now();
        let first = tokio::spawn(async move {
            loop {
                let ev = rx.recv().await.unwrap();
                if ev.kind == "import.progress"
                    && ev.payload["phase"] == "fetching"
                    && ev.payload["done"].as_u64().unwrap_or(0) > 0
                {
                    return (started.elapsed(), rx);
                }
            }
        });
        fetch_to_file(&state, "s", &url, &cfg, &tmp.path().join("x.part"))
            .await
            .unwrap();
        let (at, mut rx) = first.await.unwrap();
        assert!(
            at < std::time::Duration::from_millis(500),
            "first byte progress at {at:?}"
        );
        let mut more = 0;
        while let Ok(ev) = rx.try_recv() {
            if ev.payload["phase"] == "fetching" {
                more += 1;
            }
        }
        assert!(more >= 2, "progress kept coming while bytes flowed: {more}");
    }

    /// R7-r2 F4: a server that sends the head and then stalls fails once,
    /// after the body idle limit, naming the host; no retries.
    #[tokio::test]
    async fn stall_after_head_fails_fast_without_retry() {
        let (url, hits) =
            raw_stub("HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n#EXTM3U\n").await;
        let (r, took) = fetch(&url).await;
        let err = r.unwrap_err();
        assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
        let msg = err.to_string();
        assert!(
            msg.contains("127.0.0.1") && msg.contains("try again"),
            "{msg}"
        );
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1, "retried");
        assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    }

    /// R7-r3 F4: a server that drips a byte faster than the idle limit but
    /// far below the minimum rate fails once a rate window has passed, with
    /// a next step, and is not retried.
    #[tokio::test]
    async fn drip_fed_body_fails_on_the_minimum_rate() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n#EXTM3U\n")
                        .await;
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        if sock.write_all(b"#").await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let (r, took) = fetch(&format!("http://127.0.0.1:{port}/list.m3u")).await;
        let err = r.unwrap_err();
        assert!(
            matches!(err, CoreError::Timeout(ref m) if m.contains("too slowly") && m.contains("try again")),
            "{err:?}"
        );
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1, "retried");
        assert!(
            took >= crate::m3u::body::MIN_RATE_WINDOW && took < std::time::Duration::from_secs(6),
            "{took:?}"
        );
    }

    /// B8: a channel's stream URL pasted as the playlist URL fails at once
    /// with a next step instead of downloading forever; no retries.
    #[tokio::test]
    async fn endless_video_stream_is_refused_early() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n\r\n")
                        .await;
                    let mut packet = [0u8; 188];
                    packet[0] = 0x47;
                    loop {
                        if sock.write_all(&packet).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let (r, took) = fetch(&format!("http://127.0.0.1:{port}/live/1.ts")).await;
        let err = r.unwrap_err();
        assert!(
            matches!(err, CoreError::Invalid(ref m) if m.contains("MPEG-TS") && m.contains("playlist URL")),
            "{err:?}"
        );
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1, "retried");
        assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    }

    /// B8: a login page served with 200 says so instead of "not an M3U".
    #[tokio::test]
    async fn web_page_instead_of_playlist_is_named() {
        let (url, _) = raw_stub(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 46\r\nConnection: close\r\n\r\n<!DOCTYPE html><html><body>Login</body></html>",
        )
        .await;
        let (r, _) = fetch(&url).await;
        let err = r.unwrap_err();
        assert!(
            matches!(err, CoreError::Invalid(ref m) if m.contains("web page") && m.contains("127.0.0.1")),
            "{err:?}"
        );
    }

    /// B8: a declared size over the cap is refused before downloading.
    #[tokio::test]
    async fn oversized_playlist_is_refused_up_front() {
        let (url, _) =
            raw_stub("HTTP/1.1 200 OK\r\nContent-Length: 5000000000\r\n\r\n#EXTM3U\n").await;
        let (r, took) = fetch(&url).await;
        let err = r.unwrap_err();
        assert!(
            matches!(err, CoreError::Invalid(ref m) if m.contains("too large")),
            "{err:?}"
        );
        assert!(took < std::time::Duration::from_secs(2), "{took:?}");
    }

    /// An HTTP error status names the host and says what to do; 5xx retries.
    #[tokio::test]
    async fn http_status_failure_has_a_next_step() {
        let (url, hits) = raw_stub(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let (r, _) = fetch(&url).await;
        let err = r.unwrap_err();
        assert!(matches!(err, CoreError::Server(_)), "{err:?}");
        let msg = err.to_string();
        assert!(
            msg.contains("127.0.0.1")
                && msg.contains("HTTP 503")
                && msg.contains("try again later"),
            "{msg}"
        );
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            FETCH_ATTEMPTS
        );
        let err = playlist_status_error(reqwest::StatusCode::FORBIDDEN, "h");
        assert!(
            matches!(err, CoreError::Auth(ref m) if m.contains("HTTP 403") && m.contains("User-Agent"))
        );
    }

    /// Review R1-6: retries were silent (the UI sat on "Downloading") and the
    /// final message only described the last try.
    #[tokio::test]
    async fn retries_are_reported_and_counted_in_the_message() {
        let (url, hits) = raw_stub(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let tmp = tempfile::tempdir().unwrap();
        let (sink, mut rx) = crate::events::BroadcastSink::channel(256);
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
            .await
            .unwrap();
        let cfg = M3uSourceConfig {
            origin: M3uOrigin::Url,
            url: Some(url.clone()),
            file_path: None,
            headers: Default::default(),
            catchup: None,
        };
        let err = fetch_to_file(&state, "s", &url, &cfg, &tmp.path().join("x.part"))
            .await
            .unwrap_err();
        let CoreError::Server(msg) = &err else {
            panic!("code kept: {err:?}");
        };
        assert!(
            msg.contains("after 3 tries") && msg.contains("HTTP 503"),
            "{msg}"
        );
        assert!(
            msg.starts_with("127.0.0.1"),
            "host stays first for the UI: {msg}"
        );
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
        let mut tries = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if ev.kind == "import.progress" && ev.payload.get("attempt").is_some() {
                assert_eq!(ev.payload["phase"], "fetching");
                assert_eq!(ev.payload["attempts"], FETCH_ATTEMPTS);
                tries.push(ev.payload["attempt"].as_u64().unwrap());
            }
        }
        assert_eq!(tries, [2, 3]);
        // A single failed try is not reworded.
        let one = after_tries(CoreError::Timeout("x".into()), 1);
        assert!(matches!(one, CoreError::Timeout(ref m) if m == "x"));
    }

    /// Review R1-7: write_catalog looked up the writer token only after
    /// opening its transaction. When the run was dropped meanwhile (lock wait
    /// past CANCEL_GRACE) no token was registered any more and the cancelled
    /// import committed. The run's own token is now passed in and checked.
    #[tokio::test]
    async fn cancelled_run_never_commits_without_a_registered_writer_token() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(
            tmp.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        let mut conn = state.db.get().unwrap();
        conn.execute(
            "INSERT INTO sources (id, kind, name, config_json) VALUES ('s7', 'm3u', 'S', '{}')",
            [],
        )
        .unwrap();
        assert!(
            sources::writer_cancel_token(&conn, "s7").is_none(),
            "no run registered"
        );
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let text = "#EXTM3U\n#EXTINF:-1,A\nhttp://a\n".to_string();
        let err = write_catalog(
            &state,
            &mut conn,
            "s7",
            Payload::Text(text.clone()),
            "sha",
            M3uOrigin::Url,
            Some(token),
        )
        .unwrap_err();
        assert!(sources::is_cancelled_error(&err), "{err:?}");
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM items WHERE source_id = 's7'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "nothing committed");
        // A live token writes normally.
        let s = write_catalog(
            &state,
            &mut conn,
            "s7",
            Payload::Text(text),
            "sha",
            M3uOrigin::Url,
            Some(tokio_util::sync::CancellationToken::new()),
        )
        .unwrap();
        assert_eq!(s.channels, 1);
    }

    #[test]
    fn ids_are_stable_and_unique() {
        assert_eq!(item_id("http://a", "A"), item_id("http://a", "A"));
        assert_eq!(item_id("http://a", "A").len(), 16);
        assert_eq!(group_id("News"), hash16("News"));
        let (entries, _, _) = parse_str("#EXTM3U\n#EXTINF:-1 group-title=\"G\",Dup\nhttp://d\n#EXTINF:-1 group-title=\"H\",Dup\nhttp://d\n");
        let mut b = RowBuilder::new("s");
        let rows: Vec<ItemRow> = entries.into_iter().map(|e| b.row(e)).collect();
        assert_ne!(rows[0].item_id, rows[1].item_id);
        assert_eq!(rows[0].item_id, item_id("http://d", "Dup"));
        assert_eq!(rows[0].number, Some(1));
        assert_eq!(rows[1].number, Some(2));
        let cats = b.categories();
        assert_eq!(cats[0].1.len(), 2);
    }

    #[test]
    fn classifies_movies_and_radio() {
        let (e, _, _) = parse_str(
            "#EXTM3U\n#EXTINF:-1 group-title=\"VOD Movies\",Heat (1995)\nhttp://x/heat.mp4\n#EXTINF:-1 group-title=\"News\",Clip\nhttp://x/clip.mp4\n#EXTINF:-1 radio=\"true\",R\nhttp://r\n",
        );
        assert_eq!(classify(&e[0]), ContentType::Movie);
        assert_eq!(classify(&e[1]), ContentType::Live);
        assert_eq!(classify(&e[2]), ContentType::Radio);
        let mut b = RowBuilder::new("s");
        let movie = b.row(e[0].clone());
        assert_eq!(movie.title_base.as_deref(), Some("Heat"));
        assert_eq!(movie.year, Some(1995));
        assert_eq!(movie.container_extension.as_deref(), Some("mp4"));
        assert_eq!(movie.number, None);
    }

    /// L1-core-4: Xtream `m3u_plus` movies and episodes landed in Live TV
    /// because only an `.mp4`-style URL in a "movie" group was a movie.
    #[test]
    fn xtream_m3u_plus_vod_is_classified_as_movies() {
        let (e, _, _) = parse_str(
            "#EXTM3U\n\
             #EXTINF:-1 group-title=\"EN | Action\",Dune (2021)\nhttp://h:8080/movie/u/p/1001.mkv\n\
             #EXTINF:-1 group-title=\"EN | Drama\",Show S01 E01\nhttp://h:8080/series/u/p/5001.mp4\n\
             #EXTINF:-1 group-title=\"EN | Action\",Film\nhttp://h/vod/f.avi?token=1\n\
             #EXTINF:-1 group-title=\"News\",Live\nhttp://h:8080/u/p/7.ts\n\
             #EXTINF:-1 group-title=\"News\",Loop\nhttp://h/loop.mp4\n\
             #EXTINF:-1 group-title=\"News\",Movie host\nhttp://movie.example/live/1.m3u8\n",
        );
        let types: Vec<ContentType> = e.iter().map(classify).collect();
        assert_eq!(
            types,
            [
                ContentType::Movie,
                ContentType::Movie,
                ContentType::Movie,
                ContentType::Live,
                ContentType::Live,
                ContentType::Live
            ]
        );
    }

    /// L1-core-13: a playlist generator that takes longer than the generic
    /// 15 s head timeout to answer is waited for (PLAYLIST_HEADER_TIMEOUT),
    /// and a head that never comes is not retried three times.
    #[tokio::test]
    async fn slow_playlist_head_is_tried_once() {
        let (url, hits) = raw_stub("").await;
        let (r, took) = fetch(&url).await;
        let err = r.unwrap_err();
        assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(took < PLAYLIST_HEADER_TIMEOUT * 2, "{took:?}");
    }

    /// B8-parsers: `catchup-days` * 24 overflowed (debug panic) on garbage.
    #[test]
    fn huge_catchup_days_are_clamped() {
        let (e, _, _) = parse_str(
            "#EXTM3U\n#EXTINF:-1 catchup=\"default\" catchup-days=\"9223372036854775807\",A\nhttp://a\n#EXTINF:-1 catchup=\"default\" timeshift=\"3\",B\nhttp://b\n",
        );
        let mut b = RowBuilder::new("s");
        let rows: Vec<ItemRow> = e.into_iter().map(|e| b.row(e)).collect();
        assert_eq!(
            rows[0].archive_hours,
            Some(crate::xtream::meta::MAX_ARCHIVE_DAYS * 24)
        );
        assert_eq!(rows[1].archive_hours, Some(72));
    }

    /// Review R2-3: a UTF-16 playlist added by URL was rejected as binary.
    #[tokio::test]
    async fn utf16_playlist_by_url_is_accepted() {
        // BOM-less UTF-16 LE of ASCII text is valid UTF-8 (NUL-interleaved).
        let body: String = "#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://s/1.ts\r\n"
            .chars()
            .flat_map(|c| [c, '\0'])
            .collect();
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (url, _) = raw_stub(Box::leak(head.into_boxed_str())).await;
        let (r, _) = fetch(&url).await;
        r.unwrap();
    }

    /// Review R2-8: the stored raw text of a UTF-16 file source was garbled
    /// (read as UTF-8, lossy).
    #[test]
    fn raw_text_of_a_utf16_file_is_decoded() {
        let tmp = tempfile::tempdir().unwrap();
        let text = "#EXTM3U\r\n#EXTINF:-1,Télé\r\nhttp://s/1.ts\r\n";
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend(u.to_le_bytes());
        }
        let p = tmp.path().join("u16.m3u");
        std::fs::write(&p, &bytes).unwrap();
        assert_eq!(read_text_lossy(&p).unwrap(), text);
        std::fs::write(&p, b"#EXTM3U\n#EXTINF:-1,Caf\xe9\n").unwrap();
        assert_eq!(read_text_lossy(&p).unwrap(), "#EXTM3U\n#EXTINF:-1,Café\n");
    }
}
