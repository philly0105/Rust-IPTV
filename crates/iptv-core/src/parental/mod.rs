//! `parental` module (contract C2): PIN-protected parental controls.
//!
//! - Storage (migration `0011_parental.sql`): `parental_config`, one row with
//!   the PIN hash and salt, mode, `auto_adult`, `unlock_minutes` and the
//!   wrong-PIN counter; `parental_locks`, category and item locks per source
//!   and content type.
//! - The PIN is 4 to 8 ASCII digits, kept as a salted PBKDF2-HMAC-SHA256
//!   hash ([`pin`]) and compared in constant time. It is never returned by a
//!   command, written to a log, or exported in a backup.
//! - Five wrong PINs in a row start a lockout of 30 s that doubles with each
//!   further wrong PIN, up to 300 s. The counter survives a restart.
//! - The session unlock lives in memory only ([`Runtime`]). Expiry is found
//!   lazily on every parental and catalog call and by a timer task started
//!   from [`init`]; both emit [`CHANGED_EVENT`].
//! - Hide mode ([`hide_filter`] returns `Some`) drops locked items from the
//!   catalog and user-state readers through the SQL in [`filter`]. Ask mode
//!   filters nothing here; the UI asks for the PIN.
//! - [`is_adult_category`] drives the `autoAdult` option, in Rust and as the
//!   `adult_category(name)` SQL function ([`register_sql`]).
//!
//! See `docs/architecture/parental.md`.

pub mod filter;
mod pin;
pub mod rpc;
mod store;

use crate::error::{CoreError, CoreResult, RpcError};
use crate::model::{ContentType, ItemRef};
use crate::state::AppState;
use chrono::{DateTime, Utc};
use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

pub use crate::model::{
    ParentalLock, ParentalLockKind, ParentalLockTarget, ParentalMode, ParentalStatus,
    DEFAULT_PARENTAL_UNLOCK_MINUTES,
};
pub use store::{LOCKOUT_AFTER, LOCKOUT_BASE_SECS, LOCKOUT_MAX_SECS};

/// Event emitted on every parental state change; payload [`ParentalStatus`].
pub const CHANGED_EVENT: &str = "parental.changed";

/// Longest session unlock `parental.configure` accepts (12 hours).
pub const MAX_UNLOCK_MINUTES: u32 = 720;
/// Accepted PIN length in ASCII digits.
pub const PIN_LENGTH: std::ops::RangeInclusive<usize> = 4..=8;
/// Most items one `parental.check` call may ask about.
pub const MAX_CHECK_ITEMS: usize = 500;

/// Name of the SQL function registered by [`register_sql`].
pub const SQL_FUNCTION: &str = "adult_category";

/// Longest wait of the expiry timer between checks.
const TIMER_MAX_SLEEP: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Adult category names
// ---------------------------------------------------------------------------

/// Tokens that mark a category name as adult (compared case-insensitively).
const ADULT_TOKENS: [&str; 10] = [
    "xxx", "adult", "adults", "18+", "+18", "porn", "erotic", "playboy", "hustler", "private",
];

/// True when a category name marks adult content, for the `autoAdult`
/// option and the `parental.adultCategories` badges.
///
/// Contract (C2): case-insensitive match of `XXX`, `ADULT`, `ADULTS`, `18+`,
/// `+18`, `PORN`, `EROTIC`, `PLAYBOY`, `HUSTLER` or `PRIVATE` as a whole
/// token. A token is a run of letters, digits and `+`; anything else
/// (spaces, `|`, brackets, `-`, `:`) separates tokens, so bracket and pipe
/// tags (`[XXX]`, `|18+|`) are tokens too. "Pornography" or "Adulting" do
/// not match. `ADULT` directly followed by the token `SWIM` is the
/// "Adult Swim" channel brand and is not adult.
pub fn is_adult_category(name: &str) -> bool {
    let mut tokens = name
        .split(|c: char| !(c.is_alphanumeric() || c == '+'))
        .filter(|t| !t.is_empty())
        .peekable();
    while let Some(t) = tokens.next() {
        if !ADULT_TOKENS.iter().any(|k| t.eq_ignore_ascii_case(k)) {
            continue;
        }
        if t.eq_ignore_ascii_case("adult")
            && tokens
                .peek()
                .is_some_and(|n| n.eq_ignore_ascii_case("swim"))
        {
            continue;
        }
        return true;
    }
    false
}

/// Registers `adult_category(name)` on `conn`: 1 for a name
/// [`is_adult_category`] accepts, else 0 (NULL and other non-text values
/// too). Called for every pooled connection through
/// `catalog::language::register`.
pub fn register_sql(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        SQL_FUNCTION,
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(ctx.get_raw(0).as_str().is_ok_and(is_adult_category)),
    )
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// What hide mode removes from one reader call: locked items and categories,
/// and with `auto_adult` the categories whose name marks adult content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hide {
    pub auto_adult: bool,
}

/// An active session unlock; `until: None` lasts until the app restarts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Unlock {
    until: Option<DateTime<Utc>>,
}

const EXT_KEY: &str = "parental_runtime";

/// In-memory state, one per `AppState`.
struct Runtime {
    /// Serializes writes and PIN checks, so concurrent wrong PINs are all
    /// counted and a lockout cannot be raced.
    write: tokio::sync::Mutex<()>,
    /// Cached `parental_config` (no PIN material); `None` until first read.
    config: parking_lot::Mutex<Option<store::Config>>,
    unlock: parking_lot::Mutex<Option<Unlock>>,
    /// Wakes the expiry timer when the unlock or the clock changes.
    wake: tokio::sync::Notify,
    timer_started: AtomicBool,
    /// Test clock offset in milliseconds ([`advance_clock`]).
    offset_ms: AtomicI64,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            write: tokio::sync::Mutex::new(()),
            config: parking_lot::Mutex::new(None),
            unlock: parking_lot::Mutex::new(None),
            wake: tokio::sync::Notify::new(),
            timer_started: AtomicBool::new(false),
            offset_ms: AtomicI64::new(0),
        }
    }
}

impl Runtime {
    fn now(&self) -> DateTime<Utc> {
        Utc::now() + chrono::Duration::milliseconds(self.offset_ms.load(Ordering::SeqCst))
    }

    /// The unlock active at `now`. An expired one is cleared; the flag says
    /// so, and the caller emits the change.
    fn session(&self, now: DateTime<Utc>) -> (Option<Unlock>, bool) {
        let mut u = self.unlock.lock();
        match *u {
            Some(Unlock { until: Some(t) }) if t <= now => {
                *u = None;
                (None, true)
            }
            other => (other, false),
        }
    }

    fn set_unlock(&self, unlock: Option<Unlock>) {
        *self.unlock.lock() = unlock;
        self.wake.notify_one();
    }

    fn cached(&self) -> Option<store::Config> {
        self.config.lock().clone()
    }

    fn cache(&self, cfg: &store::Config) {
        *self.config.lock() = Some(cfg.clone());
    }
}

fn runtime(state: &AppState) -> Arc<Runtime> {
    state.ext_or_insert_with::<Runtime>(EXT_KEY, || Arc::new(Runtime::default()))
}

fn fmt_time(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn status_of(cfg: &store::Config, unlock: Option<Unlock>, now: DateTime<Utc>) -> ParentalStatus {
    let unlock = unlock.filter(|_| cfg.enabled);
    ParentalStatus {
        enabled: cfg.enabled,
        mode: cfg.mode,
        auto_adult: cfg.auto_adult,
        unlock_minutes: cfg.unlock_minutes,
        unlocked: unlock.is_some(),
        unlocked_until: unlock.and_then(|u| u.until).map(fmt_time),
        failed_attempts: cfg.failed_attempts,
        retry_after_seconds: cfg.retry_after(now),
    }
}

/// The config, from the cache or the database. Call with `rt.write` held.
async fn config_held(state: &AppState, rt: &Runtime) -> CoreResult<store::Config> {
    if let Some(c) = rt.cached() {
        return Ok(c);
    }
    let c = state.db_call(|c| store::load_config(c)).await?;
    rt.cache(&c);
    Ok(c)
}

/// The config, from the cache or (first call) the database.
async fn config(state: &AppState, rt: &Runtime) -> CoreResult<store::Config> {
    if let Some(c) = rt.cached() {
        return Ok(c);
    }
    let _w = rt.write.lock().await;
    config_held(state, rt).await
}

fn emit(state: &AppState, status: &ParentalStatus) {
    state.emit(CHANGED_EVENT, status);
}

/// Current status and session; emits [`CHANGED_EVENT`] when the unlock has
/// just expired.
async fn current(state: &AppState) -> CoreResult<(store::Config, Option<Unlock>, ParentalStatus)> {
    let rt = runtime(state);
    let cfg = config(state, &rt).await?;
    let now = rt.now();
    let (unlock, expired) = rt.session(now);
    let status = status_of(&cfg, unlock, now);
    if expired {
        emit(state, &status);
    }
    Ok((cfg, unlock, status))
}

/// `parental.status`.
pub async fn status(state: &AppState) -> CoreResult<ParentalStatus> {
    Ok(current(state).await?.2)
}

/// The hide-mode filter for one reader call: `Some` while a PIN is set, the
/// mode is hide and no session unlock is active. Also the lazy expiry check
/// of every catalog and user-state reader.
pub async fn hide_filter(state: &AppState) -> CoreResult<Option<Hide>> {
    let (cfg, unlock, _) = current(state).await?;
    Ok(
        (cfg.enabled && cfg.mode == ParentalMode::Hide && unlock.is_none()).then_some(Hide {
            auto_adult: cfg.auto_adult,
        }),
    )
}

// ---------------------------------------------------------------------------
// PIN checks
// ---------------------------------------------------------------------------

/// Checks `pin` and records the outcome (call with `rt.write` held). The
/// cached config is refreshed, and a wrong PIN emits the new status.
async fn verify(state: &AppState, rt: &Runtime, pin: &str) -> Result<(), RpcError> {
    let pin = pin.to_string();
    let now = rt.now();
    let (verdict, cfg) = state
        .db_call(move |c| Ok((store::check_pin(c, &pin, now)?, store::load_config(c)?)))
        .await?;
    rt.cache(&cfg);
    let err = match verdict {
        store::Verdict::Correct => return Ok(()),
        store::Verdict::NoPin => {
            return Err(RpcError::invalid(
                "Parental controls are off. Set a PIN first.",
            ))
        }
        store::Verdict::Wrong { failed } => {
            let left = LOCKOUT_AFTER.saturating_sub(failed);
            RpcError::auth(format!(
                "Wrong PIN. {left} {} left before a pause.",
                if left == 1 { "try" } else { "tries" }
            ))
        }
        store::Verdict::LockedOut { retry_after } => lockout_error(retry_after),
    };
    // The counter or the lockout changed (or a refused try during a lockout,
    // which re-sends the same status; harmless).
    let (unlock, _) = rt.session(now);
    emit(state, &status_of(&cfg, unlock, now));
    Err(err)
}

fn lockout_error(retry_after: u64) -> RpcError {
    RpcError::conflict(format!(
        "Too many wrong PINs. Try again in {retry_after} seconds."
    ))
    .retryable(true)
    .with_details(json!({ "retryAfterSeconds": retry_after }))
}

/// Allows a protected change: no PIN set, an active unlock, or a correct
/// `pin`. Call with `rt.write` held.
async fn authorize(
    state: &AppState,
    rt: &Runtime,
    cfg: &store::Config,
    pin: Option<&str>,
    what: &str,
) -> Result<(), RpcError> {
    if !cfg.enabled {
        return Ok(());
    }
    let now = rt.now();
    let (unlock, expired) = rt.session(now);
    if expired {
        emit(state, &status_of(cfg, None, now));
    }
    if unlock.is_some() {
        return Ok(());
    }
    match pin {
        Some(p) => verify(state, rt, p).await,
        None => Err(RpcError::auth(format!("Enter the PIN to {what}."))),
    }
}

/// Stores the new config, emits it and returns the status.
fn publish(state: &AppState, rt: &Runtime, cfg: &store::Config) -> ParentalStatus {
    rt.cache(cfg);
    let now = rt.now();
    let (unlock, _) = rt.session(now);
    let status = status_of(cfg, unlock, now);
    emit(state, &status);
    status
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `parental.setPin`: the first PIN needs no `current`; changing it needs the
/// current PIN. The session unlock state is left as it is.
pub async fn set_pin(
    state: &AppState,
    current: Option<&str>,
    new_pin: &str,
) -> Result<ParentalStatus, RpcError> {
    if !pin::is_valid(new_pin) {
        return Err(RpcError::invalid("newPin must be 4 to 8 digits."));
    }
    let rt = runtime(state);
    let _w = rt.write.lock().await;
    let cfg = config_held(state, &rt).await?;
    if cfg.enabled {
        let Some(current) = current else {
            return Err(RpcError::auth("Enter the current PIN to change it."));
        };
        verify(state, &rt, current).await?;
    }
    let new_pin = new_pin.to_string();
    let cfg = state
        .db_call(move |c| {
            let stored = pin::hash_new(&new_pin);
            store::set_pin(c, &stored)?;
            store::load_config(c)
        })
        .await?;
    tracing::info!("parental PIN set");
    Ok(publish(state, &rt, &cfg))
}

/// `parental.disable`: removes the PIN and ends any unlock. Locks and
/// options stay for when a PIN is set again.
pub async fn disable(state: &AppState, pin: &str) -> Result<ParentalStatus, RpcError> {
    let rt = runtime(state);
    let _w = rt.write.lock().await;
    let cfg = config_held(state, &rt).await?;
    if !cfg.enabled {
        let now = rt.now();
        return Ok(status_of(&cfg, None, now));
    }
    verify(state, &rt, pin).await?;
    let cfg = state
        .db_call(|c| {
            store::clear_pin(c)?;
            store::load_config(c)
        })
        .await?;
    rt.set_unlock(None);
    tracing::info!("parental controls turned off");
    Ok(publish(state, &rt, &cfg))
}

/// `parental.configure`: needs the PIN or an active unlock while a PIN is
/// set. Absent fields keep their value.
pub async fn configure(
    state: &AppState,
    pin: Option<&str>,
    mode: Option<ParentalMode>,
    auto_adult: Option<bool>,
    unlock_minutes: Option<u32>,
) -> Result<ParentalStatus, RpcError> {
    if unlock_minutes.is_some_and(|m| m > MAX_UNLOCK_MINUTES) {
        return Err(RpcError::invalid(format!(
            "unlockMinutes must be between 0 and {MAX_UNLOCK_MINUTES}."
        )));
    }
    let rt = runtime(state);
    let _w = rt.write.lock().await;
    let cfg = config_held(state, &rt).await?;
    authorize(state, &rt, &cfg, pin, "change parental settings").await?;
    let cfg = state
        .db_call(move |c| {
            store::set_options(c, mode, auto_adult, unlock_minutes)?;
            store::load_config(c)
        })
        .await?;
    Ok(publish(state, &rt, &cfg))
}

/// `parental.unlock`: starts a session unlock of `unlockMinutes` (0 = until
/// the app restarts).
pub async fn unlock(state: &AppState, pin: &str) -> Result<ParentalStatus, RpcError> {
    let rt = runtime(state);
    let _w = rt.write.lock().await;
    let cfg = config_held(state, &rt).await?;
    if !cfg.enabled {
        return Err(RpcError::invalid(
            "Parental controls are off. Set a PIN first.",
        ));
    }
    verify(state, &rt, pin).await?;
    let cfg = config_held(state, &rt).await?;
    let now = rt.now();
    let until = (cfg.unlock_minutes > 0)
        .then(|| now + chrono::Duration::minutes(i64::from(cfg.unlock_minutes)));
    rt.set_unlock(Some(Unlock { until }));
    Ok(publish(state, &rt, &cfg))
}

/// `parental.lockNow`: ends the session unlock.
pub async fn lock_now(state: &AppState) -> CoreResult<ParentalStatus> {
    let rt = runtime(state);
    let _w = rt.write.lock().await;
    let cfg = config_held(state, &rt).await?;
    let was = rt.unlock.lock().is_some();
    rt.set_unlock(None);
    let status = status_of(&cfg, None, rt.now());
    if was {
        emit(state, &status);
    }
    Ok(status)
}

/// `parental.locks`.
pub async fn locks(state: &AppState, source_id: Option<String>) -> CoreResult<Vec<ParentalLock>> {
    current(state).await?;
    state
        .db_call(move |c| store::locks(c, source_id.as_deref()))
        .await
}

/// `parental.setLocked`: adding a lock needs no PIN; removing one needs the
/// PIN or an active unlock while a PIN is set.
pub async fn set_locked(
    state: &AppState,
    target: &ParentalLockTarget,
    locked: bool,
    pin: Option<&str>,
) -> Result<(), RpcError> {
    let target = store::validate_target(target)?;
    let rt = runtime(state);
    let _w = rt.write.lock().await;
    let cfg = config_held(state, &rt).await?;
    if !locked {
        authorize(state, &rt, &cfg, pin, "remove a lock").await?;
    }
    let changed = state
        .db_call(move |c| {
            if locked {
                store::add_lock(c, &target, &crate::db::now_rfc3339())
            } else {
                store::remove_lock(c, &target)
            }
        })
        .await?;
    if changed {
        let now = rt.now();
        let (unlock, _) = rt.session(now);
        emit(state, &status_of(&cfg, unlock, now));
    }
    Ok(())
}

/// `parental.check`: the refs locked right now (none while controls are off
/// or unlocked), whatever the mode.
pub async fn check(
    state: &AppState,
    items: Vec<(ItemRef, Option<String>)>,
) -> Result<Vec<ItemRef>, RpcError> {
    if items.len() > MAX_CHECK_ITEMS {
        return Err(RpcError::invalid(format!(
            "parental.check takes at most {MAX_CHECK_ITEMS} items."
        )));
    }
    let (cfg, unlock, _) = current(state).await?;
    if !cfg.enabled || unlock.is_some() || items.is_empty() {
        return Ok(Vec::new());
    }
    let auto_adult = cfg.auto_adult;
    Ok(state
        .db_call(move |c| store::check(c, &items, auto_adult))
        .await?)
}

/// `parental.adultCategories`: category ids `autoAdult` treats as adult,
/// whether or not the option is on.
pub async fn adult_categories(
    state: &AppState,
    source_id: String,
    content_type: ContentType,
) -> CoreResult<Vec<String>> {
    current(state).await?;
    state
        .db_call(move |c| store::adult_categories(c, &source_id, content_type))
        .await
}

/// Refuses (`Auth`) a change that would remove locks while a PIN is set and
/// no session unlock is active; `what` completes "Unlock parental controls
/// with the PIN to ...". `backup.import` in Replace mode calls it, since
/// replacing every source drops their locks with them; anything else that
/// deletes sources wholesale should too.
pub async fn require_unlocked(state: &AppState, what: &str) -> CoreResult<()> {
    let (cfg, unlock, _) = current(state).await?;
    if cfg.enabled && unlock.is_none() {
        return Err(CoreError::Auth(format!(
            "Parental controls are locked. Unlock them with the PIN to {what}."
        )));
    }
    Ok(())
}

/// [`require_unlocked`] for removing sources: a removed source takes its
/// locks with it, so while controls are locked that needs the PIN first
/// (otherwise removing and re-adding a playlist would shed every lock).
/// `source_id: None` stands for every source. A source with no locks (such
/// as a fresh one a cancelled import takes back) goes without asking.
pub async fn require_unlocked_to_drop_locks(
    state: &AppState,
    source_id: Option<String>,
    what: &str,
) -> CoreResult<()> {
    let (cfg, unlock, _) = current(state).await?;
    if !cfg.enabled || unlock.is_some() {
        return Ok(());
    }
    let has_locks = state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM parental_locks WHERE ?1 IS NULL OR source_id = ?1)",
                [source_id],
                |r| r.get::<_, bool>(0),
            )?)
        })
        .await?;
    if has_locks {
        return require_unlocked(state, what).await;
    }
    Ok(())
}

/// The refs of `items` that hide mode drops right now; empty unless
/// [`hide_filter`] is `Some`. For readers that list items the catalog does
/// not store (Stalker portal pages), which cannot use the SQL in [`filter`].
/// `categoryId` is looked up from the catalog when absent, as in
/// [`check`].
pub async fn hidden(
    state: &AppState,
    items: Vec<(ItemRef, Option<String>)>,
) -> CoreResult<Vec<ItemRef>> {
    let Some(hide) = hide_filter(state).await? else {
        return Ok(Vec::new());
    };
    if items.is_empty() {
        return Ok(Vec::new());
    }
    state
        .db_call(move |c| store::check(c, &items, hide.auto_adult))
        .await
}

/// For commands that take a ref directly (provider details): `not_found` while
/// hide mode drops `r`, as `catalog.item` does, so a deep link or a stale
/// route cannot open a hidden title.
pub async fn refuse_hidden(state: &AppState, r: &ItemRef) -> CoreResult<()> {
    if hidden(state, vec![(r.clone(), None)]).await?.is_empty() {
        return Ok(());
    }
    Err(CoreError::NotFound(format!(
        "catalog item {} is locked by parental controls; unlock them to open it",
        r.item_id
    )))
}

// ---------------------------------------------------------------------------
// Backup (wired by `crate::backup`)
// ---------------------------------------------------------------------------

/// Options for a backup: `{mode, autoAdult, unlockMinutes}`. Never the PIN
/// hash or salt.
pub fn backup_options(conn: &Connection) -> CoreResult<Value> {
    let c = store::load_config(conn)?;
    Ok(json!({
        "mode": c.mode.as_str(),
        "autoAdult": c.auto_adult,
        "unlockMinutes": c.unlock_minutes,
    }))
}

/// Every lock for a backup, grouped by source id; each lock is
/// `{contentType, kind, targetId, name, createdAt}`.
pub fn backup_locks(conn: &Connection) -> CoreResult<HashMap<String, Vec<Value>>> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for l in store::locks(conn, None)? {
        out.entry(l.source_id).or_default().push(json!({
            "contentType": l.content_type.as_str(),
            "kind": l.kind.as_str(),
            "targetId": l.target_id,
            "name": l.name,
            "createdAt": l.created_at,
        }));
    }
    Ok(out)
}

/// Adds the locks of a backup entry to `source_id` (existing locks stay).
/// Returns `(added, skipped)`; malformed rows are skipped.
pub fn restore_locks(
    conn: &Connection,
    source_id: &str,
    rows: &[Value],
) -> CoreResult<(usize, usize)> {
    let mut added = 0;
    let mut skipped = 0;
    for v in rows {
        let field = |k: &str| v.get(k).and_then(Value::as_str);
        let parsed = (
            field("contentType").and_then(|s| s.parse::<ContentType>().ok()),
            field("kind").and_then(|s| s.parse::<ParentalLockKind>().ok()),
            field("targetId"),
        );
        let (Some(content_type), Some(kind), Some(target_id)) = parsed else {
            skipped += 1;
            continue;
        };
        let target = ParentalLockTarget {
            source_id: source_id.to_string(),
            content_type,
            kind,
            target_id: target_id.to_string(),
            name: field("name").unwrap_or_default().to_string(),
        };
        let Ok(target) = store::validate_target(&target) else {
            skipped += 1;
            continue;
        };
        // Same second-precision form as a lock added now, so a restored
        // lock lists and exports exactly as it was.
        let created_at = field("createdAt")
            .and_then(crate::userstate::normalize_ts_str)
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|d| {
                d.with_timezone(&Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            })
            .unwrap_or_else(crate::db::now_rfc3339);
        if store::add_lock(conn, &target, &created_at)? {
            added += 1;
        }
    }
    Ok((added, skipped))
}

/// Applies a backup's `{mode, autoAdult, unlockMinutes}`. While a PIN is set
/// and no unlock is active the options are left alone (a backup must not
/// weaken the controls) and a warning says so. Invalid fields are skipped
/// with a warning. Returns true when something changed (the change is
/// emitted).
pub async fn restore_options(
    state: &AppState,
    v: &Value,
    warnings: &mut Vec<String>,
) -> CoreResult<bool> {
    if !v.is_object() {
        warnings.push("Parental settings in the backup were not readable and were skipped".into());
        return Ok(false);
    }
    let mode = match v.get("mode") {
        None | Some(Value::Null) => None,
        Some(m) => match m.as_str().and_then(|s| s.parse::<ParentalMode>().ok()) {
            Some(m) => Some(m),
            None => {
                warnings.push("Parental mode in the backup is not valid and was skipped".into());
                None
            }
        },
    };
    let auto_adult = match v.get("autoAdult") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            warnings.push("Parental autoAdult in the backup is not valid and was skipped".into());
            None
        }
    };
    let unlock_minutes = match v.get("unlockMinutes") {
        None | Some(Value::Null) => None,
        Some(n) => match n.as_u64().filter(|m| *m <= u64::from(MAX_UNLOCK_MINUTES)) {
            Some(m) => Some(m as u32),
            None => {
                warnings.push(format!(
                    "Parental unlockMinutes in the backup must be 0 to {MAX_UNLOCK_MINUTES} and was skipped"
                ));
                None
            }
        },
    };
    if mode.is_none() && auto_adult.is_none() && unlock_minutes.is_none() {
        return Ok(false);
    }
    let rt = runtime(state);
    let _w = rt.write.lock().await;
    let cfg = config_held(state, &rt).await?;
    let (unlock, _) = rt.session(rt.now());
    if cfg.enabled && unlock.is_none() {
        warnings.push(
            "Parental settings in the backup were not applied: parental controls are on and locked. Unlock them and import again to apply them.".into(),
        );
        return Ok(false);
    }
    let next = state
        .db_call(move |c| {
            store::set_options(c, mode, auto_adult, unlock_minutes)?;
            store::load_config(c)
        })
        .await?;
    if next == cfg {
        return Ok(false);
    }
    publish(state, &rt, &next);
    Ok(true)
}

/// Emits the current status after a change made outside the commands
/// (backup import of locks).
pub async fn announce(state: &AppState) -> CoreResult<()> {
    let status = status(state).await?;
    emit(state, &status);
    Ok(())
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

/// Starts the unlock-expiry timer (once). Called from
/// [`crate::rpc::init_all`].
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let rt = runtime(&state);
    if rt.timer_started.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // Warm the cache so the first catalog call does not read the row.
    config(&state, &rt).await?;
    let weak = Arc::downgrade(&state);
    drop(state);
    tokio::spawn(run_timer(weak, rt));
    Ok(())
}

async fn run_timer(weak: Weak<AppState>, rt: Arc<Runtime>) {
    loop {
        let wait = match *rt.unlock.lock() {
            Some(Unlock { until: Some(t) }) => (t - rt.now())
                .to_std()
                .unwrap_or(Duration::ZERO)
                .min(TIMER_MAX_SLEEP),
            _ => TIMER_MAX_SLEEP,
        };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = rt.wake.notified() => {}
        }
        let Some(state) = weak.upgrade() else {
            return;
        };
        if let Err(err) = current(&state).await {
            tracing::warn!(error = %err, "parental expiry check failed");
        }
    }
}

/// Moves this state's parental clock forward by `by` and wakes the expiry
/// timer. Test hook for unlock expiry and lockouts; the app never calls it.
#[doc(hidden)]
pub fn advance_clock(state: &AppState, by: Duration) {
    let rt = runtime(state);
    let ms = i64::try_from(by.as_millis()).unwrap_or(i64::MAX);
    rt.offset_ms.fetch_add(ms, Ordering::SeqCst);
    rt.wake.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adult_tokens_match_whole_tokens_only() {
        for yes in [
            "XXX",
            "xxx movies",
            "Adult",
            "ADULTS ONLY",
            "adults",
            "18+",
            "Movies 18+",
            "+18 Channels",
            "[XXX] Hot",
            "|XXX| VOD",
            "VOD | ADULT",
            "(18+)",
            "Porn",
            "EROTIC",
            "Playboy TV",
            "HUSTLER HD",
            "Private",
            "US: Adult",
            "Adult Swim Adult",
            "Young Adult Fiction",
            "XXX-Rated",
        ] {
            assert!(is_adult_category(yes), "{yes:?} should be adult");
        }
        for no in [
            "",
            "Adult Swim",
            "ADULT SWIM",
            "adult swim HD",
            "US | Adult Swim",
            "[Adult Swim]",
            "Adult-Swim",
            "Kids",
            "News",
            "Sussex",
            "Pornography",
            "Adulting",
            "XXXL Sports",
            "118+",
            "18",
            "Sky Sports+",
            "Privates",
        ] {
            assert!(!is_adult_category(no), "{no:?} should not be adult");
        }
    }

    #[test]
    fn sql_function_matches_rust() {
        let c = Connection::open_in_memory().unwrap();
        register_sql(&c).unwrap();
        let q = |v: Option<&str>| -> i64 {
            c.query_row("SELECT adult_category(?1)", [v], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(q(Some("[XXX] Hot")), 1);
        assert_eq!(q(Some("Adult Swim")), 0);
        assert_eq!(q(None), 0);
        let n: i64 = c
            .query_row("SELECT adult_category(42)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn status_hides_unlock_while_disabled() {
        let now = Utc::now();
        let cfg = store::Config::default();
        let s = status_of(&cfg, Some(Unlock { until: None }), now);
        assert!(!s.enabled && !s.unlocked && s.unlocked_until.is_none());
        let on = store::Config {
            enabled: true,
            ..store::Config::default()
        };
        let until = now + chrono::Duration::minutes(5);
        let s = status_of(&on, Some(Unlock { until: Some(until) }), now);
        assert!(s.unlocked);
        assert_eq!(s.unlocked_until.as_deref(), Some(fmt_time(until).as_str()));
    }
}
