//! M3U importer: fetch (URL / file / pasted text) -> streaming parse -> one
//! write transaction that rewrites the source's catalog, stores `m3u_raw`, and
//! records the header EPG URLs. A failure anywhere rolls the transaction back,
//! so the previous catalog survives a failed refresh.

use super::body::MinRate;
use super::parser::{has_movie_extension, url_extension, M3uEntry, M3uReader};
use crate::catalog::{self, CatalogWriter, CategoryRow, ItemRow};
use crate::db::now_rfc3339;
use crate::error::{CoreError, CoreResult};
use crate::model::{
    ContentType, EpgLinks, ImportSummary, M3uOrigin, M3uSourceConfig, Source, SourceKind,
};
use crate::sources::{self, Importer};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

/// Progress cadence (items) during parse + save.
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

/// Content type of an entry: `radio="true"` -> radio; a movie container URL in
/// a group whose title mentions movie / vod / film -> movie; else live.
pub fn classify(e: &M3uEntry) -> ContentType {
    if e.radio {
        return ContentType::Radio;
    }
    if has_movie_extension(&e.url) {
        let g = e.group.as_deref().unwrap_or("").to_lowercase();
        if g.contains("movie") || g.contains("vod") || g.contains("film") {
            return ContentType::Movie;
        }
    }
    ContentType::Live
}

/// Turns parser entries into catalog rows: stable ids (with a suffix for exact
/// duplicates), categories in first-seen order per content type, channel
/// numbers (tvg-chno, else one running index shared by live and radio, so a
/// radio number never repeats a live one).
pub struct RowBuilder {
    source_id: String,
    seen_ids: HashSet<String>,
    categories: HashMap<ContentType, (Vec<CategoryRow>, HashSet<String>)>,
    channel_counter: i64,
    position: i64,
}

impl RowBuilder {
    pub fn new(source_id: &str) -> Self {
        Self {
            source_id: source_id.to_string(),
            seen_ids: HashSet::new(),
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

        let group = e.group.clone().unwrap_or_default();
        let cat_id = group_id(&group);
        let (cats, cat_ids) = self.categories.entry(ct).or_default();
        if !cat_ids.contains(&cat_id) {
            cat_ids.insert(cat_id.clone());
            let name = if group.trim().is_empty() {
                catalog::FALLBACK_CATEGORY_NAME.to_string()
            } else {
                group.clone()
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
            e.catchup_days.filter(|d| *d > 0).map(|d| d * 24)
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

    // 1. Acquire bytes + sha256.
    let (payload, sha) = match cfg.origin {
        M3uOrigin::Text => {
            let missing = || {
                CoreError::Invalid(
                    "the pasted playlist text is missing; edit the source and paste it again"
                        .into(),
                )
            };
            // Pasted text changes only through sources.add or a restore, which
            // store its sha (or '' when it still has to be imported): an
            // imported text playlist with a sha is unchanged without reading it.
            let sid = source_id.clone();
            let stored_sha = state
                .db_call(move |c| {
                    Ok(c.query_row(
                        "SELECT sha256 FROM m3u_raw WHERE source_id = ?1",
                        [&sid],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?)
                })
                .await?
                .ok_or_else(missing)?;
            if source.last_refresh_at.is_some() && !stored_sha.is_empty() {
                return keep_unchanged(&state, &source_id).await;
            }
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
                let sha = hex::encode(Sha256::digest(raw.as_bytes()));
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
            let sha = fetch_to_file(&state, &source_id, &url, &cfg, &tmp).await?;
            (
                Payload::File {
                    path: tmp,
                    temp: true,
                },
                sha,
            )
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
        return keep_unchanged(&state, &source_id).await;
    }

    // A remove or a settings change cancelled this import while it was
    // downloading: do not write a catalog for it.
    if sources::import_cancel().is_some_and(|t| t.is_cancelled()) {
        return Err(sources::import_cancelled_error());
    }

    // 3. Parse + write in one transaction on the blocking pool.
    sources::progress(&state, &source_id, "parsing", 0, None, None);
    let st = state.clone();
    let pool = state.db.clone();
    let origin = cfg.origin;
    tokio::task::spawn_blocking(move || -> CoreResult<ImportSummary> {
        let mut conn = pool.get()?;
        write_catalog(&st, &mut conn, &source_id, payload, &sha, origin)
    })
    .await?
    .map_err(|e| state.note_db_error(e))
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
    sources::progress(state, source_id, "saving", 0, None, Some("unchanged"));
    Ok(ImportSummary {
        channels,
        movies,
        series,
    })
}

/// Streams `payload` through the parser into the catalog inside one IMMEDIATE
/// transaction, then stores the raw text and detected EPG URLs.
fn write_catalog(
    state: &AppState,
    conn: &mut Connection,
    source_id: &str,
    payload: Payload,
    sha: &str,
    origin: M3uOrigin,
) -> CoreResult<ImportSummary> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut builder = RowBuilder::new(source_id);
    let started = std::time::Instant::now();

    let (header, stats, summary) = {
        let mut writer = CatalogWriter::begin(&tx, source_id, &M3U_TYPES)?;
        let reader: Box<dyn std::io::BufRead + '_> = match &payload {
            Payload::File { path: p, .. } => Box::new(BufReader::with_capacity(
                READ_BUF,
                std::fs::File::open(p).map_err(|e| file_error(p, e))?,
            )),
            Payload::Text(t) => Box::new(std::io::Cursor::new(t.as_bytes())),
        };
        let mut parser = M3uReader::new(reader);
        let mut n = 0u64;
        for entry in parser.by_ref() {
            let row = builder.row(entry);
            writer.insert(&row)?;
            n += 1;
            if n % PROGRESS_EVERY == 0 {
                sources::progress(state, source_id, "parsing", n, None, None);
            }
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
        sources::progress(state, source_id, "saving", n, Some(n), None);
        let summary = ImportSummary {
            channels: (writer.inserted_of(ContentType::Live)
                + writer.inserted_of(ContentType::Radio)) as i64,
            movies: writer.inserted_of(ContentType::Movie) as i64,
            series: writer.inserted_of(ContentType::Series) as i64,
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
            let size = std::fs::metadata(p).map_err(|e| file_error(p, e))?.len();
            let raw = if size <= RAW_INLINE_MAX {
                read_text_lossy(p)?
            } else {
                keep_copy = Some((p.clone(), *temp));
                String::new()
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
    tx.commit()?;
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
    let start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        3
    } else {
        0
    };
    let text = match String::from_utf8(bytes) {
        Ok(mut s) => {
            if start > 0 {
                s.drain(..start);
            }
            s
        }
        Err(e) => String::from_utf8_lossy(&e.into_bytes()[start..]).into_owned(),
    };
    Ok(text)
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
        let mut h = Sha256::new();
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
    match crate::http::status_error(status, &format!("{host} answered the playlist download")) {
        CoreError::Auth(m) => CoreError::Auth(format!("{m}. {hint}")),
        CoreError::NotFound(m) => CoreError::NotFound(format!("{m}. {hint}")),
        CoreError::Timeout(m) => CoreError::Timeout(format!("{m}. {hint}")),
        CoreError::Network(m) => CoreError::Network(format!("{m}. {hint}")),
        CoreError::Invalid(m) => CoreError::Invalid(format!("{m}. {hint}")),
        other => other,
    }
}

/// Downloads `url` with the source headers into `dest` (streamed, never held
/// in memory), retrying transient failures, but not a server that stalled in
/// the middle of the body or sent it slower than [`MinRate`] allows. Stops
/// with [`sources::import_cancelled_error`] as soon as the running import is
/// cancelled ([`sources::import_cancel`]). Returns the body's sha256.
async fn fetch_to_file(
    state: &Arc<AppState>,
    source_id: &str,
    url: &str,
    cfg: &M3uSourceConfig,
    dest: &Path,
) -> CoreResult<String> {
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
        let req = crate::http::apply_source_headers(client.get(url), &cfg.headers);
        let resp = crate::http::send(req).await.map_err(|e| (e, false))?;
        if !resp.status().is_success() {
            return Err((playlist_status_error(resp.status(), &host), false));
        }
        let total = resp.content_length();
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| (e.into(), false))?;
        let mut hasher = Sha256::new();
        let mut done: u64 = 0;
        let mut last_report: u64 = 0;
        let mut rate = MinRate::standard();
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
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| (e.into(), false))?;
            done += chunk.len() as u64;
            if done - last_report >= 1024 * 1024 {
                last_report = done;
                sources::progress(state, source_id, "fetching", done, total, None);
            }
        }
        file.flush().await.map_err(|e| (e.into(), false))?;
        file.sync_all().await.ok();
        sources::progress(
            state,
            source_id,
            "fetching",
            done,
            total.or(Some(done)),
            None,
        );
        Ok::<_, (CoreError, bool)>(hex::encode(hasher.finalize()))
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
            Ok(sha) => return Ok(sha),
            Err((err, stalled)) => {
                tracing::warn!(url = %safe_url, error = %err, attempt = n + 1, "playlist download failed");
                if stalled || !err.is_retryable() || n + 1 >= FETCH_ATTEMPTS {
                    return Err(err);
                }
                tokio::select! {
                    () = tokio::time::sleep(crate::http::backoff_delay(n)) => {}
                    () = cancel.cancelled() => return Err(sources::import_cancelled_error()),
                }
                n += 1;
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
        };
        let started = std::time::Instant::now();
        let r = fetch_to_file(&state, "s", url, &cfg, &tmp.path().join("x.part")).await;
        (r, started.elapsed())
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

    /// An HTTP error status names the host and says what to do; 5xx retries.
    #[tokio::test]
    async fn http_status_failure_has_a_next_step() {
        let (url, hits) = raw_stub(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let (r, _) = fetch(&url).await;
        let err = r.unwrap_err();
        assert!(matches!(err, CoreError::Network(_)), "{err:?}");
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
}
