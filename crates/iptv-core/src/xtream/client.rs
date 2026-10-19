//! `player_api.php` client.
//!
//! Every request: `GET {server}/player_api.php?username&password[&action..]`
//! with the VLC User-Agent some panels require (or the source's own User-Agent,
//! Referer and Origin), retried on transient errors
//! (see [`XtreamClient::fetch`]). The password lives only in
//! the request query; logs carry the server, masked username and action, never the
//! URL, and errors come from reqwest with the URL stripped.

use super::raw::{RawAccount, RawUserInfo};
use super::url::{api_endpoint, normalize_server_url};
use crate::error::{CoreError, CoreResult};
use crate::http::{backoff_delay, cancellable, read_capped, send_checked, send_checked_within};
use crate::model::{RequestHeaders, XtreamSourceConfig};
use crate::state::AppState;
use serde::de::DeserializeOwned;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// User-Agent sent to Xtream panels (old app's `XTREAM_CLIENT_USER_AGENT`)
/// when the source sets none: some panels challenge generic HTTP clients but
/// allow IPTV players.
pub const XTREAM_USER_AGENT: &str = "VLC/3.0.18 LibVLC/3.0.18";

/// Attempts per request (1 + 2 retries).
pub const ATTEMPTS: u32 = 3;

/// A configured client for one Xtream account.
#[derive(Clone)]
pub struct XtreamClient {
    http: reqwest::Client,
    /// Normalized server base (`scheme://host[:port][/base]`).
    pub server: String,
    pub username: String,
    password: String,
    /// The source's User-Agent, or [`XTREAM_USER_AGENT`].
    user_agent: String,
    /// The source's Referer and Origin (its User-Agent is in `user_agent`).
    headers: RequestHeaders,
    attempts: u32,
    /// Where retry progress goes (an import run), if anywhere.
    progress: Option<(Arc<AppState>, String)>,
}

impl fmt::Debug for XtreamClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("XtreamClient")
            .field("server", &self.server)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

impl XtreamClient {
    /// Validates and normalizes `cfg`.
    pub fn new(http: reqwest::Client, cfg: &XtreamSourceConfig) -> CoreResult<Self> {
        let server = normalize_server_url(&cfg.server_url)?;
        let username = cfg.username.trim().to_string();
        // The password is sent as typed (L1-core-20).
        let password = cfg.password.clone();
        if username.is_empty() {
            return Err(CoreError::invalid("Enter the Xtream username."));
        }
        if password.trim().is_empty() {
            return Err(CoreError::invalid("Enter the Xtream password."));
        }
        let mut headers = cfg.headers.clone();
        let user_agent = headers
            .user_agent
            .take()
            .map(|ua| ua.trim().to_string())
            .filter(|ua| !ua.is_empty())
            .unwrap_or_else(|| XTREAM_USER_AGENT.to_string());
        Ok(Self {
            http,
            server,
            username,
            password,
            user_agent,
            headers,
            attempts: ATTEMPTS,
            progress: None,
        })
    }

    /// Overrides the attempt count (connection tests use 1 to answer fast).
    pub fn with_attempts(mut self, attempts: u32) -> Self {
        self.attempts = attempts.max(1);
        self
    }

    /// The password, for building stream URLs. Never log it.
    pub fn password(&self) -> &str {
        &self.password
    }

    /// The username for logs: first character and `***`.
    pub fn masked_username(&self) -> String {
        mask_username(&self.username)
    }

    /// Fetches `player_api.php` with `action` (None = account info) and extra
    /// query params, and decodes the JSON body into `T`. An empty body decodes
    /// as JSON `null`.
    ///
    /// For small answers (account, categories, details, EPG): the whole
    /// request, head and body, must finish within [`METADATA_DEADLINE`], so a
    /// server that trickles bytes cannot hold it open.
    pub async fn get<T: DeserializeOwned>(
        &self,
        action: Option<&str>,
        params: &[(&str, String)],
    ) -> CoreResult<T> {
        let bytes = self.fetch(action, params, BodyKind::Metadata).await?;
        decode(&bytes, action.unwrap_or("account"))
    }

    /// Raw body of a list action (decoded later on the blocking pool). Large
    /// lists may take minutes, so instead of a whole deadline the body must
    /// keep a minimum average rate ([`crate::m3u::body::MinRate`]).
    pub async fn get_bytes(&self, action: &str) -> CoreResult<bytes::Bytes> {
        self.fetch(Some(action), &[], BodyKind::List).await
    }

    /// Retries transient failures up to `attempts` times, like
    /// [`crate::http::with_retry`], except that a request which used up its
    /// whole budget (the metadata deadline, the account check's head deadline,
    /// or a list body under the minimum rate) is not retried: a dripping or
    /// silent panel would otherwise take three budgets to fail. Each retry emits `import.progress` with
    /// `attempt`/`attempts` when the client has a progress target, and a
    /// retried failure ends with "The download failed after N tries." (the
    /// same emitter and suffix as the M3U download).
    async fn fetch(
        &self,
        action: Option<&str>,
        params: &[(&str, String)],
        kind: BodyKind,
    ) -> CoreResult<bytes::Bytes> {
        let started = Instant::now();
        let label = action.unwrap_or("account");
        let attempts = self.attempts.max(1);
        let mut n = 0;
        let bytes = loop {
            match self.attempt(label, action, params, kind).await {
                Ok(b) => break Ok(b),
                Err(Failed { err, budget_spent })
                    if err.is_retryable()
                        && !budget_spent
                        && n + 1 < attempts
                        && !crate::sources::is_import_cancelled() =>
                {
                    tracing::debug!(attempt = n + 1, error = %err, "xtream retry after transient error");
                    cancellable(tokio::time::sleep(backoff_delay(n))).await?;
                    n += 1;
                    if let Some((state, source_id)) = &self.progress {
                        crate::m3u::importer::emit_retry(state, source_id, n + 1, attempts);
                    }
                }
                Err(Failed { err, .. }) => {
                    break Err(crate::m3u::importer::after_tries(err, n + 1));
                }
            }
        }
        .inspect_err(|err| {
            tracing::warn!(server = %self.server, user = %self.masked_username(), action = label, error = %err, "xtream request failed");
        })?;
        tracing::debug!(
            server = %self.server,
            action = label,
            bytes = bytes.len(),
            ms = started.elapsed().as_millis() as u64,
            "xtream response"
        );
        Ok(bytes)
    }

    /// One request. `budget_spent` marks a failure that already used the
    /// whole time budget of the request kind (see [`Self::fetch`]).
    async fn attempt(
        &self,
        label: &str,
        action: Option<&str>,
        params: &[(&str, String)],
        kind: BodyKind,
    ) -> Result<bytes::Bytes, Failed> {
        let mut query: Vec<(&str, &str)> = vec![
            ("username", self.username.as_str()),
            ("password", self.password.as_str()),
        ];
        if let Some(a) = action {
            query.push(("action", a));
        }
        for (k, v) in params {
            query.push((k, v.as_str()));
        }
        let req = self
            .http
            .get(api_endpoint(&self.server))
            .header(reqwest::header::USER_AGENT, self.user_agent.as_str())
            .header(reqwest::header::ACCEPT, "application/json, */*")
            .query(&query);
        let req = crate::http::apply_source_headers(req, &self.headers);
        let context = format!("Xtream {label}");
        let tried = Instant::now();
        match kind {
            BodyKind::Metadata | BodyKind::Account => {
                // `http::send_metadata`, with the deadline shortened in unit
                // tests. The account check also gets a short head deadline,
                // and a timeout that used it up is final.
                let (head, budget) = match kind {
                    BodyKind::Account => {
                        let head = account_header_timeout();
                        (head, head.min(METADATA_DEADLINE))
                    }
                    _ => (crate::http::HEADER_TIMEOUT, METADATA_DEADLINE),
                };
                let result = async {
                    let resp =
                        send_checked_within(req.timeout(METADATA_DEADLINE), head, &context).await?;
                    read_capped(resp, &context, MAX_BODY_BYTES).await
                }
                .await;
                result.map_err(|err| Failed {
                    budget_spent: matches!(err, CoreError::Timeout(_)) && tried.elapsed() >= budget,
                    err,
                })
            }
            BodyKind::List => {
                let resp = send_checked(req, &context).await.map_err(Failed::retry)?;
                read_list_body(resp, &context, MAX_BODY_BYTES).await
            }
        }
    }

    /// Emits `import.progress` retry events for `source_id` (an import run).
    pub fn with_progress(mut self, state: &Arc<AppState>, source_id: &str) -> Self {
        self.progress = Some((Arc::clone(state), source_id.to_string()));
        self
    }

    /// Account info. Fails with `Auth` when `user_info.auth == 0` and with
    /// `Invalid` when the response is not an Xtream account payload.
    ///
    /// The first request of a sync and of a connection test, so the one the
    /// add dialog waits on: the response head must arrive within
    /// [`ACCOUNT_HEADER_TIMEOUT`], and a panel that stays silent that long
    /// fails at once instead of being retried. Busy (5xx) and reset
    /// connections are still retried.
    pub async fn account(&self) -> CoreResult<RawAccount> {
        let bytes = self.fetch(None, &[], BodyKind::Account).await?;
        let acc: RawAccount = decode(&bytes, "account")?;
        check_auth(acc.user_info.as_ref())?;
        Ok(acc)
    }
}

/// Response-head deadline of [`XtreamClient::account`]: about what a person
/// waits for a "Connecting…" step, and as long as the connect timeout.
pub const ACCOUNT_HEADER_TIMEOUT: Duration = Duration::from_secs(10);

/// Test override of [`ACCOUNT_HEADER_TIMEOUT`] in milliseconds (0: none).
static ACCOUNT_HEADER_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);

/// Shortens the account check's head deadline for the whole process. Test
/// hook for integration tests with a silent panel; the app never calls it.
#[doc(hidden)]
pub fn set_account_header_timeout_for_tests(timeout: Duration) {
    let ms = u64::try_from(timeout.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    ACCOUNT_HEADER_TIMEOUT_MS.store(ms, Ordering::Relaxed);
}

fn account_header_timeout() -> Duration {
    match ACCOUNT_HEADER_TIMEOUT_MS.load(Ordering::Relaxed) {
        0 => ACCOUNT_HEADER_TIMEOUT,
        ms => Duration::from_millis(ms),
    }
}

/// Largest `player_api.php` body accepted. The biggest real VOD lists stay
/// well under 200 MB; a body past this is a stream, a loop, or a hostile
/// server, and reading it whole would exhaust memory.
pub const MAX_BODY_BYTES: usize = 512 * 1024 * 1024;

/// Whole-request deadline of the small (non-list) requests.
#[cfg(not(test))]
const METADATA_DEADLINE: std::time::Duration = crate::http::METADATA_DEADLINE;
#[cfg(test)]
const METADATA_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

/// A failed try; see [`XtreamClient::fetch`].
struct Failed {
    err: CoreError,
    /// The try used its whole time budget: do not retry.
    budget_spent: bool,
}

impl Failed {
    fn retry(err: CoreError) -> Self {
        Self {
            err,
            budget_spent: false,
        }
    }
}

impl From<CoreError> for Failed {
    fn from(err: CoreError) -> Self {
        Self::retry(err)
    }
}

#[derive(Clone, Copy)]
enum BodyKind {
    /// Small JSON: whole-request deadline.
    Metadata,
    /// The account check: [`BodyKind::Metadata`] with the shorter head
    /// deadline [`ACCOUNT_HEADER_TIMEOUT`].
    Account,
    /// A stream/VOD/series list: minimum average rate.
    List,
}

/// Reads a list body up to `max` bytes, failing with `Timeout` when it
/// averages under the minimum rate over a window (a drip-feeding server
/// resets the idle read timeout with every byte). Cancellable like
/// [`read_capped`].
async fn read_list_body(
    mut resp: reqwest::Response,
    context: &str,
    max: usize,
) -> Result<bytes::Bytes, Failed> {
    let host = resp.url().host_str().unwrap_or("the server").to_owned();
    let too_large = || {
        CoreError::Invalid(format!(
            "{context}: the server sent more than {} MB, which is not an API answer. Check the server URL.",
            max / (1024 * 1024)
        ))
    };
    if resp.content_length().unwrap_or(0) > max as u64 {
        return Err(too_large().into());
    }
    let mut rate = crate::m3u::body::MinRate::standard();
    let mut buf = bytes::BytesMut::new();
    while let Some(chunk) = crate::http::cancellable(resp.chunk())
        .await?
        .map_err(|err| {
            if err.is_timeout() {
                // The body stalled after the head (the idle read timeout):
                // like the M3U download, a stalled body is not retried.
                Failed {
                    err: CoreError::Timeout(format!(
                        "{context}: the server took too long to send its answer. Try again later."
                    )),
                    budget_spent: true,
                }
            } else {
                CoreError::from(err).into()
            }
        })?
    {
        // Under the minimum rate for a whole window: the budget is spent.
        rate.on_bytes(chunk.len(), &host).map_err(|err| Failed {
            err: match err {
                CoreError::Timeout(m) => CoreError::Timeout(m.replace("the playlist", "the list")),
                other => other,
            },
            budget_spent: true,
        })?;
        if buf.len().saturating_add(chunk.len()) > max {
            return Err(too_large().into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf.freeze())
}

/// Separates the plain message of an unreadable-reply error from its
/// technical detail (the JSON parser's text). The UI can split on it and
/// show the part after it under "Technical details".
pub const DETAIL_SEPARATOR: &str = "\n\nTechnical detail: ";

/// Plain message for a reply that is not the JSON the app expects.
pub const UNREADABLE_REPLY: &str =
    "The server sent a reply the app could not read. Check the server URL.";

/// Decodes a body; empty bodies are `null`, HTML or garbage is `Invalid`.
pub fn decode<T: DeserializeOwned>(bytes: &[u8], label: &str) -> CoreResult<T> {
    let trimmed = bytes.trim_ascii();
    let body: &[u8] = if trimmed.is_empty() { b"null" } else { trimmed };
    serde_json::from_slice(body).map_err(|err| {
        let looks_html = body.first() == Some(&b'<');
        CoreError::Invalid(if looks_html {
            format!("Xtream {label}: the server answered with a web page instead of JSON. Check the server URL.")
        } else {
            format!("{UNREADABLE_REPLY}{DETAIL_SEPARATOR}Xtream {label}: {err}")
        })
    })
}

/// `Auth` when `user_info.auth` is false; `Invalid` when `user_info` is missing.
pub fn check_auth(user_info: Option<&RawUserInfo>) -> CoreResult<()> {
    let Some(u) = user_info else {
        return Err(CoreError::Invalid(
            "The server did not return Xtream account details. Check the server URL.".into(),
        ));
    };
    if u.auth == Some(false) {
        return Err(CoreError::Auth(
            "The server rejected the username or password. Check your credentials.".into(),
        ));
    }
    Ok(())
}

/// Masks an account name for logs: first character and `***` (`***` alone
/// when empty).
pub fn mask_username(user: &str) -> String {
    let first: String = user.trim().chars().take(1).collect();
    format!("{first}***")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_are_masked_for_logs() {
        assert_eq!(mask_username("alice"), "a***");
        assert_eq!(mask_username("Ünïcode"), "Ü***");
        assert_eq!(mask_username(""), "***");
    }

    #[test]
    fn debug_hides_password() {
        let c = XtreamClient::new(
            reqwest::Client::new(),
            &XtreamSourceConfig {
                server_url: "http://h:1/".into(),
                username: "u".into(),
                password: "hunter2".into(),
                headers: Default::default(),
            },
        )
        .unwrap();
        let d = format!("{c:?}");
        assert!(!d.contains("hunter2"));
        assert_eq!(c.server, "http://h:1");
    }

    #[test]
    fn rejects_empty_credentials() {
        let cfg = XtreamSourceConfig {
            server_url: "http://h".into(),
            username: " ".into(),
            password: "p".into(),
            headers: Default::default(),
        };
        assert!(matches!(
            XtreamClient::new(reqwest::Client::new(), &cfg),
            Err(CoreError::Invalid(_))
        ));
    }

    #[test]
    fn user_agent_defaults_to_vlc_and_follows_the_source() {
        let cfg = |ua: Option<&str>| XtreamSourceConfig {
            server_url: "http://h".into(),
            username: "u".into(),
            password: "p".into(),
            headers: RequestHeaders {
                user_agent: ua.map(str::to_owned),
                referrer: Some("http://ref.example/".into()),
                origin: None,
            },
        };
        let c = XtreamClient::new(reqwest::Client::new(), &cfg(None)).unwrap();
        assert_eq!(c.user_agent, XTREAM_USER_AGENT);
        let c = XtreamClient::new(reqwest::Client::new(), &cfg(Some(" "))).unwrap();
        assert_eq!(c.user_agent, XTREAM_USER_AGENT);
        let c = XtreamClient::new(reqwest::Client::new(), &cfg(Some(" MyBox/1.0 "))).unwrap();
        assert_eq!(c.user_agent, "MyBox/1.0");
        assert_eq!(c.headers.user_agent, None);
        assert_eq!(c.headers.referrer.as_deref(), Some("http://ref.example/"));
    }

    #[test]
    fn decode_handles_empty_and_html() {
        let v: serde_json::Value = decode(b"  ", "x").unwrap();
        assert!(v.is_null());
        let e = decode::<serde_json::Value>(b"<html>", "x").unwrap_err();
        assert!(e.to_string().contains("web page"));
    }

    /// One-shot loopback HTTP server answering every connection with `reply`.
    async fn serve(reply: Vec<u8>) -> String {
        serve_counted(reply).await.0
    }

    /// [`serve`] plus a count of the connections it accepted.
    async fn serve_counted(reply: Vec<u8>) -> (String, Arc<std::sync::atomic::AtomicU32>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let reply = reply.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock.write_all(&reply).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("http://127.0.0.1:{port}/"), hits)
    }

    /// B8-parsers: bodies were read whole with no cap (`resp.bytes()`).
    #[tokio::test]
    async fn body_read_is_capped() {
        let http = reqwest::Client::new();
        let ok =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec())
                .await;
        let body = read_capped(http.get(&ok).send().await.unwrap(), "x", 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"{}");

        // Declared too large: rejected before reading.
        let declared = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 999999999999\r\nConnection: close\r\n\r\n{}"
                .to_vec(),
        )
        .await;
        let err = read_capped(http.get(&declared).send().await.unwrap(), "x", 1024)
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::Invalid(ref m) if m.contains("more than")),
            "{err:?}"
        );

        // No length, body past the cap: rejected while streaming.
        let mut long = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        long.extend(std::iter::repeat_n(b'x', 4096));
        let streamed = serve(long).await;
        let err = read_capped(http.get(&streamed).send().await.unwrap(), "x", 1024)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    }

    /// Loopback server that sends a 200 head and then one byte every 300 ms
    /// for as long as the client listens.
    async fn drip() -> (String, Arc<std::sync::atomic::AtomicU32>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[")
                        .await;
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        if sock.write_all(b" ").await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        (format!("http://127.0.0.1:{port}"), hits)
    }

    fn client_for(server: &str) -> XtreamClient {
        XtreamClient::new(
            reqwest::Client::new(),
            &XtreamSourceConfig {
                server_url: server.into(),
                username: "u".into(),
                password: "p".into(),
                headers: Default::default(),
            },
        )
        .unwrap()
        .with_attempts(1)
    }

    /// Review R1-2: a detail request to a panel that trickles one byte at a
    /// time never ended (the idle read timeout resets on every byte).
    #[tokio::test]
    async fn detail_request_has_a_whole_deadline() {
        let c = client_for(&drip().await.0);
        let started = std::time::Instant::now();
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            c.get::<serde_json::Value>(Some("get_vod_info"), &[("vod_id", "1".into())]),
        )
        .await
        .expect("the detail request hung")
        .unwrap_err();
        assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(8));
    }

    /// Review R1-2: list bodies get a minimum-rate guard instead.
    #[tokio::test]
    async fn list_body_has_a_minimum_rate() {
        let c = client_for(&drip().await.0);
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            c.get_bytes("get_vod_streams"),
        )
        .await
        .expect("the list request hung")
        .unwrap_err();
        assert!(
            matches!(err, CoreError::Timeout(ref m) if m.contains("the list too slowly")),
            "{err:?}"
        );
    }

    /// D5 at the call sites: both request paths enforce the body cap.
    #[tokio::test]
    async fn fetch_call_sites_are_capped() {
        let huge = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 999999999999\r\nConnection: close\r\n\r\n{}"
                .to_vec(),
        )
        .await;
        let c = client_for(huge.trim_end_matches('/'));
        let list = c.get_bytes("get_live_streams").await.unwrap_err();
        assert!(
            matches!(list, CoreError::Invalid(ref m) if m.contains("more than")),
            "{list:?}"
        );
        let detail = c
            .get::<serde_json::Value>(Some("get_vod_info"), &[])
            .await
            .unwrap_err();
        assert!(
            matches!(detail, CoreError::Invalid(ref m) if m.contains("more than")),
            "{detail:?}"
        );
    }

    /// Review R1-5: the serde text was the main message.
    #[test]
    fn unreadable_json_has_a_plain_message_and_a_detail() {
        let e = decode::<serde_json::Value>(br#"{"user_info": {"auth": 1"#, "account").unwrap_err();
        let CoreError::Invalid(m) = e else {
            panic!("{e:?}")
        };
        let (plain, detail) = m.split_once(DETAIL_SEPARATOR).expect("separator");
        assert_eq!(plain, UNREADABLE_REPLY);
        assert!(
            detail.starts_with("Xtream account: EOF while parsing"),
            "{detail}"
        );
    }

    #[test]
    fn auth_zero_is_auth_error() {
        let acc: RawAccount = serde_json::from_str(r#"{"user_info":{"auth":0}}"#).unwrap();
        assert!(matches!(
            check_auth(acc.user_info.as_ref()),
            Err(CoreError::Auth(_))
        ));
        assert!(matches!(check_auth(None), Err(CoreError::Invalid(_))));
    }

    /// Review R2-6: a dripping panel was tried 3 times (3 deadlines plus
    /// backoff) before failing. A spent budget is not retried.
    #[tokio::test]
    async fn spent_budgets_are_not_retried() {
        use std::sync::atomic::Ordering::SeqCst;
        let (url, hits) = drip().await;
        let c = client_for(&url).with_attempts(3);
        let err = c
            .get::<serde_json::Value>(Some("get_vod_info"), &[("vod_id", "1".into())])
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
        assert_eq!(hits.load(SeqCst), 1, "deadline breach retried");
        let (url, hits) = drip().await;
        let c = client_for(&url).with_attempts(3);
        let err = c.get_bytes("get_vod_streams").await.unwrap_err();
        assert!(
            matches!(err, CoreError::Timeout(ref m) if m.contains("too slowly")),
            "{err:?}"
        );
        assert_eq!(hits.load(SeqCst), 1, "minimum-rate breach retried");
    }

    /// Review R3-2: a list body that stalled mid-way (head and part of the
    /// body, then silence) was retried 3 times at the idle timeout each.
    #[tokio::test]
    async fn stalled_list_body_is_not_retried() {
        use std::sync::atomic::Ordering::SeqCst;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                counter.fetch_add(1, SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n[{\"a\":1},")
                        .await;
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                });
            }
        });
        let http = reqwest::Client::builder()
            .read_timeout(std::time::Duration::from_millis(400))
            .build()
            .unwrap();
        let c = XtreamClient::new(
            http,
            &XtreamSourceConfig {
                server_url: format!("http://127.0.0.1:{port}"),
                username: "u".into(),
                password: "p".into(),
                headers: Default::default(),
            },
        )
        .unwrap()
        .with_attempts(3);
        let started = std::time::Instant::now();
        let err = c.get_bytes("get_live_streams").await.unwrap_err();
        assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
        assert_eq!(hits.load(SeqCst), 1, "a stalled body was retried");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    /// Review R2-7: Xtream retries were silent and the final message did not
    /// say how many tries were made (unlike the M3U download).
    #[tokio::test]
    async fn retries_emit_progress_and_count_tries() {
        use std::sync::atomic::Ordering::SeqCst;
        let (url, hits) = serve_counted(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        )
        .await;
        let tmp = tempfile::tempdir().unwrap();
        let (sink, mut rx) = crate::events::BroadcastSink::channel(256);
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
            .await
            .unwrap();
        let c = client_for(url.trim_end_matches('/'))
            .with_attempts(3)
            .with_progress(&state, "s1");
        let err = c.get_bytes("get_live_streams").await.unwrap_err();
        let CoreError::Server(m) = &err else {
            panic!("{err:?}")
        };
        assert!(
            m.contains("HTTP 503") && m.ends_with("The download failed after 3 tries."),
            "{m}"
        );
        assert_eq!(hits.load(SeqCst), 3);
        let mut tries = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if ev.kind == "import.progress" && ev.payload.get("attempt").is_some() {
                assert_eq!(ev.payload["sourceId"], "s1");
                assert_eq!(ev.payload["phase"], "fetching");
                assert_eq!(ev.payload["attempts"], 3);
                tries.push(ev.payload["attempt"].as_u64().unwrap());
            }
        }
        assert_eq!(tries, [2, 3]);
    }
}
