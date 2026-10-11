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
        p::normalize_mac(&c.mac_address).unwrap_or_else(|| c.mac_address.trim().to_string()),
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
pub fn validate_config(c: &StalkerSourceConfig) -> CoreResult<()> {
    if p::endpoint_candidates(&c.portal_url).is_empty() {
        return Err(CoreError::invalid(
            "Portal URL must be an http(s) address, for example http://portal.example/c/",
        ));
    }
    if p::normalize_mac(&c.mac_address).is_none() {
        return Err(CoreError::invalid(
            "MAC address must have 12 hex digits, for example 00:1A:79:12:34:56",
        ));
    }
    Ok(())
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
        let mac = p::normalize_mac(&config.mac_address).unwrap_or_default();
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

    /// Canonical MAC (for `accountInfo`; never log it).
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
                let resp = self
                    .state
                    .http
                    .get(&url)
                    .headers(headers)
                    .timeout(req.timeout)
                    .send()
                    .await
                    .map_err(CoreError::from)?;
                let status = resp.status();
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Ok(Body::AuthFailure(format!("HTTP {}", status.as_u16())));
                }
                if !status.is_success() {
                    return Err(status_error(status, &format!("Stalker {label}")));
                }
                let text = resp.text().await.map_err(CoreError::from)?;
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
                    let better = match (&first_err, &err) {
                        (None, _) => true,
                        (Some(CoreError::NotFound(_)), e) => !matches!(e, CoreError::NotFound(_)),
                        _ => false,
                    };
                    if better {
                        first_err = Some(err);
                    }
                }
            }
        }
        Err(match first_err {
            Some(CoreError::NotFound(_)) | Some(CoreError::Invalid(_)) | None => CoreError::NotFound(
                "No Stalker portal answered at this address. Check the portal URL (it usually ends in /c/).".into(),
            ),
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

/// Turns a refusing profile (status 1, or a block message) into an Auth error.
/// The MAC inside portal messages is replaced so it never reaches logs.
pub fn check_profile(profile: &Value, mac: &str) -> CoreResult<()> {
    let message = p::combine_messages(
        profile.get("msg").and_then(Value::as_str),
        profile.get("block_msg").and_then(Value::as_str),
    );
    let status = profile_status(profile);
    if status == Some(1) || (message.is_some() && status != Some(0)) {
        let text = redact_mac(
            &message.unwrap_or_else(|| "The portal blocked this device.".into()),
            mac,
        );
        if p::is_device_conflict(&text) {
            return Err(CoreError::Auth(format!(
                "{text} (the portal has this MAC bound to other device ids; set the matching device ids or ask the provider to reset the binding)"
            )));
        }
        return Err(CoreError::Auth(text));
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
            "auth: MAC address this MAC is not registered"
        );
        assert_eq!(redact_mac("x 001A79000001 y", mac), "x this MAC y");
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
        c.mac_address = "zz".into();
        assert!(validate_config(&c).is_err());
    }
}
