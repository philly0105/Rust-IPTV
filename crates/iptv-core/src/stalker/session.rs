//! Stalker portal session: endpoint discovery, MAG headers, handshake,
//! profile, token cache (`app_state` key `stalker_token:<sourceId>`), and the
//! single re-handshake on an auth failure.
//!
//! The MAC and token are secrets for logging purposes: they only appear at
//! `trace` level, never in errors or `info`/`warn` lines.

use super::protocol::{self as p, Body, Probe};
use super::Runtime;
use crate::error::{CoreError, CoreResult};
use crate::http::{status_error, with_retry};
use crate::model::StalkerSourceConfig;
use crate::state::AppState;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Default per-request timeout.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for the big list calls (`get_all_channels`, `get_epg_info`).
pub const LONG_TIMEOUT: Duration = Duration::from_secs(90);
/// Timeout used while probing discovery candidates.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts for one portal request (Network/Timeout only).
const ATTEMPTS: u32 = 3;
/// Largest portal answer accepted. `get_all_channels` of a big panel is tens
/// of MB; past this the body is not a portal answer.
pub const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;

/// `app_state` key of a source's cached session.
pub fn token_key(source_id: &str) -> String {
    format!("stalker_token:{source_id}")
}

/// Per-source session state. Persisted (without `profile`) in `app_state`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// Resolved API endpoint (one of the discovery candidates).
    #[serde(default)]
    pub endpoint: Option<String>,
    /// Bearer token; `None` for token-free panels.
    #[serde(default)]
    pub token: Option<String>,
    /// Handshake `random`, reused for profile metrics.
    #[serde(default)]
    pub random: Option<String>,
    /// Fingerprint of the configuration the session was made for.
    #[serde(default)]
    pub identity: String,
    /// Last `get_profile` answer (memory only).
    #[serde(skip)]
    pub profile: Option<Value>,
}

/// Fingerprint of everything that changes what the portal sees: portal URL,
/// MAC, serial, device ids, signatures, login.
pub fn identity_fingerprint(c: &StalkerSourceConfig) -> String {
    json!([
        c.portal_url.trim(),
        c.mac_address.trim(),
        p::normalize_serial(c.serial_number.as_deref()),
        p::identity_value(c.device_id1.as_deref()),
        p::identity_value(c.device_id2.as_deref()),
        p::identity_value(c.signature1.as_deref()),
        p::identity_value(c.signature2.as_deref()),
        p::identity_value(c.username.as_deref()),
        c.is_full_portal,
    ])
    .to_string()
}

/// Validates a config before any request is made.
///
/// The MAC only has to be present and cookie-safe: the 12-hex form is
/// enforced where a MAC is typed (`sources.add`, a changed MAC in
/// `sources.update`), while a stored value (a grandfathered MAC from an old
/// backup such as `MAG-0001`) is sent exactly as stored.
pub fn validate_config(c: &StalkerSourceConfig) -> CoreResult<()> {
    if p::endpoint_candidates(&c.portal_url).is_empty() {
        return Err(CoreError::invalid(
            "Portal URL must be an http(s) address, for example http://portal.example/c/",
        ));
    }
    let mac = c.mac_address.trim();
    if mac.is_empty()
        || mac
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, ';' | ','))
    {
        return Err(CoreError::invalid(
            "Enter the MAC address of the portal subscription, for example 00:1A:79:12:34:56",
        ));
    }
    Ok(())
}

/// User-facing error for a portal that could not be reached at all.
pub fn unreachable_error(portal_url: &str) -> CoreError {
    CoreError::network(format!(
        "{UNREACHABLE_PREFIX}{}. Check the URL and your connection, then try again.",
        portal_host(portal_url)
    ))
}

/// User-facing error for a portal that took the connection but did not
/// answer in time.
pub fn slow_error(portal_url: &str) -> CoreError {
    CoreError::Timeout(format!(
        "{SLOW_PREFIX}{} did not answer in time. Try again later.",
        portal_host(portal_url)
    ))
}

/// `host[:port]` of a URL, or the trimmed input when it does not parse.
fn portal_host(u: &str) -> String {
    match url::Url::parse(u.trim()) {
        Ok(parsed) => match (parsed.host_str(), parsed.port()) {
            (Some(h), Some(port)) => format!("{h}:{port}"),
            (Some(h), None) => h.to_string(),
            _ => u.trim().to_string(),
        },
        Err(_) => u.trim().to_string(),
    }
}

/// A request in flight: query params plus timeout.
#[derive(Debug, Clone)]
pub struct Req {
    pub params: Vec<(String, String)>,
    pub timeout: Duration,
}

impl Req {
    /// `type=<t>&action=<a>` plus extra params.
    pub fn new(t: &str, action: &str) -> Self {
        Self {
            params: vec![("type".into(), t.into()), ("action".into(), action.into())],
            timeout: DEFAULT_TIMEOUT,
        }
    }
    pub fn p(mut self, k: &str, v: impl ToString) -> Self {
        self.params.push((k.to_string(), v.to_string()));
        self
    }
    pub fn opt(self, k: &str, v: Option<impl ToString>) -> Self {
        match v {
            Some(v) => self.p(k, v),
            None => self,
        }
    }
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = d;
        self
    }
    fn label(&self) -> String {
        let get = |k: &str| {
            self.params
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .unwrap_or("?")
        };
        format!("{}/{}", get("type"), get("action"))
    }
}

/// Client bound to one source (or to an unsaved config for `stalker.test`).
#[derive(Clone)]
pub struct StalkerClient {
    state: Arc<AppState>,
    source_id: Option<String>,
    pub config: StalkerSourceConfig,
    mac: String,
    serial: Option<String>,
    session: Arc<tokio::sync::Mutex<SessionState>>,
}

impl StalkerClient {
    /// Client for a saved source; loads its config from `sources.config_json`.
    pub async fn for_source(state: &Arc<AppState>, source_id: &str) -> CoreResult<Self> {
        let config = load_config(state, source_id).await?;
        Self::with_config(state, source_id, config).await
    }

    /// Client for a saved source with an already loaded config.
    pub async fn with_config(
        state: &Arc<AppState>,
        source_id: &str,
        config: StalkerSourceConfig,
    ) -> CoreResult<Self> {
        let runtime = Runtime::get(state);
        let identity = identity_fingerprint(&config);
        let session = runtime
            .sessions
            .entry(source_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(SessionState::default())))
            .clone();
        {
            let mut s = session.lock().await;
            if s.identity != identity {
                // Config changed (or first use): start over, but let the
                // persisted cache revive the session when it still matches.
                *s = SessionState {
                    identity,
                    ..Default::default()
                };
            }
        }
        Self::build(state, Some(source_id.to_string()), config, session)
    }

    /// Ephemeral client for an unsaved config (nothing is persisted).
    pub fn ephemeral(state: &Arc<AppState>, config: StalkerSourceConfig) -> CoreResult<Self> {
        let identity = identity_fingerprint(&config);
        let session = Arc::new(tokio::sync::Mutex::new(SessionState {
            identity,
            ..Default::default()
        }));
        Self::build(state, None, config, session)
    }

    fn build(
        state: &Arc<AppState>,
        source_id: Option<String>,
        config: StalkerSourceConfig,
        session: Arc<tokio::sync::Mutex<SessionState>>,
    ) -> CoreResult<Self> {
        validate_config(&config)?;
        // The stored value goes on the wire verbatim (see `validate_config`).
        let mac = config.mac_address.trim().to_string();
        let serial = p::normalize_serial(config.serial_number.as_deref());
        Ok(Self {
            state: Arc::clone(state),
            source_id,
            config,
            mac,
            serial,
            session,
        })
    }

    /// The MAC as sent to the portal (for `accountInfo`; never log it).
    pub fn mac(&self) -> &str {
        &self.mac
    }

    /// The resolved endpoint, establishing a session first if needed.
    pub async fn endpoint(&self) -> CoreResult<String> {
        Ok(self.ensure_session().await?.0)
    }

    /// Last profile answer, if the session made one.
    pub async fn cached_profile(&self) -> Option<Value> {
        self.session.lock().await.profile.clone()
    }

    // -- request plumbing -------------------------------------------------

    fn headers(&self, token: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        let mut put = |name: HeaderName, value: &str| {
            if let Ok(v) = HeaderValue::from_str(value) {
                h.insert(name, v);
            }
        };
        let ua = p::identity_value(self.config.headers.user_agent.as_deref())
            .unwrap_or_else(|| p::MAG_USER_AGENT.to_string());
        put(reqwest::header::USER_AGENT, &ua);
        put(HeaderName::from_static("x-user-agent"), p::MAG_X_USER_AGENT);
        put(reqwest::header::ACCEPT, "*/*");
        put(
            reqwest::header::COOKIE,
            &p::cookie_header(&self.mac, self.serial.as_deref()),
        );
        if let Some(r) = p::identity_value(self.config.headers.referrer.as_deref()) {
            put(reqwest::header::REFERER, &r);
        }
        if let Some(o) = p::identity_value(self.config.headers.origin.as_deref()) {
            put(reqwest::header::ORIGIN, &o);
        }
        if let Some(sn) = &self.serial {
            put(HeaderName::from_static("sn"), sn);
        }
        if let Some(t) = token.filter(|t| !t.is_empty()) {
            put(reqwest::header::AUTHORIZATION, &format!("Bearer {t}"));
        }
        h
    }

    /// One HTTP exchange with retries. Returns `Js` or `AuthFailure`;
    /// everything else is an error (`Empty` Network, `Html`/garbage Invalid).
    async fn raw(
        &self,
        endpoint: &str,
        req: &Req,
        token: Option<&str>,
        attempts: u32,
    ) -> CoreResult<Body> {
        let url = p::build_request_url(endpoint, &req.params);
        let label = req.label();
        let headers = self.headers(token);
        with_retry(attempts, || {
            let url = url.clone();
            let headers = headers.clone();
            let label = label.clone();
            async move {
                tracing::trace!(%label, "stalker request");
                // Server mode: guarded client, portal host:port trusted.
                let request = crate::http::trusted_client(&self.state, &self.config.portal_url)
                    .get(&url)
                    .headers(headers)
                    .timeout(req.timeout);
                // The head deadline is the request's own deadline: portals
                // build big replies (get_all_channels) before answering.
                let resp = crate::http::send_within(request, req.timeout)
                    .await
                    .map_err(|e| send_error(e, &url))?;
                let status = resp.status();
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Ok(Body::AuthFailure(format!("HTTP {}", status.as_u16())));
                }
                if !status.is_success() {
                    return Err(status_error(status, &format!("Stalker {label}")));
                }
                // Capped read (was `resp.text()`, unbounded): the request
                // timeout alone lets a fast hostile server fill memory.
                // reqwest runs without its `charset` feature, so `text()`
                // was UTF-8 lossy too.
                let body =
                    crate::http::read_capped(resp, &format!("Stalker {label}"), MAX_BODY_BYTES)
                        .await?;
                let text = String::from_utf8_lossy(&body);
                match p::classify_body(&text) {
                    b @ (Body::Js(_) | Body::AuthFailure(_)) => Ok(b),
                    Body::Empty => Err(CoreError::network(format!(
                        "Stalker {label}: the portal sent an empty response"
                    ))),
                    Body::Html => Err(CoreError::invalid(format!(
                        "Stalker {label}: the portal answered with an HTML page instead of data"
                    ))),
                    Body::Unexpected => Err(CoreError::invalid(format!(
                        "Stalker {label}: the portal answer is not a Stalker response"
                    ))),
                }
            }
        })
        .await
    }

    /// Authenticated call returning `js`. On an auth failure the session
    /// re-handshakes once and the call is retried once.
    pub async fn call(&self, req: Req) -> CoreResult<Value> {
        let (endpoint, token) = self.ensure_session().await?;
        match self
            .raw(&endpoint, &req, token.as_deref(), ATTEMPTS)
            .await?
        {
            Body::Js(v) => return Ok(v),
            Body::AuthFailure(_) => {}
            _ => unreachable!("raw only returns Js or AuthFailure"),
        }
        tracing::debug!(label = %req.label(), "stalker auth failure, re-handshaking once");
        let (endpoint, token) = self.reauth(token).await?;
        match self.raw(&endpoint, &req, token.as_deref(), ATTEMPTS).await? {
            Body::Js(v) => Ok(v),
            _ => Err(CoreError::Auth(
                "The portal refused the request after a fresh login. Check the MAC address and subscription.".into(),
            )),
        }
    }

    // -- session lifecycle ------------------------------------------------

    /// Returns `(endpoint, token)`, discovering and logging in when needed.
    pub async fn ensure_session(&self) -> CoreResult<(String, Option<String>)> {
        let mut s = self.session.lock().await;
        if let Some(ep) = &s.endpoint {
            if s.token.is_some() || !self.config.is_full_portal {
                return Ok((ep.clone(), s.token.clone()));
            }
        }
        if s.endpoint.is_none() {
            if let Some(saved) = self.load_persisted().await {
                if saved.identity == s.identity
                    && saved.endpoint.is_some()
                    && (saved.token.is_some() || !self.config.is_full_portal)
                {
                    let profile = s.profile.take();
                    *s = SessionState { profile, ..saved };
                    return Ok((s.endpoint.clone().unwrap_or_default(), s.token.clone()));
                }
            }
        }
        self.establish(&mut s).await?;
        Ok((s.endpoint.clone().unwrap_or_default(), s.token.clone()))
    }

    /// Single-flight re-login: when another task already replaced `failed`,
    /// its token is reused instead of handshaking again.
    async fn reauth(&self, failed: Option<String>) -> CoreResult<(String, Option<String>)> {
        let mut s = self.session.lock().await;
        if s.token.is_some() && s.token != failed {
            return Ok((s.endpoint.clone().unwrap_or_default(), s.token.clone()));
        }
        match s.endpoint.clone() {
            Some(ep) => {
                // Known endpoint: re-login there (token-free panels that start
                // refusing are repaired the same way).
                let ok = self.login(&mut s, &ep).await;
                if let Err(err) = ok {
                    if !matches!(err, CoreError::Auth(_)) {
                        // The endpoint may have moved: rediscover from scratch.
                        s.endpoint = None;
                        s.token = None;
                        self.establish(&mut s).await?;
                    } else {
                        return Err(err);
                    }
                }
            }
            None => self.establish(&mut s).await?,
        }
        self.persist(&s).await;
        Ok((s.endpoint.clone().unwrap_or_default(), s.token.clone()))
    }

    /// Discovers the endpoint (probing candidates in order) and logs in.
    async fn establish(&self, s: &mut SessionState) -> CoreResult<()> {
        let candidates = p::endpoint_candidates(&self.config.portal_url);
        let mut first_err: Option<CoreError> = None;
        for candidate in candidates {
            let outcome = if self.config.is_full_portal {
                self.login(s, &candidate).await
            } else {
                self.probe_token_free(s, &candidate).await
            };
            match outcome {
                Ok(()) => {
                    s.endpoint = Some(candidate);
                    self.persist(s).await;
                    return Ok(());
                }
                // The portal answered and refused us: other paths will not help.
                Err(err @ CoreError::Auth(_)) => return Err(err),
                Err(err) => {
                    tracing::debug!(error = %err, "stalker endpoint candidate rejected");
                    // Every candidate lives on the same host: when it did not
                    // answer at all, the other paths will not either.
                    let host_down = is_unreachable(&err);
                    let better = match (&first_err, &err) {
                        (None, _) => true,
                        (Some(CoreError::NotFound(_)), e) => !matches!(e, CoreError::NotFound(_)),
                        _ => false,
                    };
                    if better || host_down {
                        first_err = Some(err);
                    }
                    if host_down {
                        break;
                    }
                }
            }
        }
        Err(match first_err {
            Some(CoreError::NotFound(_)) | Some(CoreError::Invalid(_)) | None => CoreError::NotFound(
                "No Stalker portal answered at this address. Check the portal URL (it usually ends in /c/).".into(),
            ),
            // Nothing answered at all (refused, DNS): say so plainly.
            Some(CoreError::Network(_)) => unreachable_error(&self.config.portal_url),
            // The host took the connection and then stayed silent.
            Some(CoreError::Timeout(_)) => slow_error(&self.config.portal_url),
            Some(other) => other,
        })
    }

    /// Token-free panel probe: `itv/get_genres` without a token.
    async fn probe_token_free(&self, s: &mut SessionState, endpoint: &str) -> CoreResult<()> {
        let req = Req::new("itv", "get_genres").timeout(PROBE_TIMEOUT);
        let body = self.raw(endpoint, &req, None, 1).await?;
        match p::classify_probe(&body) {
            Probe::Data => {
                s.token = None;
                Ok(())
            }
            // It is a portal after all, and it wants a token.
            Probe::AuthRequired => self.login(s, endpoint).await,
            Probe::NotAPortal => Err(CoreError::invalid("not a Stalker portal endpoint")),
        }
    }

    /// Handshake + profile (+ do_auth when the portal asks for a login).
    async fn login(&self, s: &mut SessionState, endpoint: &str) -> CoreResult<()> {
        let hs = Req::new("stb", "handshake")
            .p("token", "")
            .p("prehash", p::prehash(&self.mac))
            .timeout(PROBE_TIMEOUT);
        let js = match self.raw(endpoint, &hs, None, 1).await? {
            Body::Js(js) => js,
            // A web server guarding a wrong path, not the portal refusing us.
            Body::AuthFailure(m) if m.starts_with("HTTP ") => {
                return Err(CoreError::invalid(
                    "not a Stalker portal endpoint (HTTP refusal)",
                ))
            }
            _ => {
                return Err(CoreError::Auth(
                    "The portal refused the handshake for this MAC address.".into(),
                ))
            }
        };
        let token = js.get("token").and_then(p::str_of).ok_or_else(|| {
            CoreError::invalid("not a Stalker portal endpoint (handshake returned no token)")
        })?;
        let random = js
            .get("random")
            .and_then(p::str_of)
            .unwrap_or_else(p::random_hex40);
        let not_valid = p::flag_enabled(js.get("not_valid"));
        s.token = Some(token);
        s.random = Some(random);

        let mut profile = self.get_profile(endpoint, s, not_valid, false).await?;
        if profile_status(&profile) == Some(2) {
            self.do_auth(endpoint, s).await?;
            profile = self.get_profile(endpoint, s, not_valid, true).await?;
        }
        check_profile(&profile, &self.mac)?;
        s.profile = Some(profile);
        Ok(())
    }

    async fn get_profile(
        &self,
        endpoint: &str,
        s: &SessionState,
        not_valid: bool,
        second_step: bool,
    ) -> CoreResult<Value> {
        let random = s.random.clone().unwrap_or_default();
        let mut metrics =
            json!({"mac": self.mac, "model": "MAG250", "type": "STB", "random": random});
        if let Some(sn) = &self.serial {
            metrics["sn"] = json!(sn);
        }
        let mut req = Req::new("stb", "get_profile");
        for (k, v) in p::STB_PROFILE_PARAMS {
            req = req.p(k, v);
        }
        let c = &self.config;
        let req = req
            .p("not_valid_token", u8::from(not_valid))
            .p("auth_second_step", u8::from(second_step))
            .p("metrics", metrics.to_string())
            .opt("sn", self.serial.clone())
            .opt("device_id", p::identity_value(c.device_id1.as_deref()))
            .opt("device_id2", p::identity_value(c.device_id2.as_deref()))
            .opt("signature", p::identity_value(c.signature1.as_deref()))
            .opt("signature2", p::identity_value(c.signature2.as_deref()))
            .p("prehash", p::prehash(&self.mac))
            .timeout(PROBE_TIMEOUT);
        match self.raw(endpoint, &req, s.token.as_deref(), 1).await? {
            Body::Js(v) => Ok(v),
            _ => Err(CoreError::Auth(
                "The portal refused this device. Check the MAC address and device ids.".into(),
            )),
        }
    }

    async fn do_auth(&self, endpoint: &str, s: &SessionState) -> CoreResult<()> {
        let c = &self.config;
        let (Some(login), Some(password)) = (
            p::identity_value(c.username.as_deref()),
            c.password.clone().filter(|p| !p.is_empty()),
        ) else {
            return Err(CoreError::Auth(
                "This portal requires a username and password.".into(),
            ));
        };
        let req = Req::new("stb", "do_auth")
            .p("login", login)
            .p("password", password)
            .opt("device_id", p::identity_value(c.device_id1.as_deref()))
            .opt("device_id2", p::identity_value(c.device_id2.as_deref()))
            .timeout(PROBE_TIMEOUT);
        match self.raw(endpoint, &req, s.token.as_deref(), 1).await? {
            Body::Js(v) if p::flag_enabled(Some(&v)) => Ok(()),
            _ => Err(CoreError::Auth(
                "The portal rejected the username or password.".into(),
            )),
        }
    }

    // -- persistence --------------------------------------------------------

    async fn load_persisted(&self) -> Option<SessionState> {
        let id = self.source_id.clone()?;
        let raw: Option<String> = self
            .state
            .db_call(move |conn| {
                Ok(conn
                    .query_row(
                        "SELECT value FROM app_state WHERE key = ?1",
                        [token_key(&id)],
                        |r| r.get(0),
                    )
                    .optional()?)
            })
            .await
            .ok()
            .flatten();
        serde_json::from_str(&raw?).ok()
    }

    async fn persist(&self, s: &SessionState) {
        let Some(id) = self.source_id.clone() else {
            return;
        };
        let Ok(value) = serde_json::to_string(s) else {
            return;
        };
        let res = self
            .state
            .db_call(move |conn| {
                conn.execute(
                    "INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    rusqlite::params![token_key(&id), value],
                )?;
                Ok(())
            })
            .await;
        if let Err(err) = res {
            tracing::warn!(error = %err, "could not cache the Stalker session");
        }
    }
}

const UNREACHABLE_PREFIX: &str = "Could not reach the portal at ";
const SLOW_PREFIX: &str = "The portal at ";

/// Maps a failed send (no HTTP answer, from [`crate::http::send_within`]) to
/// a portal-specific message; the URL is reduced to its host. A request the
/// server-mode guard refused (`Invalid`) keeps its own explanation.
fn send_error(err: CoreError, url: &str) -> CoreError {
    match err {
        CoreError::Timeout(_) => slow_error(url),
        CoreError::Network(_) => unreachable_error(url),
        other => other,
    }
}

/// True for [`send_error`] results: the host gave no HTTP answer at all.
pub(crate) fn is_unreachable(err: &CoreError) -> bool {
    match err {
        CoreError::Network(m) => m.starts_with(UNREACHABLE_PREFIX),
        CoreError::Timeout(m) => m.starts_with(SLOW_PREFIX),
        _ => false,
    }
}

/// Reads and parses a stalker source's config.
pub async fn load_config(state: &AppState, source_id: &str) -> CoreResult<StalkerSourceConfig> {
    let id = source_id.to_string();
    let row: Option<(String, String)> = state
        .db_call(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT kind, config_json FROM sources WHERE id = ?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?)
        })
        .await?;
    let (kind, json) =
        row.ok_or_else(|| CoreError::not_found(format!("source {source_id} does not exist")))?;
    if kind != "stalker" {
        return Err(CoreError::invalid(format!(
            "source {source_id} is not a Stalker portal"
        )));
    }
    serde_json::from_str(&json).map_err(|e| {
        CoreError::invalid(format!(
            "source {source_id} has an unreadable Stalker config: {e}"
        ))
    })
}

/// Replaces every spelling of `mac` (any case, `:`/`-` separators) in `text`.
pub fn redact_mac(text: &str, mac: &str) -> String {
    let digits: String = mac.chars().filter(char::is_ascii_hexdigit).collect();
    if digits.len() != 12 {
        return text.to_string();
    }
    let pairs: Vec<String> = digits
        .as_bytes()
        .chunks(2)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect();
    let pattern = format!("(?i){}", pairs.join("[:.-]?"));
    match regex::Regex::new(&pattern) {
        Ok(re) => re.replace_all(text, "this MAC").into_owned(),
        Err(_) => text.to_string(),
    }
}

fn profile_status(profile: &Value) -> Option<i64> {
    profile.get("status").and_then(p::int_of)
}

/// True when `text` spells out `mac` (any separator, or verbatim).
fn mentions_mac(text: &str, mac: &str) -> bool {
    let mac = mac.trim();
    (!mac.is_empty() && text.to_lowercase().contains(&mac.to_lowercase()))
        || redact_mac(text, mac) != text
}

/// Turns a refusing profile (status 1, or a block message) into an Auth error.
///
/// Portal sentences that spell out the MAC are left out of the message (it
/// travels into `lastError`, events and logs); the rest of the portal's text
/// follows our own explanation.
pub fn check_profile(profile: &Value, mac: &str) -> CoreResult<()> {
    let msg = profile.get("msg").and_then(Value::as_str);
    let block_msg = profile.get("block_msg").and_then(Value::as_str);
    let message = p::combine_messages(msg, block_msg);
    let status = profile_status(profile);
    if status == Some(1) || (message.is_some() && status != Some(0)) {
        let full = message.unwrap_or_default();
        let portal_text = p::combine_messages(
            msg.filter(|t| !mentions_mac(t, mac)),
            block_msg.filter(|t| !mentions_mac(t, mac)),
        );
        if p::is_device_conflict(&full) {
            return Err(CoreError::Auth(format!(
                "{} (the portal has this MAC bound to other device ids; set the matching device ids or ask the provider to reset the binding)",
                portal_text.unwrap_or_else(|| "The portal refused this device.".into())
            )));
        }
        if status == Some(1) {
            let lead = "This MAC address is not registered on the portal. Check the MAC or contact your provider.";
            return Err(CoreError::Auth(match portal_text {
                Some(t) => format!("{lead} Portal message: {t}"),
                None => lead.to_string(),
            }));
        }
        return Err(CoreError::Auth(
            portal_text.unwrap_or_else(|| "The portal blocked this device.".into()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_checks() {
        let mac = "00:1A:79:00:00:01";
        assert!(check_profile(&json!({"status": 0, "id": "1"}), mac).is_ok());
        assert!(check_profile(&json!({"id": "1"}), mac).is_ok());
        assert!(check_profile(&json!({"status": "1"}), mac).is_err());
        let err =
            check_profile(&json!({"status": 1, "msg": "Device ID mismatch"}), mac).unwrap_err();
        assert!(err.to_string().contains("device ids"));
        assert!(check_profile(&json!({"block_msg": "Your account is blocked"}), mac).is_err());
        // A status-0 profile with an informational message is fine.
        assert!(check_profile(&json!({"status": 0, "msg": "Welcome"}), mac).is_ok());
        let err = check_profile(
            &json!({"status": 1, "msg": "MAC address 00:1a:79:00:00:01 is not registered"}),
            mac,
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "auth: This MAC address is not registered on the portal. Check the MAC or contact your provider."
        );
        // The mock/real wording: the MAC sentence is dropped, the rest follows.
        let err = check_profile(
            &json!({"status": 1, "msg": "MAC address 00:1A:79:00:00:01 is not registered",
                    "block_msg": "Your STB is not registered.<br/> Call the provider."}),
            mac,
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "auth: This MAC address is not registered on the portal. Check the MAC or contact your provider. Portal message: Your STB is not registered. Call the provider."
        );
        // A grandfathered non-hex MAC is recognised verbatim too.
        let err = check_profile(
            &json!({"status": 1, "msg": "Unknown device mag-0001"}),
            "MAG-0001",
        )
        .unwrap_err();
        assert!(
            !err.to_string().to_lowercase().contains("mag-0001"),
            "{err}"
        );
        assert_eq!(redact_mac("x 001A79000001 y", mac), "x this MAC y");
    }

    #[test]
    fn unreachable_message_names_the_host() {
        let err = unreachable_error("http://127.0.0.1:9/stalker/c/");
        assert!(err.is_retryable());
        assert_eq!(
            err.to_string(),
            "network: Could not reach the portal at 127.0.0.1:9. Check the URL and your connection, then try again."
        );
    }

    #[test]
    fn req_builder() {
        let r = Req::new("itv", "get_genres")
            .p("p", 2)
            .opt("x", None::<String>)
            .opt("y", Some("z"));
        assert_eq!(r.label(), "itv/get_genres");
        assert_eq!(r.params.len(), 4);
    }

    #[test]
    fn fingerprint_changes_with_identity() {
        let mut c = StalkerSourceConfig {
            portal_url: "http://h/c".into(),
            mac_address: "00:1a:79:00:00:01".into(),
            is_full_portal: true,
            username: None,
            password: None,
            headers: Default::default(),
            serial_number: None,
            device_id1: None,
            device_id2: None,
            signature1: None,
            signature2: None,
        };
        let a = identity_fingerprint(&c);
        c.serial_number = Some("BEDACD4569BAF".into());
        assert_eq!(a, identity_fingerprint(&c));
        c.device_id1 = Some("abc".into());
        assert_ne!(a, identity_fingerprint(&c));
        assert!(validate_config(&c).is_ok());
        // Grandfathered stored MACs are accepted verbatim; blanks are not.
        c.mac_address = "MAG-0001".into();
        assert!(validate_config(&c).is_ok());
        c.mac_address = "  ".into();
        assert!(validate_config(&c).is_err());
        c.mac_address = "00:1A; x=1".into();
        assert!(validate_config(&c).is_err());
    }

    /// D5: the `raw` call site itself enforces MAX_BODY_BYTES (a declared
    /// oversized body is refused before any read), not only `read_capped`.
    #[tokio::test]
    async fn raw_call_site_is_capped() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 999999999999\r\n\r\n{\"js\":";
                let _ = sock.write_all(head.as_bytes()).await;
                // Keep the socket open; the client must refuse on its own.
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(
            tmp.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        let config = StalkerSourceConfig {
            portal_url: format!("http://127.0.0.1:{port}/c"),
            mac_address: "00:1a:79:00:00:01".into(),
            is_full_portal: true,
            username: None,
            password: None,
            headers: Default::default(),
            serial_number: None,
            device_id1: None,
            device_id2: None,
            signature1: None,
            signature2: None,
        };
        let client = StalkerClient::ephemeral(&state, config).unwrap();
        let req = Req::new("itv", "get_genres").timeout(Duration::from_secs(10));
        let started = std::time::Instant::now();
        let err = client
            .raw(
                &format!("http://127.0.0.1:{port}/portal.php"),
                &req,
                None,
                1,
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("more than"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(8));
    }
}
