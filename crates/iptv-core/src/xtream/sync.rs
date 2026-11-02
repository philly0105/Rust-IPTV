//! Catalog sync: account check, then live (+radio), movies and series are
//! fetched one content type at a time, the changed ones are decoded and
//! mapped, and all of them are written in ONE transaction
//! ([`replace_catalogs`]), then the XMLTV link.
//!
//! Atomicity (C8): a cancel or failure anywhere before that commit leaves the
//! previous catalog whole. Writing type by type used to leave live new and
//! movies old when a cancel landed between types.
//!
//! Two phases (R3-4). First every type is downloaded with no save slot
//! held: its body is fetched as bytes and hashed on the blocking pool, and
//! a changed body is staged in `data_dir/tmp/xtream-<id>-<kind>-<uuid>.part`
//! and dropped before the next type is fetched, so one body at most is in
//! memory. Then, when any type changed, the import save slot is taken once
//! and each staged body is read back, decoded and mapped to `ItemRow`s on
//! the blocking pool, its file deleted; the mapped rows of every type are
//! held until the single write. A changed live list used to take the slot
//! before the movie and series lists were even requested, so every other
//! import's decode and write waited out those downloads too (25-130 s on a
//! large panel).
//!
//! Failure policy: `Auth`, `Network` and `Timeout` (after retries) abort the
//! whole sync and nothing is written, and so does a staged copy that cannot
//! be written or read back (`Io`: the disk is full or failing, and the
//! write would fail as well). A type the panel does not serve
//! (`NotFound`, unreadable JSON) is skipped with a warning and keeps its
//! previous rows; the sync fails only if every requested type failed. A
//! type whose categories come back unreadable (a login page) keeps its
//! previous rows too, or, with none yet, lands under "Uncategorized". Both
//! are noted with `sources::note_import_warning`, so the source's
//! `lastError` says what is stale. Warnings and the error of a sync where
//! every type failed are reported in type order ([`Issues`]), as when each
//! type was fetched and decoded in turn.
//!
//! Unchanged refresh (L2-perf-core-4): each type's answers (mapped
//! categories plus the raw list body, with [`SYNC_VERSION`]) are hashed and
//! the hash is stored per type in `app_state` (`xtream_fp:<id>`) with the
//! commit. A type whose hash and row counts match is neither decoded nor
//! written; when no type changed there is no write at all and the run
//! reports `unchanged`.

use super::client::XtreamClient;
use super::meta::{self, added_to_rfc3339, year_from_date, ServerMeta};
use super::raw::{LenientVec, RawCategory, RawLive, RawSeries, RawVod};
use super::url::{clean_extension, is_xmltv_url_for, xmltv_url};
use crate::catalog::{self, CategoryRow, ItemRow};
use crate::error::{CoreError, CoreResult, RpcErrorCode};
use crate::model::{ContentType, EpgLinks, ImportSummary, XtreamSourceConfig};
use crate::sources::{progress, progress_step, ProgressGate, SaveStep};
use crate::state::AppState;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

/// Progress is emitted at most this often while saving (rows), and at most
/// every 250 ms ([`ProgressGate`]); the last row is always reported.
const PROGRESS_EVERY: u64 = 2000;

/// Which content types to sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncPlan {
    pub live: bool,
    pub movies: bool,
    pub series: bool,
}

impl SyncPlan {
    pub const ALL: Self = Self {
        live: true,
        movies: true,
        series: true,
    };

    /// From an rpc `contentTypes` filter (`None` or empty = everything;
    /// `radio` means live, since radio streams come from the live list).
    pub fn from_types(types: Option<&[ContentType]>) -> Self {
        match types {
            None | Some([]) => Self::ALL,
            Some(t) => Self {
                live: t.contains(&ContentType::Live) || t.contains(&ContentType::Radio),
                movies: t.contains(&ContentType::Movie),
                series: t.contains(&ContentType::Series),
            },
        }
    }
}

/// An xtream row of the `sources` table.
#[derive(Debug, Clone)]
pub struct XtreamSourceRow {
    pub id: String,
    pub name: String,
    pub config: XtreamSourceConfig,
    pub epg: EpgLinks,
}

/// Loads an xtream source; `NotFound` when missing, `Invalid` for other kinds.
pub fn load_source(conn: &Connection, id: &str) -> CoreResult<XtreamSourceRow> {
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT kind, name, config_json, epg_json FROM sources WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((kind, name, config_json, epg_json)) = row else {
        return Err(CoreError::not_found(format!(
            "Source {id} no longer exists."
        )));
    };
    if kind != "xtream" {
        return Err(CoreError::invalid(format!(
            "Source \"{name}\" is not an Xtream source."
        )));
    }
    let config: XtreamSourceConfig = serde_json::from_str(&config_json).map_err(|_| {
        CoreError::invalid(format!(
            "The Xtream settings of \"{name}\" are incomplete. Edit the source and save it again."
        ))
    })?;
    let epg = serde_json::from_str(&epg_json).unwrap_or_default();
    Ok(XtreamSourceRow {
        id: id.to_string(),
        name,
        config,
        epg,
    })
}

/// Runs a sync for one source, emitting `fetching` / `parsing` / `saving`
/// progress. It does not emit `done` / `error` or touch `last_refresh_at` /
/// `last_error`: `sources::run_import` (or `xtream.sync` for a subset) owns
/// the outcome.
pub async fn sync_source(
    state: Arc<AppState>,
    source_id: &str,
    cfg: &XtreamSourceConfig,
    plan: SyncPlan,
) -> CoreResult<ImportSummary> {
    let http = crate::http::trusted_client(&state, &cfg.server_url);
    let lists = crate::http::trusted_long_client(&state, &cfg.server_url);
    let client = XtreamClient::new(http, cfg)?
        .with_list_client(lists)
        .with_progress(&state, source_id);
    tracing::info!(source_id, server = %client.server, user = %client.masked_username(), ?plan, "xtream sync start");
    progress(&state, source_id, "fetching", 0, None, Some("account"));
    let account = client.account().await?;
    let server_meta = ServerMeta::from_account(&account);
    // account: the reply doubles as a fresh subscription status.
    crate::account::remember_xtream(&state, source_id, super::service::info_from_raw(account))
        .await;
    meta::remember_meta(&state, source_id, &server_meta);
    let rt = meta::runtime(&state);

    // What the last write stored, and the rows there now (unchanged check).
    let previous = {
        let sid = source_id.to_string();
        state.db_call(move |c| load_previous(c, &sid)).await?
    };

    let mut parts: Vec<CatalogPart> = Vec::new();
    // Kinds whose rows stay as they are (unchanged, or kept after their
    // categories failed), and the new fingerprints of the kinds written.
    let mut untouched: Vec<Kind> = Vec::new();
    let mut written: Vec<(Kind, Option<String>)> = Vec::new();
    // Warnings and kinds that failed without failing the sync (their rows
    // stay too), reported in kind order once both phases are done.
    let mut issues = Issues::default();

    // Phase 1: download every kind, no save slot held. A changed list waits
    // on disk (its file goes with `staged` if the sync stops early).
    let mut staged: Vec<Staged> = Vec::new();
    let steps: [(bool, Kind); 3] = [
        (plan.live, Kind::Live),
        (plan.movies, Kind::Movies),
        (plan.series, Kind::Series),
    ];
    for (enabled, kind) in steps {
        if !enabled {
            continue;
        }
        // A cancel between content types stops here, before anything is
        // written (the HTTP helpers also stop a fetch in flight).
        if crate::sources::is_import_cancelled() {
            return Err(crate::sources::import_cancelled_error());
        }
        match fetch_kind(&state, &client, source_id, kind, &previous, &mut issues).await {
            Ok(Fetched::Unchanged) => {
                tracing::info!(
                    source_id,
                    kind = kind.label(),
                    "xtream content type unchanged; rows kept"
                );
                untouched.push(kind);
            }
            Ok(Fetched::Kept) => untouched.push(kind),
            Ok(Fetched::Staged(s)) => staged.push(s),
            Err(err) if is_fatal(&err) => return Err(err),
            Err(err) => issues.skip(&state, source_id, kind, err),
        }
    }

    // Phase 2: the import save slot (ST-2), taken once before the first
    // changed list is decoded and held until the write ends, so decoded
    // rows exist only while it is held. An unchanged refresh never waits.
    let mut slot: Option<tokio::sync::OwnedSemaphorePermit> = None;
    for s in staged {
        if crate::sources::is_import_cancelled() {
            return Err(crate::sources::import_cancelled_error());
        }
        let kind = s.kind;
        progress(&state, source_id, "parsing", 0, None, Some(kind.label()));
        if slot.is_none() {
            slot = Some(crate::sources::save_slot(&state).await?);
        }
        match decode_staged(source_id, s).await {
            Ok((p, hash)) => {
                written.push((kind, hash));
                parts.extend(p);
            }
            Err(err) if is_fatal(&err) => return Err(err),
            Err(err) => issues.skip(&state, source_id, kind, err),
        }
    }
    issues.note_warnings();
    if untouched.is_empty() && parts.iter().all(|p| p.rows.is_empty()) {
        if let Some(err) = issues.take_first_error() {
            // Every requested type failed (or the rest came back empty):
            // keep the previous catalog untouched.
            return Err(err);
        }
    }
    if crate::sources::is_import_cancelled() {
        return Err(crate::sources::import_cancelled_error());
    }

    // Nothing to write: no write lock, no catalog rewrite, and clients keep
    // their catalog queries (`done` carries UNCHANGED_MESSAGE).
    let unchanged = parts.is_empty();
    let counts = if unchanged {
        progress(
            &state,
            source_id,
            "saving",
            0,
            None,
            Some(crate::sources::UNCHANGED_MESSAGE),
        );
        HashMap::new()
    } else {
        let total = parts.iter().map(|p| p.rows.len() as u64).sum::<u64>();
        let state2 = state.clone();
        let sid = source_id.to_string();
        let prints = previous.prints.clone();
        // The run's token, read here (task-local) before waiting on the pool
        // or the write lock (C8; see `CatalogWriter::begin`).
        let cancel = crate::sources::import_cancel();
        // A refresh deletes the previous rows first (seconds on a large
        // account): say so instead of leaving "parsing" up (L3-perf-core-4).
        let replacing = parts.iter().any(|p| previous.rows(p.content_type) > 0);
        let slot = slot.take();
        state
            .db_call(move |conn| {
                let _slot = slot;
                if replacing {
                    progress_step(&state2, &sid, SaveStep::Replacing, 0);
                }
                let mut done = 0u64;
                let mut gate = ProgressGate::default();
                // No message: the phase label already says "Saving"; a raw
                // content type under the bar is not translated (L2-sources-home-7).
                let mut on_row = |_: ContentType| {
                    done += 1;
                    if done == total
                        || (done.is_multiple_of(PROGRESS_EVERY)
                            && gate.due(std::time::Instant::now()))
                    {
                        progress(&state2, &sid, "saving", done, Some(total), None);
                    }
                };
                // Every row is written: the indexes, the search index and the
                // counts follow before the commit.
                let mut on_finish = |written: u64| {
                    progress_step(&state2, &sid, SaveStep::Indexing, written);
                };
                let counts = replace_catalogs_with(
                    conn,
                    &sid,
                    parts,
                    cancel,
                    &mut on_row,
                    &mut on_finish,
                    |tx, counts| store_prints(tx, &sid, prints, &written, counts),
                )?;
                // The rewrite grew the WAL by about the catalog's size.
                crate::db::checkpoint_truncate(conn);
                Ok(counts)
            })
            .await?
    };
    let enabled = |kind: Kind| match kind {
        Kind::Live => plan.live,
        Kind::Movies => plan.movies,
        Kind::Series => plan.series,
    };
    let count = |ct: ContentType| -> i64 {
        let kind = Kind::of(ct);
        if !enabled(kind) {
            0
        } else if untouched.contains(&kind) || issues.failed(kind) {
            previous.rows(ct)
        } else {
            counts.get(&ct).copied().unwrap_or(0) as i64
        }
    };
    let summary = ImportSummary {
        channels: count(ContentType::Live) + count(ContentType::Radio),
        movies: count(ContentType::Movie),
        series: count(ContentType::Series),
        unchanged,
    };

    // XMLTV link + caches.
    let xmltv = xmltv_url(&client.server, &client.username, client.password());
    let server = client.server.clone();
    let sid = source_id.to_string();
    state
        .db_call(move |c| add_detected_epg(c, &sid, &server, &xmltv))
        .await?;
    meta::invalidate_source(&rt, source_id);

    tracing::info!(
        source_id,
        channels = summary.channels,
        movies = summary.movies,
        series = summary.series,
        "xtream sync done"
    );
    Ok(summary)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Live,
    Movies,
    Series,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Live => "live",
            Kind::Movies => "movies",
            Kind::Series => "series",
        }
    }
    fn actions(self) -> (&'static str, &'static str) {
        match self {
            Kind::Live => ("get_live_categories", "get_live_streams"),
            Kind::Movies => ("get_vod_categories", "get_vod_streams"),
            Kind::Series => ("get_series_categories", "get_series"),
        }
    }
    /// The content types one kind writes (live also carries radio).
    fn content_types(self) -> &'static [ContentType] {
        match self {
            Kind::Live => &[ContentType::Live, ContentType::Radio],
            Kind::Movies => &[ContentType::Movie],
            Kind::Series => &[ContentType::Series],
        }
    }
    fn of(ct: ContentType) -> Self {
        match ct {
            ContentType::Live | ContentType::Radio => Kind::Live,
            ContentType::Movie => Kind::Movies,
            ContentType::Series => Kind::Series,
        }
    }
    /// Position in the fetch order (and in [`Issues`]).
    fn index(self) -> usize {
        self as usize
    }
    /// `lastError` of a sync where this kind could not be loaded and kept
    /// its previous rows.
    fn kept_message(self) -> String {
        let what = match self {
            Kind::Live => "Channels",
            Kind::Movies => "Movies",
            Kind::Series => "Series",
        };
        format!("{what} could not be loaded from the server, so the previous {} were kept. Refresh the source to try again.", what.to_lowercase())
    }
    /// `lastError` when this kind's categories could not be loaded.
    fn categories_message(self, kept: bool) -> String {
        let what = match self {
            Kind::Live => "channel",
            Kind::Movies => "movie",
            Kind::Series => "series",
        };
        let plural = match self {
            Kind::Live => "channels",
            Kind::Movies => "movies",
            Kind::Series => "series",
        };
        if kept {
            format!("The {what} categories could not be loaded from the server, so the previous {plural} were kept. Refresh the source to try again.")
        } else {
            format!("The {what} categories could not be loaded from the server, so every {what} is listed under Uncategorized for now. Refresh the source to try again.")
        }
    }
}

/// The warnings of a sync and the kinds it skipped, held per kind and
/// reported in kind order once both phases are done. Only the first of each
/// reaches the user (`run_import` keeps the run's first warning as
/// `lastError`; a sync where every kind failed returns its first error), and
/// that should be the earliest kind's, as when each kind was fetched and
/// decoded in turn. Noted as they came, a later kind's fetch failure
/// (phase 1) would win over an earlier kind's decode failure (phase 2): a
/// live list cut short on a panel without movies or series would be
/// reported as the movie list's 404.
#[derive(Default)]
struct Issues {
    /// By [`Kind::index`].
    kinds: [KindIssues; 3],
}

#[derive(Default)]
struct KindIssues {
    /// `lastError` candidates, in the order this kind met them.
    warnings: Vec<(String, RpcErrorCode)>,
    /// Why the kind was skipped; its rows stay as they were.
    error: Option<CoreError>,
}

impl Issues {
    fn warn(&mut self, kind: Kind, message: String, code: RpcErrorCode) {
        self.kinds[kind.index()].warnings.push((message, code));
    }

    /// A kind that failed without failing the sync: its rows stay.
    fn skip(&mut self, state: &AppState, source_id: &str, kind: Kind, err: CoreError) {
        tracing::warn!(source_id, kind = kind.label(), error = %err, "xtream content type skipped");
        progress(
            state,
            source_id,
            "parsing",
            0,
            None,
            Some(&format!("{} skipped: {err}", kind.label())),
        );
        // A panel that does not serve a type at all is normal; any other
        // failure leaves that type stale, so say so.
        if !matches!(err, CoreError::NotFound(_) | CoreError::Unsupported(_)) {
            self.warn(kind, kind.kept_message(), err.code());
        }
        self.kinds[kind.index()].error = Some(err);
    }

    fn failed(&self, kind: Kind) -> bool {
        self.kinds[kind.index()].error.is_some()
    }

    /// Notes every warning in kind order (`note_import_warning` keeps the
    /// first).
    fn note_warnings(&mut self) {
        for kind in &mut self.kinds {
            for (message, code) in kind.warnings.drain(..) {
                crate::sources::note_import_warning(&message, code);
            }
        }
    }

    /// The earliest kind's error, taken out: only for a sync that returns it.
    fn take_first_error(&mut self) -> Option<CoreError> {
        self.kinds.iter_mut().find_map(|k| k.error.take())
    }
}

/// Version of the Xtream mapping rules, hashed into every stored fingerprint
/// ([`kind_hash`]): bumping it makes the next refresh rewrite every
/// unchanged catalog once. Bump it whenever a change alters the rows a sync
/// writes (like `m3u::importer::IMPORT_VERSION`).
pub const SYNC_VERSION: u32 = 1;

/// `app_state` key of a source's per-kind fingerprints (dropped with the
/// source, see `sources::store::delete`).
fn prints_key(source_id: &str) -> String {
    format!("xtream_fp:{source_id}")
}

/// What the last write of one kind stored: the hash of the panel's answers
/// (categories and list) and the rows written per content type.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct KindPrint {
    hash: String,
    rows: BTreeMap<String, i64>,
}

/// Fingerprints by [`Kind::label`].
type Prints = BTreeMap<String, KindPrint>;

/// The stored fingerprints and the rows in the catalog now, per content type.
#[derive(Debug, Clone, Default)]
pub(crate) struct Previous {
    prints: Prints,
    rows: HashMap<String, i64>,
}

impl Previous {
    fn rows(&self, ct: ContentType) -> i64 {
        self.rows.get(ct.as_str()).copied().unwrap_or(0)
    }
    fn has_rows(&self, kind: Kind) -> bool {
        kind.content_types().iter().any(|ct| self.rows(*ct) > 0)
    }
    /// True when `hash` matches the last write of `kind` and the rows it
    /// wrote are all still there.
    fn unchanged(&self, kind: Kind, hash: &str) -> bool {
        self.prints.get(kind.label()).is_some_and(|p| {
            p.hash == hash
                && kind
                    .content_types()
                    .iter()
                    .all(|ct| p.rows.get(ct.as_str()).copied().unwrap_or(0) == self.rows(*ct))
        })
    }
}

fn load_previous(conn: &Connection, source_id: &str) -> CoreResult<Previous> {
    let prints = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [prints_key(source_id)],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let mut st = conn.prepare_cached(
        "SELECT content_type, count(*) FROM items WHERE source_id = ?1 GROUP BY content_type",
    )?;
    let rows = st
        .query_map([source_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(Previous { prints, rows })
}

/// Writes the fingerprints after a catalog write, inside its transaction:
/// written kinds with a hash get a new one, written kinds without (their
/// categories were missing) lose theirs so the next refresh writes them
/// again, and every other kind keeps its own.
fn store_prints(
    conn: &Connection,
    source_id: &str,
    mut prints: Prints,
    written: &[(Kind, Option<String>)],
    counts: &HashMap<ContentType, u64>,
) -> CoreResult<()> {
    for (kind, hash) in written {
        match hash {
            Some(hash) => {
                let rows = kind
                    .content_types()
                    .iter()
                    .map(|ct| {
                        (
                            ct.as_str().to_string(),
                            counts.get(ct).copied().unwrap_or(0) as i64,
                        )
                    })
                    .collect();
                prints.insert(
                    kind.label().to_string(),
                    KindPrint {
                        hash: hash.clone(),
                        rows,
                    },
                );
            }
            None => {
                prints.remove(kind.label());
            }
        }
    }
    conn.execute(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![prints_key(source_id), serde_json::to_string(&prints)?],
    )?;
    Ok(())
}

/// sha256 (hex) of one kind's panel answers: [`SYNC_VERSION`], the kind, its
/// mapped categories and the raw list body.
fn kind_hash(kind: Kind, categories: &[CategoryRow], list: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(format!("tsrust-xtream-sync-v{SYNC_VERSION}\n{}\n", kind.label()).as_bytes());
    for c in categories {
        h.update(c.category_id.as_bytes());
        h.update([0]);
        h.update(c.name.as_bytes());
        h.update([0]);
        h.update(c.position.to_le_bytes());
        h.update(*b"\n");
    }
    h.update([0xff]);
    h.update(list);
    hex::encode(h.finalize())
}

/// Outcome of [`fetch_kind`].
enum Fetched {
    /// The panel answered exactly what the last write stored, and those rows
    /// are still there: nothing to write.
    Unchanged,
    /// The categories failed while the kind has rows: they are kept as they
    /// were (and a warning is noted).
    Kept,
    /// A changed answer, staged on disk until it is decoded
    /// ([`decode_staged`]).
    Staged(Staged),
}

/// Errors that end the whole sync with nothing written: the panel or the
/// network failed for every kind alike, the run was cancelled, or a staged
/// list could not be written or read back.
fn is_fatal(err: &CoreError) -> bool {
    matches!(
        err,
        CoreError::Auth(_)
            | CoreError::Network(_)
            | CoreError::Server(_)
            | CoreError::Timeout(_)
            | CoreError::Io(_)
    ) || crate::sources::is_cancelled_error(err)
}

/// A changed list body waiting on disk for the save slot, with what its
/// rows need.
struct Staged {
    kind: Kind,
    /// `None` when the categories were missing (the items land under
    /// "Uncategorized").
    categories: Option<Vec<CategoryRow>>,
    /// The fingerprint to store with the rows; `None` without categories,
    /// so the next refresh writes the kind again.
    hash: Option<String>,
    file: StagedFile,
}

/// A staged list body, deleted on drop: after it is read back, or with a
/// sync that stops before (a cancel, a failure, a dropped task).
/// `m3u::init` deletes the `xtream-*.part` files a crash left.
struct StagedFile(std::path::PathBuf);

impl Drop for StagedFile {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                tracing::warn!(%err, file = %self.0.display(), "could not remove a staged xtream list");
            }
        }
    }
}

/// Writes a changed list body to `data_dir/tmp` (on the blocking pool), so
/// its memory is free while the next list downloads. Not synced: it is read
/// back within the same sync, and a crash leaves nothing to resume.
async fn stage(
    state: &AppState,
    source_id: &str,
    kind: Kind,
    body: bytes::Bytes,
) -> CoreResult<StagedFile> {
    let dir = state.data_dir.join("tmp");
    let file = StagedFile(dir.join(format!(
        "xtream-{source_id}-{}-{}.part",
        kind.label(),
        uuid::Uuid::new_v4().simple()
    )));
    tokio::task::spawn_blocking(move || -> CoreResult<StagedFile> {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&file.0, &body)?;
        Ok(file)
    })
    .await?
}

/// Reads a staged list back (sized exactly, the file closed and deleted
/// before the decode), then decodes and maps it on the blocking pool.
/// Returns its parts and the fingerprint to store.
async fn decode_staged(
    source_id: &str,
    staged: Staged,
) -> CoreResult<(Vec<CatalogPart>, Option<String>)> {
    let sid = source_id.to_string();
    tokio::task::spawn_blocking(move || {
        let Staged {
            kind,
            categories,
            hash,
            file,
        } = staged;
        let body = std::fs::read(&file.0)?;
        drop(file);
        let parts = map_kind(kind, &sid, &body, categories.unwrap_or_default())?;
        Ok((parts, hash))
    })
    .await?
}

/// Fetches one content type and stages its list when it changed. Nothing
/// is decoded or written here; see [`decode_staged`] and
/// [`replace_catalogs`]. An answer identical to the last write is not
/// even staged ([`Fetched::Unchanged`]). A categories warning goes to
/// `issues`, reported with the other kinds' in kind order.
async fn fetch_kind(
    state: &Arc<AppState>,
    client: &XtreamClient,
    source_id: &str,
    kind: Kind,
    previous: &Previous,
    issues: &mut Issues,
) -> CoreResult<Fetched> {
    let (cat_action, list_action) = kind.actions();
    progress(state, source_id, "fetching", 0, None, Some(kind.label()));
    let (cats, list) = tokio::join!(
        client.get::<LenientVec<RawCategory>>(Some(cat_action), &[]),
        client.get_bytes(list_action),
    );
    let categories = match cats {
        Ok(c) => Some(map_categories(c)),
        Err(
            err @ (CoreError::Auth(_)
            | CoreError::Network(_)
            | CoreError::Server(_)
            | CoreError::Timeout(_)),
        ) => return Err(err),
        Err(err) => {
            // A login page or an error body instead of the categories
            // (L1-core-15): every item would land under "Uncategorized".
            tracing::warn!(source_id, action = cat_action, error = %err, "xtream categories unavailable");
            let kept = previous.has_rows(kind);
            issues.warn(kind, kind.categories_message(kept), err.code());
            if kept {
                // Keep the previous rows and categories of this kind whole.
                return Ok(Fetched::Kept);
            }
            None
        }
    };
    let bytes = list?;

    // The fingerprint is taken from the bytes in memory, in the format the
    // last write stored, so an unchanged kind is neither staged nor waits
    // for the save slot (ST-2).
    let (hash, categories, bytes) = tokio::task::spawn_blocking(move || {
        let hash = categories
            .as_deref()
            .map(|cats| kind_hash(kind, cats, &bytes));
        (hash, categories, bytes)
    })
    .await?;
    if hash.as_deref().is_some_and(|h| previous.unchanged(kind, h)) {
        return Ok(Fetched::Unchanged);
    }
    let file = stage(state, source_id, kind, bytes).await?;
    Ok(Fetched::Staged(Staged {
        kind,
        categories,
        hash,
        file,
    }))
}

/// Decodes one kind's list body and maps it to the parts to write (live
/// yields a live and a radio part). Each record is mapped to its row as soon
/// as it is read (R3-2): no `Vec` of every decoded record sits beside the
/// rows any more (96.5 MB of `RawVod`s plus their text at 180k movies,
/// grown by doubling). `position` counts the records read, skipped elements
/// excluded, as `enumerate` over that `Vec` did.
fn map_kind(
    kind: Kind,
    source_id: &str,
    body: &[u8],
    categories: Vec<CategoryRow>,
) -> CoreResult<Vec<CatalogPart>> {
    let part = |content_type, categories, rows| CatalogPart {
        content_type,
        categories,
        rows,
    };
    let mut position = 0i64;
    let parts = match kind {
        Kind::Live => {
            let (mut live, mut radio) = (Vec::new(), Vec::new());
            let skipped = super::client::decode_list(body, "live streams", |r: RawLive| {
                if let Some(row) = live_row(source_id, position, r) {
                    if row.is_radio {
                        radio.push(row);
                    } else {
                        live.push(row);
                    }
                }
                position += 1;
            })?;
            log_skipped(source_id, kind, skipped);
            let (live_cats, radio_cats) = split_categories(&categories, &live, &radio);
            vec![
                part(ContentType::Live, live_cats, live),
                part(ContentType::Radio, radio_cats, radio),
            ]
        }
        Kind::Movies => {
            let mut rows = Vec::new();
            let skipped = super::client::decode_list(body, "movies", |r: RawVod| {
                rows.extend(vod_row(source_id, position, r).map(with_title_base));
                position += 1;
            })?;
            log_skipped(source_id, kind, skipped);
            vec![part(ContentType::Movie, categories, rows)]
        }
        Kind::Series => {
            let mut rows = Vec::new();
            let skipped = super::client::decode_list(body, "series", |r: RawSeries| {
                rows.extend(series_row(source_id, position, r).map(with_title_base));
                position += 1;
            })?;
            log_skipped(source_id, kind, skipped);
            vec![part(ContentType::Series, categories, rows)]
        }
    };
    Ok(parts)
}

/// `row` with its title base worked out here, on the blocking pool, instead
/// of inside the write transaction (IN-3).
fn with_title_base(mut row: ItemRow) -> ItemRow {
    row.derive_title_base();
    row
}

fn log_skipped(source_id: &str, kind: Kind, skipped: usize) {
    if skipped > 0 {
        tracing::warn!(
            source_id,
            kind = kind.label(),
            skipped,
            "xtream entries could not be read and were skipped"
        );
    }
}

/// The new catalog of one content type, written by [`replace_catalogs`].
pub(crate) struct CatalogPart {
    pub content_type: ContentType,
    pub categories: Vec<CategoryRow>,
    pub rows: Vec<ItemRow>,
}

/// Replaces the catalogs of several content types of one source in ONE
/// transaction and returns the rows written per type (duplicates excluded).
///
/// Any error, or a cancel of the import run (C8) seen by the writer or right
/// before the commit, rolls the whole transaction back: the previous catalog
/// of every type stays as it was. Types not in `parts` are not touched.
/// `on_row` is called once per row offered to the writer.
///
/// `cancel` is the run's token, taken by the caller before `db_call` (see
/// [`catalog::CatalogWriter::begin`]); `None` falls back to the registered
/// writer token.
#[cfg(test)]
pub(crate) fn replace_catalogs(
    conn: &mut Connection,
    source_id: &str,
    parts: Vec<CatalogPart>,
    cancel: Option<tokio_util::sync::CancellationToken>,
    on_row: &mut dyn FnMut(ContentType),
) -> CoreResult<HashMap<ContentType, u64>> {
    replace_catalogs_with(
        conn,
        source_id,
        parts,
        cancel,
        on_row,
        &mut |_| {},
        |_, _| Ok(()),
    )
}

/// [`replace_catalogs`], with `before_commit` run inside the same
/// transaction after the rows are written (given the counts), so state that
/// describes the catalog (the Xtream fingerprints) commits or rolls back
/// with it. `on_finish` is called with the rows written once every row is
/// in, before the writer builds its indexes and counts.
pub(crate) fn replace_catalogs_with(
    conn: &mut Connection,
    source_id: &str,
    parts: Vec<CatalogPart>,
    cancel: Option<tokio_util::sync::CancellationToken>,
    on_row: &mut dyn FnMut(ContentType),
    on_finish: &mut dyn FnMut(u64),
    before_commit: impl FnOnce(&Connection, &HashMap<ContentType, u64>) -> CoreResult<()>,
) -> CoreResult<HashMap<ContentType, u64>> {
    let cancel = cancel.or_else(|| crate::sources::writer_cancel_token(conn, source_id));
    let check_cancel = || -> CoreResult<()> {
        if cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
            return Err(crate::sources::import_cancelled_error());
        }
        Ok(())
    };
    check_cancel()?;
    let mut counts = HashMap::new();
    if parts.is_empty() {
        return Ok(counts);
    }
    let types: Vec<ContentType> = parts.iter().map(|p| p.content_type).collect();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let mut w = catalog::CatalogWriter::begin(&tx, source_id, &types, cancel.clone())?;
        let mut categories = Vec::with_capacity(parts.len());
        for part in &parts {
            w.declare_categories(part.content_type, &part.categories);
        }
        for part in parts {
            for row in &part.rows {
                w.insert(row)?;
                on_row(part.content_type);
            }
            categories.push((part.content_type, part.categories));
        }
        for ct in &types {
            counts.insert(*ct, w.inserted_of(*ct));
        }
        on_finish(w.inserted());
        w.finish(&categories)?;
    }
    before_commit(&tx, &counts)?;
    // Last check: a cancelled run never commits.
    check_cancel()?;
    tx.commit()?;
    Ok(counts)
}

/// Adds the account's XMLTV URL to `epg.detectedUrls`, replacing stale
/// `xmltv.php` links of the same server (credentials changed).
pub fn add_detected_epg(
    conn: &Connection,
    source_id: &str,
    server: &str,
    xmltv: &str,
) -> CoreResult<()> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT epg_json FROM sources WHERE id = ?1",
            [source_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(()) };
    let mut links: EpgLinks = serde_json::from_str(&raw).unwrap_or_default();
    let before = links.detected_urls.clone();
    links
        .detected_urls
        .retain(|u| u == xmltv || !is_xmltv_url_for(u, server));
    if !links.detected_urls.iter().any(|u| u == xmltv) {
        links.detected_urls.push(xmltv.to_string());
    }
    if links.detected_urls != before {
        conn.execute(
            "UPDATE sources SET epg_json = ?1 WHERE id = ?2",
            rusqlite::params![serde_json::to_string(&links)?, source_id],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

/// Category id an item belongs to: `category_id`, else the first of `category_ids`.
fn item_category(category_id: Option<String>, category_ids: &[String]) -> String {
    category_id
        .or_else(|| category_ids.first().cloned())
        .unwrap_or_else(|| "0".to_string())
}

pub fn map_categories(raw: LenientVec<RawCategory>) -> Vec<CategoryRow> {
    let mut seen = HashSet::new();
    raw.items
        .into_iter()
        .filter_map(|c| {
            let id = c.category_id?;
            if !seen.insert(id.clone()) {
                return None;
            }
            let name = c.category_name.unwrap_or_else(|| format!("Category {id}"));
            Some((id, name))
        })
        .enumerate()
        .map(|(i, (category_id, name))| CategoryRow {
            category_id,
            name,
            position: i as i64,
        })
        .collect()
}

/// Live categories: declared ones not used only by radio. Radio categories:
/// declared ones used by radio items.
fn split_categories(
    all: &[CategoryRow],
    live: &[ItemRow],
    radio: &[ItemRow],
) -> (Vec<CategoryRow>, Vec<CategoryRow>) {
    if radio.is_empty() {
        return (all.to_vec(), Vec::new());
    }
    let live_ids: HashSet<&str> = live.iter().map(|r| r.category_id.as_str()).collect();
    let radio_ids: HashSet<&str> = radio.iter().map(|r| r.category_id.as_str()).collect();
    let live_cats = all
        .iter()
        .filter(|c| {
            live_ids.contains(c.category_id.as_str()) || !radio_ids.contains(c.category_id.as_str())
        })
        .cloned()
        .collect();
    let radio_cats = all
        .iter()
        .filter(|c| radio_ids.contains(c.category_id.as_str()))
        .cloned()
        .collect();
    (live_cats, radio_cats)
}

// The mapped rows carry their `extra` as JSON text (`ItemRow::extra_json`),
// serialized here on the blocking pool from these borrowing structs. Their
// fields are declared in the key order a `serde_json::Map` (a BTreeMap)
// writes, so the stored bytes are the same as before (IN-3 remainder, R3-1).
// With a map (a 632-byte leaf on its first insert) a mapped row retained
// 1,160-1,570 B, now 530-790 B: about 160 MB less at 50k channels, 180k
// movies and 20k series, held from the decode to the write. The writer no
// longer serializes and frees a map per row inside the write transaction.

/// `extra` of a live or radio row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveExtra<'a> {
    /// Only when there is more than one.
    #[serde(skip_serializing_if = "Option::is_none")]
    category_ids: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_sid: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_adult: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_type: Option<&'a str>,
    /// 0 or 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    tv_archive: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tv_archive_duration: Option<i64>,
}

/// `extra` of a movie or series row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VodExtra<'a> {
    /// Only when there is more than one.
    #[serde(skip_serializing_if = "Option::is_none")]
    category_ids: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    genres: Option<Vec<&'a str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_adult: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plot: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tmdb_id: Option<i64>,
}

/// `categoryIds` of `extra`: only for an item in more than one category.
fn extra_category_ids(ids: &[String]) -> Option<&[String]> {
    (ids.len() > 1).then_some(ids)
}

fn clean_url(u: Option<String>) -> Option<String> {
    u.filter(|s| s.starts_with("http://") || s.starts_with("https://"))
}

/// Rating on a 0..10 scale: `rating`, else `rating_5based * 2`.
fn rating(r: Option<f64>, r5: Option<f64>) -> Option<f64> {
    r.filter(|v| *v > 0.0)
        .or_else(|| r5.filter(|v| *v > 0.0).map(|v| v * 2.0))
        .map(|v| (v.min(10.0) * 10.0).round() / 10.0)
}

fn split_genres(g: Option<&str>) -> Option<Vec<&str>> {
    let v: Vec<&str> = g?
        .split([',', '/', '|'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    (!v.is_empty()).then_some(v)
}

// The mappers leave `source_id` empty: the writer stores its own
// (`CatalogWriter::insert`), so a copy of the 36-byte id per row is waste.
// The parameter stays for callers of these public functions.

pub fn live_row(_source_id: &str, position: i64, r: RawLive) -> Option<ItemRow> {
    let id = r.stream_id?;
    let is_radio = r.stream_type.as_deref().is_some_and(|t| {
        t.eq_ignore_ascii_case("radio_streams") || t.eq_ignore_ascii_case("radio")
    });
    let archive = r.tv_archive == Some(true);
    let days = r.tv_archive_duration.filter(|d| *d > 0);
    let extra_json = catalog::extra_text(&LiveExtra {
        category_ids: extra_category_ids(&r.category_ids),
        custom_sid: r.custom_sid.as_deref(),
        is_adult: r.is_adult,
        stream_type: r.stream_type.as_deref(),
        tv_archive: r.tv_archive.map(i64::from),
        tv_archive_duration: days,
    });
    let title = r.name.unwrap_or_else(|| format!("Channel {id}"));
    Some(ItemRow {
        content_type: if is_radio {
            ContentType::Radio
        } else {
            ContentType::Live
        },
        category_id: item_category(r.category_id, &r.category_ids),
        title,
        number: r.num.filter(|n| *n > 0),
        logo_url: clean_url(r.stream_icon),
        added: added_to_rfc3339(r.added.as_deref()),
        epg_channel_id: r.epg_channel_id,
        is_radio,
        // Xtream reports archive depth in days; enabled archives with an
        // unknown depth get one day so the UI offers catch-up. Clamped: a
        // garbage depth must not overflow here or in the catch-up time math.
        archive_hours: archive
            .then(|| super::meta::archive_days_to_hours(days.unwrap_or(1)))
            .flatten(),
        extra: Value::Null,
        extra_json,
        position,
        item_id: id,
        ..ItemRow::default()
    })
}

pub fn vod_row(_source_id: &str, position: i64, r: RawVod) -> Option<ItemRow> {
    let tmdb_id = r.tmdb_id();
    let id = r.stream_id?;
    let title = r.name.or(r.title).unwrap_or_else(|| format!("Movie {id}"));
    let extra_json = catalog::extra_text(&VodExtra {
        category_ids: extra_category_ids(&r.category_ids),
        genres: split_genres(r.genre.as_deref()),
        is_adult: r.is_adult,
        plot: r.plot.as_deref(),
        tmdb_id,
    });
    let poster = clean_url(r.stream_icon).or(clean_url(r.cover));
    Some(ItemRow {
        content_type: ContentType::Movie,
        category_id: item_category(r.category_id, &r.category_ids),
        title,
        number: r.num.filter(|n| *n > 0),
        poster_url: poster,
        rating: rating(r.rating, r.rating_5based),
        added: added_to_rfc3339(r.added.as_deref()),
        year: r.year.filter(|y| (1900..=2100).contains(y)),
        container_extension: clean_extension(r.container_extension.as_deref()),
        extra: Value::Null,
        extra_json,
        position,
        item_id: id,
        ..ItemRow::default()
    })
}

pub fn series_row(_source_id: &str, position: i64, r: RawSeries) -> Option<ItemRow> {
    let tmdb_id = r.tmdb_id();
    let release = r.release().map(str::to_owned);
    let id = r.series_id?;
    let title = r.name.or(r.title).unwrap_or_else(|| format!("Series {id}"));
    let extra_json = catalog::extra_text(&VodExtra {
        category_ids: extra_category_ids(&r.category_ids),
        genres: split_genres(r.genre.as_deref()),
        is_adult: r.is_adult,
        plot: r.plot.as_deref(),
        tmdb_id,
    });
    let year = r
        .year
        .filter(|y| (1900..=2100).contains(y))
        .or_else(|| year_from_date(release.as_deref()));
    Some(ItemRow {
        content_type: ContentType::Series,
        category_id: item_category(r.category_id, &r.category_ids),
        title,
        number: r.num.filter(|n| *n > 0),
        poster_url: clean_url(r.cover),
        backdrop_url: r.backdrop_path.into_iter().find(|u| u.starts_with("http")),
        rating: rating(r.rating, r.rating_5based),
        added: added_to_rfc3339(r.last_modified.as_deref()),
        year,
        extra: Value::Null,
        extra_json,
        position,
        item_id: id,
        ..ItemRow::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
        serde_json::from_value(v).unwrap()
    }

    /// A mapped row's `extra`, parsed from the text it carries.
    fn extra_value(row: &ItemRow) -> Value {
        assert!(row.extra.is_null(), "mapped rows carry text only");
        serde_json::from_str(row.extra_json.as_deref().unwrap_or("{}")).unwrap()
    }

    /// The text the writer stores for a mapped row.
    fn stored_extra(row: &ItemRow) -> &str {
        row.extra_json.as_deref().unwrap_or("{}")
    }

    // The extras as the mappers built them before R3-1, through a
    // `serde_json::Map`, for the equivalence test below.

    fn put(extra: &mut serde_json::Map<String, Value>, key: &str, v: Option<impl Into<Value>>) {
        if let Some(v) = v {
            extra.insert(key.to_string(), v.into());
        }
    }

    fn old_genres(g: Option<&str>) -> Option<Value> {
        split_genres(g).map(|v| v.into_iter().map(|s| Value::String(s.into())).collect())
    }

    fn old_live_extra(r: &RawLive) -> String {
        let days = r.tv_archive_duration.filter(|d| *d > 0);
        let mut extra = serde_json::Map::new();
        put(&mut extra, "tvArchive", r.tv_archive.map(i64::from));
        put(&mut extra, "tvArchiveDuration", days);
        put(&mut extra, "isAdult", r.is_adult);
        put(&mut extra, "customSid", r.custom_sid.clone());
        put(&mut extra, "streamType", r.stream_type.clone());
        if r.category_ids.len() > 1 {
            extra.insert("categoryIds".into(), r.category_ids.clone().into());
        }
        old_text(extra)
    }

    fn old_vod_extra(
        tmdb_id: Option<i64>,
        plot: &Option<String>,
        genre: &Option<String>,
        is_adult: Option<bool>,
        category_ids: &[String],
    ) -> String {
        let mut extra = serde_json::Map::new();
        put(&mut extra, "tmdbId", tmdb_id);
        put(&mut extra, "plot", plot.clone());
        put(&mut extra, "genres", old_genres(genre.as_deref()));
        put(&mut extra, "isAdult", is_adult);
        if category_ids.len() > 1 {
            extra.insert("categoryIds".into(), category_ids.to_vec().into());
        }
        old_text(extra)
    }

    /// What `CatalogWriter::insert` stored for an `extra` map.
    fn old_text(extra: serde_json::Map<String, Value>) -> String {
        if extra.is_empty() {
            "{}".into()
        } else {
            Value::Object(extra).to_string()
        }
    }

    /// R3-1: the mappers serialize `extra` through borrowing structs; the
    /// stored text is byte for byte what the `serde_json::Map` path wrote,
    /// for every combination of present and missing keys, escapes and
    /// non-ASCII text included.
    #[test]
    fn mapped_extra_text_matches_the_map_it_replaced() {
        let plots = [
            json!(null),
            json!("A \"quoted\" plot\nwith a newline, a tab\t, a \\ and ünïcødé 映画 🎬"),
            json!(""),
        ];
        let genres = [
            json!(null),
            json!("Drama, Crime / Thriller|  "),
            json!(" , / "),
        ];
        let cats = [json!(null), json!(["7"]), json!([3, "4", "x\"y"])];
        let mut checked = 0;
        for plot in &plots {
            for genre in &genres {
                for (i, cat) in cats.iter().enumerate() {
                    for adult in [json!(null), json!(0), json!("1")] {
                        let flag = i % 2 == 0;
                        let live = json!({
                            "stream_id": 1, "category_ids": cat, "is_adult": adult,
                            "tv_archive": if flag { json!(1) } else { json!(null) },
                            "tv_archive_duration": if flag { json!("5") } else { json!(-1) },
                            "custom_sid": if flag { json!("sid:1") } else { json!(null) },
                            "stream_type": if flag { json!("live") } else { json!(null) },
                        });
                        let r: RawLive = parse(live.clone());
                        let want = old_live_extra(&r);
                        let row = live_row("s", 0, parse(live)).unwrap();
                        assert_eq!(stored_extra(&row), want);

                        let vod = json!({
                            "stream_id": 2, "category_ids": cat, "is_adult": adult,
                            "plot": plot, "genre": genre,
                            "tmdb": if flag { json!("550") } else { json!(null) },
                        });
                        let r: RawVod = parse(vod.clone());
                        let want = old_vod_extra(
                            r.tmdb_id(),
                            &r.plot,
                            &r.genre,
                            r.is_adult,
                            &r.category_ids,
                        );
                        let row = vod_row("s", 0, parse(vod)).unwrap();
                        assert_eq!(stored_extra(&row), want);

                        let series = json!({
                            "series_id": 3, "category_ids": cat, "is_adult": adult,
                            "plot": plot, "genre": genre,
                            "tmdb_id": if flag { json!(77) } else { json!(null) },
                        });
                        let r: RawSeries = parse(series.clone());
                        let want = old_vod_extra(
                            r.tmdb_id(),
                            &r.plot,
                            &r.genre,
                            r.is_adult,
                            &r.category_ids,
                        );
                        let row = series_row("s", 0, parse(series)).unwrap();
                        assert_eq!(stored_extra(&row), want);
                        checked += 1;
                    }
                }
            }
        }
        assert_eq!(checked, 81);
    }

    /// R3-1: mapped rows leave `source_id` to the writer, which stores its own.
    #[test]
    fn mapped_rows_are_written_with_the_writers_source_id_and_extra() {
        let sid = "s-x";
        let mut conn = catalog_db(sid);
        let live = live_row(
            sid,
            0,
            parse(json!({"stream_id": 1, "name": "One", "is_adult": 1, "category_ids": [1, 2]})),
        )
        .unwrap();
        let movie = vod_row(
            sid,
            0,
            parse(json!({"stream_id": 2, "name": "Two", "plot": "P", "tmdb": 9})),
        )
        .unwrap();
        assert!(live.source_id.is_empty() && movie.source_id.is_empty());
        replace_catalogs(
            &mut conn,
            sid,
            vec![
                part(ContentType::Live, vec![live]),
                part(ContentType::Movie, vec![movie]),
            ],
            None,
            &mut |_| {},
        )
        .unwrap();
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT source_id, extra_json FROM items ORDER BY content_type")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                (
                    sid.into(),
                    r#"{"categoryIds":["1","2"],"isAdult":true}"#.into()
                ),
                (sid.into(), r#"{"plot":"P","tmdbId":9}"#.into()),
            ]
        );
    }

    /// The rows of one part, comparable.
    fn part_rows(p: &CatalogPart) -> (ContentType, &[CategoryRow], &[ItemRow]) {
        (p.content_type, &p.categories, &p.rows)
    }

    /// R3-2: `map_kind` maps each record as it is read. Its rows, their
    /// positions (records read, skipped elements excluded, records without
    /// an id included), the live/radio split and the categories are those of
    /// the pipeline it replaced: every record decoded into a `LenientVec`,
    /// then enumerated and mapped. Errors are `decode`'s.
    #[test]
    fn streamed_mapping_matches_the_collected_pipeline() {
        use super::super::client::decode;
        let cats = map_categories(parse(json!([
            {"category_id": 1, "category_name": "News"},
            {"category_id": "2", "category_name": "Radio"},
            {"category_id": "3", "category_name": "Unused"}
        ])));
        let live = br#"["junk", {"stream_id": 101, "name": "One", "category_id": "1", "num": 3},
            null, {"name": "no id"}, {"stream_id": "9", "stream_type": "radio_streams",
            "category_ids": [2, 1]}, [1, "Pos", "live", 102], {"stream_id": 101, "name": "Dup"},
            {"stream_id": 103, "tv_archive": "1", "tv_archive_duration": "3"}]"#;
        let movies = br#"{"0": {"stream_id": 201, "name": "Film (2019)", "rating": "7,5"},
            "1": 5, "2": {"name": "no id"}, "3": {"stream_id": "202", "title": "The Film",
            "tmdb": "0", "tmdb_id": 550, "genre": "Drama, Crime"}}"#;
        let series = br#"[{"series_id": 301, "name": "Show", "releaseDate": "2018-03-01",
            "backdrop_path": ["", "http://x/b.jpg"]}, true, {"series_id": 302, "title": "S2",
            "last_modified": "1700000000", "rating_5based": 4}]"#;

        // Live and radio.
        let parsed: LenientVec<RawLive> = decode(live, "live streams").unwrap();
        assert_eq!(parsed.skipped, 2);
        let (radio, live_rows): (Vec<ItemRow>, Vec<ItemRow>) = parsed
            .items
            .into_iter()
            .enumerate()
            .filter_map(|(i, r)| live_row("s", i as i64, r))
            .partition(|r| r.is_radio);
        let (live_cats, radio_cats) = split_categories(&cats, &live_rows, &radio);
        let parts = map_kind(Kind::Live, "s", live, cats.clone()).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(
            part_rows(&parts[0]),
            (ContentType::Live, &live_cats[..], &live_rows[..])
        );
        assert_eq!(
            part_rows(&parts[1]),
            (ContentType::Radio, &radio_cats[..], &radio[..])
        );
        let positions: Vec<i64> = parts[0].rows.iter().map(|r| r.position).collect();
        assert_eq!(
            positions,
            [0, 3, 4, 5],
            "junk is not counted, a row without id is"
        );
        assert_eq!(parts[1].rows[0].position, 2);

        // Movies, from an object keyed by index.
        let parsed: LenientVec<RawVod> = decode(movies, "movies").unwrap();
        let rows: Vec<ItemRow> = parsed
            .items
            .into_iter()
            .enumerate()
            .filter_map(|(i, r)| vod_row("s", i as i64, r))
            .map(with_title_base)
            .collect();
        let parts = map_kind(Kind::Movies, "s", movies, cats.clone()).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(
            part_rows(&parts[0]),
            (ContentType::Movie, &cats[..], &rows[..])
        );
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.title_base.is_some()));

        // Series.
        let parsed: LenientVec<RawSeries> = decode(series, "series").unwrap();
        let rows: Vec<ItemRow> = parsed
            .items
            .into_iter()
            .enumerate()
            .filter_map(|(i, r)| series_row("s", i as i64, r))
            .map(with_title_base)
            .collect();
        let parts = map_kind(Kind::Series, "s", series, Vec::new()).unwrap();
        assert_eq!(
            part_rows(&parts[0]),
            (ContentType::Series, &[][..], &rows[..])
        );
        assert_eq!(rows[1].position, 1);

        // No list at all, and unreadable answers.
        for empty in [&b""[..], b"null", b"false", b"{}"] {
            let parts = map_kind(Kind::Movies, "s", empty, Vec::new()).unwrap();
            assert!(parts[0].rows.is_empty());
        }
        for (bad, label) in [
            (&b"<html>Please log in</html>"[..], "movies"),
            (b"[{\"stream_id\": 1}, {", "movies"),
            (b"1.5", "movies"),
        ] {
            let old = decode::<LenientVec<RawVod>>(bad, label).unwrap_err();
            let new = map_kind(Kind::Movies, "s", bad, Vec::new()).err().unwrap();
            assert!(matches!(new, CoreError::Invalid(_)), "{new:?}");
            assert_eq!(new.to_string(), old.to_string());
        }
    }

    #[test]
    fn plan_from_types() {
        assert_eq!(SyncPlan::from_types(None), SyncPlan::ALL);
        assert_eq!(SyncPlan::from_types(Some(&[])), SyncPlan::ALL);
        let p = SyncPlan::from_types(Some(&[ContentType::Radio]));
        assert!(p.live && !p.movies && !p.series);
    }

    #[test]
    fn maps_live_rows() {
        let r: RawLive = parse(json!({
            "num": "7", "name": "BBC One", "stream_id": 101, "stream_icon": "http://x/l.png",
            "epg_channel_id": "bbc1.uk", "category_ids": [3, 4], "tv_archive": 1,
            "tv_archive_duration": "3", "added": "1700000000", "is_adult": 0
        }));
        let row = live_row("s", 0, r).unwrap();
        assert_eq!(row.item_id, "101");
        assert_eq!(row.category_id, "3");
        assert_eq!(row.number, Some(7));
        assert_eq!(row.archive_hours, Some(72));
        assert_eq!(row.added.as_deref(), Some("2023-11-14T22:13:20Z"));
        assert_eq!(extra_value(&row)["isAdult"], false);
        assert!(
            row.url.is_none(),
            "credentials must not be stored in items.url"
        );

        let radio: RawLive =
            parse(json!({"stream_id": "9", "stream_type": "radio_streams", "tv_archive": 1}));
        let row = live_row("s", 1, radio).unwrap();
        assert!(row.is_radio);
        assert_eq!(row.content_type, ContentType::Radio);
        assert_eq!(row.archive_hours, Some(24));
        assert_eq!(row.title, "Channel 9");
        assert_eq!(row.category_id, "0");

        assert!(live_row("s", 0, parse(json!({"name": "no id"}))).is_none());
    }

    #[test]
    fn huge_archive_duration_is_clamped_not_overflowed() {
        // `9223372036854775807 * 24` used to overflow (debug panic).
        for days in [json!(i64::MAX), json!("9223372036854775807"), json!(1e300)] {
            let r: RawLive =
                parse(json!({"stream_id": 1, "tv_archive": 1, "tv_archive_duration": days}));
            let row = live_row("s", 0, r).unwrap();
            assert!(
                row.archive_hours
                    .is_some_and(|h| (24..=366 * 24).contains(&h)),
                "{:?}",
                row.archive_hours
            );
        }
    }

    #[test]
    fn maps_vod_and_series_rows() {
        let v: RawVod = parse(json!({
            "name": "Film (2019)", "stream_id": "201", "stream_icon": "http://x/p.jpg",
            "rating": "N/A", "rating_5based": "3.5", "category_id": 10, "container_extension": "MKV",
            "tmdb": "550", "added": "1700000000"
        }));
        let row = vod_row("s", 0, v).unwrap();
        assert_eq!(row.rating, Some(7.0));
        assert_eq!(row.container_extension.as_deref(), Some("mkv"));
        assert_eq!(extra_value(&row)["tmdbId"], 550);
        assert_eq!(row.category_id, "10");

        let s: RawSeries = parse(json!({
            "name": "Show", "series_id": 301, "cover": "http://x/c.jpg",
            "backdrop_path": "http://x/b.jpg", "releaseDate": "2018-03-01", "rating": "8.25",
            "genre": "Drama, Crime", "last_modified": "1700000000", "category_ids": ["5"]
        }));
        let row = series_row("s", 0, s).unwrap();
        assert_eq!(row.year, Some(2018));
        assert_eq!(row.backdrop_url.as_deref(), Some("http://x/b.jpg"));
        assert_eq!(row.rating, Some(8.3));
        assert_eq!(extra_value(&row)["genres"], json!(["Drama", "Crime"]));
        assert_eq!(row.category_id, "5");
    }

    #[test]
    fn categories_dedupe_and_split() {
        let cats = map_categories(parse(json!([
            {"category_id": "1", "category_name": "News"},
            {"category_id": 1, "category_name": "Dup"},
            {"category_id": "2", "category_name": "Radio"},
            {"category_name": "no id"}
        ])));
        assert_eq!(cats.len(), 2);
        assert_eq!(cats[1].position, 1);
        let live = vec![ItemRow {
            category_id: "1".into(),
            ..ItemRow::default()
        }];
        let radio = vec![ItemRow {
            category_id: "2".into(),
            is_radio: true,
            ..ItemRow::default()
        }];
        let (l, r) = split_categories(&cats, &live, &radio);
        assert_eq!(l.len(), 1);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name, "Radio");
    }

    fn catalog_db(sid: &str) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', 'X', '{}')",
            [sid],
        )
        .unwrap();
        conn
    }

    fn item(sid: &str, ct: ContentType, id: &str) -> ItemRow {
        ItemRow {
            source_id: sid.into(),
            content_type: ct,
            item_id: id.into(),
            category_id: "c".into(),
            title: id.into(),
            ..ItemRow::default()
        }
    }

    fn part(ct: ContentType, rows: Vec<ItemRow>) -> CatalogPart {
        CatalogPart {
            content_type: ct,
            categories: vec![CategoryRow {
                category_id: "c".into(),
                name: "C".into(),
                position: 0,
            }],
            rows,
        }
    }

    fn item_ids(conn: &Connection, sid: &str, ct: ContentType) -> Vec<String> {
        let mut st = conn
            .prepare("SELECT item_id FROM items WHERE source_id = ?1 AND content_type = ?2 ORDER BY item_id")
            .unwrap();
        st.query_map(rusqlite::params![sid, ct.as_str()], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn replace_catalogs_writes_every_part() {
        let sid = "s-ok";
        let mut conn = catalog_db(sid);
        let mut offered = 0;
        let counts = replace_catalogs(
            &mut conn,
            sid,
            vec![
                part(ContentType::Live, vec![item(sid, ContentType::Live, "l1")]),
                part(
                    ContentType::Movie,
                    vec![
                        item(sid, ContentType::Movie, "m1"),
                        item(sid, ContentType::Movie, "m1"),
                    ],
                ),
            ],
            None,
            &mut |_| offered += 1,
        )
        .unwrap();
        assert_eq!(offered, 3);
        assert_eq!(counts[&ContentType::Live], 1);
        assert_eq!(counts[&ContentType::Movie], 1, "duplicate not counted");
        assert_eq!(item_ids(&conn, sid, ContentType::Live), ["l1"]);
        assert_eq!(item_ids(&conn, sid, ContentType::Movie), ["m1"]);
    }

    /// B9-D38: a failure in a later content type (here a row of the wrong
    /// type; a cancel takes the same rollback path) used to leave the earlier
    /// types committed. Now every type keeps its old catalog.
    #[test]
    fn replace_catalogs_rolls_back_every_part_on_error() {
        let sid = "s-err";
        let mut conn = catalog_db(sid);
        replace_catalogs(
            &mut conn,
            sid,
            vec![
                part(
                    ContentType::Live,
                    vec![item(sid, ContentType::Live, "old-l")],
                ),
                part(
                    ContentType::Movie,
                    vec![item(sid, ContentType::Movie, "old-m")],
                ),
            ],
            None,
            &mut |_| {},
        )
        .unwrap();
        let err = replace_catalogs(
            &mut conn,
            sid,
            vec![
                part(
                    ContentType::Live,
                    vec![item(sid, ContentType::Live, "new-l")],
                ),
                part(
                    ContentType::Movie,
                    vec![item(sid, ContentType::Series, "bad")],
                ),
            ],
            None,
            &mut |_| {},
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
        assert_eq!(item_ids(&conn, sid, ContentType::Live), ["old-l"]);
        assert_eq!(item_ids(&conn, sid, ContentType::Movie), ["old-m"]);
    }

    /// Review R2-1: the writer looked its cancel token up inside db_call. When
    /// the pool or the write lock was slow, the run's registration was gone by
    /// then (no token, or a newer run's), and a cancelled run committed. The
    /// run's token is now passed in and honoured with nothing registered.
    #[test]
    fn replace_catalogs_honours_the_run_token_without_a_registered_writer() {
        let sid = "s-tok";
        let mut conn = catalog_db(sid);
        replace_catalogs(
            &mut conn,
            sid,
            vec![part(
                ContentType::Live,
                vec![item(sid, ContentType::Live, "old-l")],
            )],
            None,
            &mut |_| {},
        )
        .unwrap();
        assert!(crate::sources::writer_cancel_token(&conn, sid).is_none());
        // Cancelled mid-write: the writer's own check (taken at begin) and the
        // pre-commit check both see it.
        let token = tokio_util::sync::CancellationToken::new();
        let fire = token.clone();
        let err = replace_catalogs(
            &mut conn,
            sid,
            vec![part(
                ContentType::Live,
                vec![item(sid, ContentType::Live, "new-l")],
            )],
            Some(token),
            &mut |_| fire.cancel(),
        )
        .unwrap_err();
        assert!(crate::sources::is_cancelled_error(&err), "{err:?}");
        assert_eq!(item_ids(&conn, sid, ContentType::Live), ["old-l"]);
        // The same token, checked by CatalogWriter itself.
        let tx = conn.transaction().unwrap();
        let w = catalog::CatalogWriter::begin(&tx, sid, &[ContentType::Live], Some(fire.clone()))
            .unwrap();
        assert!(crate::sources::is_cancelled_error(
            &w.finish(&[(ContentType::Live, Vec::new())]).unwrap_err()
        ));
    }
}
