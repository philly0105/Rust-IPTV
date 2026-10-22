//! Shared HTTP client, retry helper and SSRF guard (SPEC C1).
//!
//! Every network call in the core goes through a client built here (timeouts,
//! gzip/brotli, bounded redirects) and, for idempotent requests, through
//! [`with_retry`]. Never log full URLs of portal requests; use
//! [`crate::logging::redact_url`].
//!
//! Timeouts: connecting gives up after [`CONNECT_TIMEOUT`]; [`send`] and
//! [`send_checked`] give up when no response head arrives within
//! [`HEADER_TIMEOUT`]; bodies may idle for [`READ_TIMEOUT`] between reads
//! (streams and large playlists stay alive as long as bytes flow). Metadata
//! requests that must finish as a whole use [`send_metadata`]
//! ([`METADATA_DEADLINE`]). reqwest's read timeout also runs while a response
//! head is awaited, so requests that may wait 120 s for one (big playlists
//! and provider lists) use the long-wait clients ([`guarded_long_client`],
//! [`LONG_READ_TIMEOUT`]) and limit their bodies' idle time themselves.
//!
//! Server mode (SSRF guard): the server binary installs [`ServerMode`] in the
//! state's extensions. Core fetches of user-supplied URLs (downloads,
//! playlists, XMLTV; Xtream/Stalker via [`trusted_client`]) then use the
//! guarded client ([`client_for`]), whose DNS resolver and redirect
//! policy refuse loopback, private and link-local addresses, and call
//! [`check_fetch`] first. A source's own `host:port` is trusted for that
//! source's fetches only: each trusted authority gets its own guarded client
//! ([`guarded_client`]) and nothing is trusted process-wide. The resolver
//! sees host names without ports, so that client is used only for URLs on
//! exactly that authority ([`trust_for`]), and a redirect it follows to the
//! same name on another port takes the name's trust away first
//! ([`GuardedResolver`]). `--allow-private-targets` turns the guard off. The
//! desktop app and tests without [`ServerMode`] are unaffected.

use crate::error::{CoreError, CoreResult};
use crate::model::RequestHeaders;
use crate::state::AppState;
use parking_lot::Mutex;
use rand::Rng;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use url::{Host, Url};

/// Connect timeout for every request outside [`interactive`].
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Connect timeout while the user waits on the answer ([`interactive`]:
/// adding a source, testing a connection). An unreachable host fails after
/// this, once, instead of after [`CONNECT_TIMEOUT`] (L3-app-2).
pub const INTERACTIVE_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

tokio::task_local! {
    /// Set by [`interactive`].
    static INTERACTIVE: ();
}

/// Runs `fut` as work the user is waiting on (adding a source, a connection
/// test): the clients from [`guarded_client`] and its wrappers connect with
/// [`INTERACTIVE_CONNECT_TIMEOUT`], and a connect timeout is final (not
/// retried). Background refreshes keep [`CONNECT_TIMEOUT`] and their retries.
/// Like every task-local, it does not reach tasks `fut` spawns.
pub async fn interactive<F: Future>(fut: F) -> F::Output {
    INTERACTIVE.scope((), fut).await
}

/// True inside [`interactive`].
pub fn is_interactive() -> bool {
    INTERACTIVE.try_with(|_| ()).is_ok()
}
/// Read (idle body) timeout for every request. reqwest also applies it to
/// the wait for the response head.
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Read timeout of the long-wait clients ([`guarded_long_client`]): longer
/// than the 120 s response-head deadline of big lists (M3U playlists, Xtream
/// list actions, Stalker `get_all_channels`), which [`READ_TIMEOUT`] would
/// cut at 60 s. Their bodies keep their own idle limits.
pub const LONG_READ_TIMEOUT: Duration = Duration::from_secs(150);
/// Time allowed between sending a request and receiving the response head
/// in [`send`] / [`send_checked`]. A server that accepts the connection and
/// never answers fails after this instead of after [`READ_TIMEOUT`].
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(15);
/// Whole-request deadline (head and body) of [`send_metadata`]: portal JSON
/// and other small metadata responses.
pub const METADATA_DEADLINE: Duration = Duration::from_secs(60);
/// Maximum redirects followed.
pub const MAX_REDIRECTS: usize = 5;
/// Base delay of the exponential backoff in [`with_retry`].
pub const RETRY_BASE: Duration = Duration::from_millis(300);

/// Default User-Agent: `TsrustIPTV/<version>`.
pub fn default_user_agent() -> String {
    format!("TsrustIPTV/{}", env!("CARGO_PKG_VERSION"))
}

fn builder(user_agent: Option<&str>) -> reqwest::ClientBuilder {
    let ua = user_agent
        .map(str::to_owned)
        .unwrap_or_else(default_user_agent);
    reqwest::Client::builder()
        .user_agent(ua)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .gzip(true)
        .brotli(true)
        // Never send a Referer on redirects: it would carry the previous URL
        // (Xtream credentials in the query) to the redirect target.
        .referer(false)
}

fn build(b: reqwest::ClientBuilder) -> reqwest::Client {
    b.build().unwrap_or_else(|err| {
        tracing::error!(%err, "failed to build configured HTTP client; using defaults");
        reqwest::Client::new()
    })
}

/// Builds a reqwest client: 10 s connect, 60 s read, gzip + brotli, at most 5
/// redirects, User-Agent `TsrustIPTV/<version>` unless overridden.
pub fn client(user_agent: Option<&str>) -> reqwest::Client {
    build(builder(user_agent).redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS)))
}

/// Delay before retry number `attempt` (0-based): `300 ms * 2^attempt` plus up
/// to 150 ms of jitter, capped at 10 s.
pub fn backoff_delay(attempt: u32) -> Duration {
    let base = RETRY_BASE.saturating_mul(2u32.saturating_pow(attempt.min(8)));
    let jitter = Duration::from_millis(rand::thread_rng().gen_range(0..150));
    (base + jitter).min(Duration::from_secs(10))
}

/// Runs `op` up to `attempts` times (at least once). Retries only errors
/// [`CoreError::is_retryable`] accepts (Network, Timeout, Server, but not a
/// refused connection, an unknown host or a bad certificate), sleeping
/// [`backoff_delay`] between tries. Returns the last error.
pub async fn with_retry<T, F, Fut>(attempts: u32, op: F) -> CoreResult<T>
where
    F: Fn() -> Fut,
    Fut: Future<Output = CoreResult<T>>,
{
    with_retry_if(attempts, op, |_| true).await
}

/// [`with_retry`] that also stops when `retry` rejects the error (a request
/// that used up its whole time budget).
pub async fn with_retry_if<T, F, Fut, R>(attempts: u32, op: F, retry: R) -> CoreResult<T>
where
    F: Fn() -> Fut,
    Fut: Future<Output = CoreResult<T>>,
    R: Fn(&CoreError) -> bool,
{
    let attempts = attempts.max(1);
    let mut n = 0;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            // A cancelled import run (C8) stops retrying at once.
            Err(err)
                if err.is_retryable() && retry(&err) && n + 1 < attempts && !import_cancelled() =>
            {
                let delay = backoff_delay(n);
                tracing::debug!(attempt = n + 1, ?delay, error = %err, "retrying after transient error");
                cancellable(tokio::time::sleep(delay)).await?;
                n += 1;
            }
            Err(err) => return Err(err),
        }
    }
}

fn import_cancelled() -> bool {
    crate::sources::is_import_cancelled()
}

/// Awaits `fut` unless the import run of the current task (C8, see
/// [`crate::sources::import_cancel`]) is cancelled first, which fails with
/// [`crate::sources::import_cancelled_error`]. Outside an import run this is
/// `fut` itself. Every network wait in this module goes through it, so a
/// cancelled import stops at its next send or body read.
pub async fn cancellable<T>(fut: impl Future<Output = T>) -> CoreResult<T> {
    match crate::sources::import_cancel() {
        None => Ok(fut.await),
        Some(token) => tokio::select! {
            biased;
            () = token.cancelled() => Err(crate::sources::import_cancelled_error()),
            v = fut => Ok(v),
        },
    }
}

/// Applies a source's User-Agent, Referer and Origin headers when present.
pub fn apply_source_headers(
    req: reqwest::RequestBuilder,
    h: &RequestHeaders,
) -> reqwest::RequestBuilder {
    let mut req = req;
    if let Some(ua) = h.user_agent.as_deref().filter(|s| !s.trim().is_empty()) {
        req = req.header(reqwest::header::USER_AGENT, ua.trim());
    }
    if let Some(r) = h.referrer.as_deref().filter(|s| !s.trim().is_empty()) {
        req = req.header(reqwest::header::REFERER, r.trim());
    }
    if let Some(o) = h.origin.as_deref().filter(|s| !s.trim().is_empty()) {
        req = req.header(reqwest::header::ORIGIN, o.trim());
    }
    req
}

/// What the user can do about a non-success HTTP status.
pub fn status_hint(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => "The server refused access. Check your login details, and that the subscription is still active.",
        404 | 410 => "The server does not know this address. Check the URL; the provider may have changed it.",
        408 | 504 => "The server took too long to answer. Try again later.",
        429 => "The server is rate limiting requests. Wait a minute, then try again.",
        500..=599 => "The server is busy or down. Try again later.",
        _ => "Check the address and settings, then try again.",
    }
}

/// Maps a non-success HTTP status to a `CoreError` (401/403 Auth, 404 NotFound,
/// 408/504 Timeout, 429 and other 5xx Server (retryable; the server is up but
/// refusing work, not unreachable), other 4xx Invalid). The
/// message is `"{context}: HTTP {status}. {hint}"` ([`status_hint`]).
pub fn status_error(status: reqwest::StatusCode, context: &str) -> CoreError {
    status_error_with_hint(status, context, status_hint(status))
}

/// [`status_error`] with a caller-chosen next step.
pub fn status_error_with_hint(status: reqwest::StatusCode, context: &str, hint: &str) -> CoreError {
    let msg = format!("{context}: HTTP {status}. {hint}");
    match status.as_u16() {
        401 | 403 => CoreError::Auth(msg),
        404 => CoreError::NotFound(msg),
        408 | 504 => CoreError::Timeout(msg),
        429 | 500..=599 => CoreError::Server(msg),
        _ => CoreError::Invalid(msg),
    }
}

/// Turns a transport failure into an actionable error: "Could not reach
/// {host}. {next step} ({OS detail})". Timeouts stay `Timeout` and everything
/// else `Network`. A refused connection, an unknown host name or an invalid
/// certificate gets its own next step, which also marks it as not retryable
/// ([`is_permanent_transport`]); other network failures (a reset, a closed
/// connection) stay retryable. A request refused by the server-mode guard
/// becomes `Invalid` (not retried).
pub fn transport_error(host: &str, err: reqwest::Error) -> CoreError {
    if let Some(blocked) = find_blocked(&err) {
        return CoreError::Invalid(blocked.0);
    }
    if err.is_timeout() {
        // The user is waiting ([`interactive`]): a host that does not
        // answer the connection within the short timeout is reported now,
        // not after more tries.
        if err.is_connect() && is_interactive() {
            return CoreError::Network(format!("Could not reach {host}. {UNREACHABLE_HINT}"));
        }
        return CoreError::Timeout(format!(
            "{host} did not respond in time. Check the address and that the server is online, then try again."
        ));
    }
    let hint = if err.is_connect() {
        connect_failure(&err).map_or(RETRY_HINT, ConnectFailure::hint)
    } else {
        RETRY_HINT
    };
    let detail = root_cause(&err.without_url());
    let detail = crate::logging::redact_text(&detail);
    CoreError::Network(format!("Could not reach {host}. {hint} ({detail})"))
}

/// Next step of a network failure worth retrying.
const RETRY_HINT: &str = "Check the address and that the server is online, then try again.";
/// Next steps of connect failures a retry cannot fix. Each is unique to
/// [`transport_error`]; [`is_permanent_transport`] looks for them.
const REFUSED_HINT: &str = "The server refused the connection. Check the address and port, and that the server is running, then try again.";
const UNKNOWN_HOST_HINT: &str =
    "The host name was not found. Check the address for typos, then try again.";
const CERTIFICATE_HINT: &str = "The server's security certificate is not valid. Check the address; if it is right, the provider has to fix its certificate.";
/// A connect timeout while the user waits ([`interactive`]).
const UNREACHABLE_HINT: &str = "The server did not answer. Check the address and port, and that the server is online, then try again.";

/// True when a `Network` message from [`transport_error`] is a refused
/// connection, an unknown host name or an invalid certificate: trying again
/// a moment later meets the same answer, so the retry loops stop at once
/// ([`CoreError::is_retryable`]).
pub fn is_permanent_transport(message: &str) -> bool {
    permanent_transport_hint(message).is_some()
}

/// The next step [`transport_error`] gave a connect failure a retry cannot
/// fix, so callers that word their own message (Stalker) can keep it.
pub fn permanent_transport_hint(message: &str) -> Option<&'static str> {
    [
        REFUSED_HINT,
        UNKNOWN_HOST_HINT,
        CERTIFICATE_HINT,
        UNREACHABLE_HINT,
    ]
    .into_iter()
    .find(|hint| message.contains(hint))
}

/// True when a `Network` message from [`transport_error`] is an invalid
/// certificate: unlike a refused connection or an unknown host during an
/// outage, waiting never fixes it.
pub fn is_certificate_failure(message: &str) -> bool {
    message.contains(CERTIFICATE_HINT)
}

/// A connect failure a retry cannot fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectFailure {
    /// Nothing listens at the address and port (the OS refused).
    Refused,
    /// The host name does not resolve (not a temporary resolver failure).
    UnknownHost,
    /// TLS rejected the server's certificate.
    Certificate,
}

impl ConnectFailure {
    const fn hint(self) -> &'static str {
        match self {
            Self::Refused => REFUSED_HINT,
            Self::UnknownHost => UNKNOWN_HOST_HINT,
            Self::Certificate => CERTIFICATE_HINT,
        }
    }
}

/// Classifies a connect error by its source chain: an `io::Error` of kind
/// `ConnectionRefused`; rustls' "invalid peer certificate" (or any
/// certificate complaint); hyper-util's "dns error" unless the resolver
/// called it temporary (`EAI_AGAIN`, Windows `WSATRY_AGAIN` 11002), which a
/// retry can fix.
fn connect_failure(err: &(dyn std::error::Error + 'static)) -> Option<ConnectFailure> {
    let mut dns = false;
    let mut text = String::new();
    let mut cur = Some(err);
    while let Some(e) = cur {
        if e.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            return Some(ConnectFailure::Refused);
        }
        let shown = e.to_string().to_ascii_lowercase();
        dns |= shown.starts_with("dns error");
        text.push_str(&shown);
        text.push('\n');
        cur = e.source();
    }
    if text.contains("certificate") {
        Some(ConnectFailure::Certificate)
    } else if dns && !(text.contains("temporar") || text.contains("os error 11002")) {
        Some(ConnectFailure::UnknownHost)
    } else {
        None
    }
}

/// The innermost cause of a transport error ("connection refused", "dns
/// error: ..."), which says more than reqwest's top-level "error sending
/// request". Inner causes come from hyper and the OS and carry no URL.
fn root_cause(err: &reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = err;
    while let Some(next) = cause.source() {
        cause = next;
    }
    let text = cause.to_string();
    if text.trim().is_empty() {
        err.to_string()
    } else {
        text
    }
}

/// Sends a request, failing with an actionable `Timeout` when the response
/// head does not arrive within [`HEADER_TIMEOUT`]. Any status is returned.
pub async fn send(req: reqwest::RequestBuilder) -> CoreResult<reqwest::Response> {
    send_within(req, HEADER_TIMEOUT).await
}

/// [`send`] with a caller-chosen response-head deadline, for protocols whose
/// servers legitimately build a large reply before sending its head (Stalker
/// `get_all_channels`). Transport failures name the host like [`send`].
pub async fn send_within(
    req: reqwest::RequestBuilder,
    header_timeout: Duration,
) -> CoreResult<reqwest::Response> {
    let (client, built) = req.build_split();
    let request = built.map_err(|e| {
        CoreError::Invalid(format!(
            "the request could not be built: {}",
            e.without_url()
        ))
    })?;
    let host = request.url().host_str().unwrap_or("the server").to_owned();
    match cancellable(tokio::time::timeout(header_timeout, client.execute(request))).await? {
        Ok(Ok(resp)) => Ok(resp),
        Ok(Err(e)) => Err(transport_error(&host, e)),
        Err(_) => Err(CoreError::Timeout(format!(
            "{host} accepted the connection but did not answer within {} s. Check the address and that the server is online, then try again.",
            header_timeout.as_secs()
        ))),
    }
}

/// [`send`], then turns a non-2xx status into [`status_error`].
pub async fn send_checked(
    req: reqwest::RequestBuilder,
    context: &str,
) -> CoreResult<reqwest::Response> {
    send_checked_within(req, HEADER_TIMEOUT, context).await
}

/// [`send_checked`] with a caller-chosen response-head deadline
/// ([`send_within`]).
pub async fn send_checked_within(
    req: reqwest::RequestBuilder,
    header_timeout: Duration,
    context: &str,
) -> CoreResult<reqwest::Response> {
    let resp = send_within(req, header_timeout).await?;
    let status = resp.status();
    if status.is_success() {
        Ok(resp)
    } else {
        Err(status_error(status, context))
    }
}

/// [`send_checked`] with a whole-request deadline of [`METADATA_DEADLINE`]
/// (the body must also arrive in time). For portal JSON and similar small
/// responses; never for streams or downloads.
pub async fn send_metadata(
    req: reqwest::RequestBuilder,
    context: &str,
) -> CoreResult<reqwest::Response> {
    send_checked(req.timeout(METADATA_DEADLINE), context).await
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/// Hint appended to every refusal of a private target.
pub const ALLOW_PRIVATE_HINT: &str = "Private, loopback and link-local addresses are blocked in server mode. If this host is on your own network, restart iptv-server with --allow-private-targets (or IPTV_ALLOW_PRIVATE_TARGETS=true).";

/// Error carried through reqwest when the resolver refuses a host.
#[derive(Debug, Clone)]
pub struct BlockedTarget(pub String);

impl fmt::Display for BlockedTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BlockedTarget {}

/// Why a target URL was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetError {
    /// Malformed or unsupported URL (HTTP 400).
    Invalid(String),
    /// Points at a non-public address (HTTP 403).
    Forbidden(String),
}

impl From<TargetError> for CoreError {
    fn from(e: TargetError) -> Self {
        match e {
            TargetError::Invalid(m) | TargetError::Forbidden(m) => CoreError::Invalid(m),
        }
    }
}

/// Normalized host for comparisons: lowercase, no trailing dot, IPv6 without brackets.
pub fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// A normalized `host:port` (port defaulted from the scheme).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Authority {
    pub host: String,
    pub port: u16,
}

impl Authority {
    /// Authority of an absolute http(s) URL.
    pub fn of(url: &Url) -> Option<Self> {
        let host = normalize_host(url.host_str()?);
        let port = url.port_or_known_default()?;
        (!host.is_empty()).then_some(Self { host, port })
    }

    /// Authority of a configured source URL; tolerates a missing scheme
    /// (`portal.example:8080/c/` is read as `http://`).
    pub fn parse_lenient(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let parsed = Url::parse(raw)
            .ok()
            .filter(|u| u.has_host())
            .or_else(|| Url::parse(&format!("http://{raw}")).ok())?;
        Self::of(&parsed)
    }
}

impl fmt::Display for Authority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.host.contains(':') {
            write!(f, "[{}]:{}", self.host, self.port)
        } else {
            write!(f, "{}:{}", self.host, self.port)
        }
    }
}

/// Authority of a source from its `sources.config_json` (C3): the M3U URL,
/// Xtream server or Stalker portal.
pub fn source_config_authority(kind: &str, config_json: &str) -> Option<Authority> {
    let v: serde_json::Value = serde_json::from_str(config_json).ok()?;
    let key = match kind {
        "m3u" => "url",
        "xtream" => "serverUrl",
        "stalker" => "portalUrl",
        _ => return None,
    };
    v.get(key)
        .and_then(|u| u.as_str())
        .and_then(Authority::parse_lenient)
}

/// [`source_config_authority`] of a stored source (`None` when it does not exist).
pub async fn source_authority(state: &AppState, source_id: &str) -> CoreResult<Option<Authority>> {
    let id = source_id.to_owned();
    state
        .db_call(move |c| {
            use rusqlite::OptionalExtension;
            Ok(c.query_row(
                "SELECT kind, config_json FROM sources WHERE id = ?1",
                [&id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
            .and_then(|(kind, json)| source_config_authority(&kind, &json)))
        })
        .await
}

/// Checks scheme, userinfo and IP-literal hosts. `trusted` is the requesting
/// source's own `host:port`; `allow_private` disables the address check.
/// Host names are checked at connect time by [`GuardedResolver`].
pub fn check_target(
    url: &Url,
    trusted: Option<&Authority>,
    allow_private: bool,
) -> Result<(), TargetError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(TargetError::Invalid(format!(
            "only http and https URLs can be fetched (got {}:)",
            url.scheme()
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(TargetError::Invalid(
            "URLs with credentials in the user-info part are not allowed".into(),
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| TargetError::Invalid("URL has no host".into()))?;
    let auth = Authority::of(url);
    if allow_private || (trusted.is_some() && trusted == auth.as_ref()) {
        return Ok(());
    }
    let host_str = normalize_host(url.host_str().unwrap_or_default());
    let refused = |what: &str| {
        Err(TargetError::Forbidden(format!(
            "Refusing to connect to {what} {host_str}. {ALLOW_PRIVATE_HINT}"
        )))
    };
    match host {
        Host::Ipv4(ip) if !is_public_ip(IpAddr::V4(ip)) => refused("the private address"),
        Host::Ipv6(ip) if !is_public_ip(IpAddr::V6(ip)) => refused("the private address"),
        Host::Domain(_) if host_str == "localhost" || host_str.ends_with(".localhost") => {
            refused("the loopback host")
        }
        _ => Ok(()),
    }
}

/// True for globally routable unicast addresses.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || o[0] == 0 // "this network"
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 carrier-grade NAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24 IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15 benchmarking
        || o[0] >= 240) // reserved
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    // ::a.b.c.d (deprecated IPv4-compatible) and 64:ff9b::/96 (NAT64) embed an IPv4 address.
    let embedded = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    if s[..6].iter().all(|&x| x == 0) && !ip.is_loopback() && !ip.is_unspecified() {
        return is_public_v4(embedded);
    }
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|&x| x == 0) {
        return is_public_v4(embedded);
    }
    if s[0] == 0x2002 {
        // 6to4 embeds the IPv4 address in segments 1..3.
        let v4 = Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8);
        return is_public_v4(v4);
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00 // unique local
        || (s[0] & 0xffc0) == 0xfe80 // link-local
        || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
        || (s[0] == 0x2001 && s[1] == 0x0db8)) // documentation
}

/// Most guarded clients kept per cache; the cache starts over when full
/// (clients already handed out keep working).
const MAX_CACHED_CLIENTS: usize = 64;

/// DNS resolver of a guarded client: drops non-public addresses unless the
/// name is the host of the one authority this client trusts or private
/// targets are allowed. Names carry no port, so a client that trusts an
/// authority is used only for URLs on exactly it ([`trust_for`]), and its
/// redirect policy takes the name's trust away ([`GuardedResolver::distrust`])
/// before it follows a redirect to the same name on another port: that
/// connection, and every later one of the client, then reaches only public
/// addresses, whatever the name resolves to by then.
pub struct GuardedResolver {
    pub trusted: Option<Authority>,
    pub allow_private: bool,
    /// Set by [`GuardedResolver::distrust`].
    distrusted: std::sync::atomic::AtomicBool,
}

impl GuardedResolver {
    /// Ends the private-address exception of the trusted name for every
    /// later lookup of this resolver.
    pub fn distrust(&self) {
        use std::sync::atomic::Ordering;
        self.distrusted.store(true, Ordering::SeqCst);
    }

    /// True when `host` may resolve to private addresses.
    pub fn trusts(&self, host: &str) -> bool {
        use std::sync::atomic::Ordering;
        if self.allow_private {
            return true;
        }
        !self.distrusted.load(Ordering::SeqCst)
            && self.trusted.as_ref().is_some_and(|t| t.host == host)
    }
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = normalize_host(name.as_str());
        let trusted = self.trusts(&host);
        Box::pin(async move {
            let all: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if all.is_empty() {
                return Err(format!("{host} did not resolve to any address").into());
            }
            let kept: Vec<SocketAddr> = if trusted {
                all
            } else {
                all.into_iter().filter(|a| is_public_ip(a.ip())).collect()
            };
            if kept.is_empty() {
                return Err(Box::new(BlockedTarget(format!(
                    "Refusing to connect to {host}: it resolves only to private or loopback addresses. {ALLOW_PRIVATE_HINT}"
                )))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(kept.into_iter()) as Addrs)
        })
    }
}

/// Finds a [`BlockedTarget`] anywhere in an error's source chain.
pub fn find_blocked(err: &(dyn std::error::Error + 'static)) -> Option<BlockedTarget> {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(b) = e.downcast_ref::<BlockedTarget>() {
            return Some(b.clone());
        }
        cur = e.source();
    }
    None
}

/// Guard policy shared by the server's proxy and the core's guarded clients.
/// Trust is per request: every check takes the requesting source's own
/// authority, and nothing is remembered between requests.
#[derive(Debug, Default)]
pub struct NetGuard {
    pub allow_private: bool,
}

impl NetGuard {
    pub fn new(allow_private: bool) -> Self {
        Self { allow_private }
    }

    /// Resolver for a client that trusts only `trusted` (or nothing).
    pub fn resolver(&self, trusted: Option<&Authority>) -> Arc<GuardedResolver> {
        Arc::new(GuardedResolver {
            trusted: trusted.cloned(),
            allow_private: self.allow_private,
            distrusted: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// [`check_target`], plus: the trusted host name on another port (the
    /// resolver trusts names, not ports) is resolved now and refused when it
    /// points at a non-public address.
    pub async fn check(&self, url: &Url, trusted: Option<&Authority>) -> Result<(), TargetError> {
        check_target(url, trusted, self.allow_private)?;
        if self.allow_private {
            return Ok(());
        }
        let Some(auth) = Authority::of(url) else {
            return Ok(());
        };
        if !needs_port_check(url, &auth, trusted) {
            return Ok(());
        }
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((auth.host.as_str(), auth.port))
            .await
            .map(Iterator::collect)
            .unwrap_or_default();
        other_port_verdict(&auth, &addrs)
    }

    /// The port rule of [`NetGuard::check`] for the synchronous redirect
    /// policy. Resolves with a blocking lookup, which only happens for a
    /// redirect to the trusted host name on another port.
    fn check_other_port_blocking(
        &self,
        url: &Url,
        trusted: Option<&Authority>,
    ) -> Result<(), TargetError> {
        if self.allow_private {
            return Ok(());
        }
        let Some(auth) = Authority::of(url) else {
            return Ok(());
        };
        if !needs_port_check(url, &auth, trusted) {
            return Ok(());
        }
        use std::net::ToSocketAddrs;
        let addrs: Vec<SocketAddr> = (auth.host.as_str(), auth.port)
            .to_socket_addrs()
            .map(Iterator::collect)
            .unwrap_or_default();
        other_port_verdict(&auth, &addrs)
    }
}

/// The trusted host name on a port other than the trusted one.
fn needs_port_check(url: &Url, auth: &Authority, trusted: Option<&Authority>) -> bool {
    matches!(url.host(), Some(Host::Domain(_)))
        && trusted.is_some_and(|t| t != auth && t.host == auth.host)
}

fn other_port_verdict(auth: &Authority, addrs: &[SocketAddr]) -> Result<(), TargetError> {
    if addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(TargetError::Forbidden(format!(
            "Refusing to connect to {auth}: only the source's own port on this private host is allowed. {ALLOW_PRIVATE_HINT}"
        )));
    }
    Ok(())
}

type MakeClient = dyn Fn(Option<&Authority>) -> reqwest::Client + Send + Sync;

/// Guarded clients keyed by the one authority each trusts (`None`: trusts
/// nothing), built on demand. A client's resolver and redirect policy trust
/// only its own key, so one source's trust never reaches another request.
pub struct GuardedClients {
    make: Box<MakeClient>,
    cache: Mutex<HashMap<Option<Authority>, reqwest::Client>>,
}

impl GuardedClients {
    /// `make` builds the client for one key (resolver from
    /// [`NetGuard::resolver`] with that key).
    pub fn new(
        make: impl Fn(Option<&Authority>) -> reqwest::Client + Send + Sync + 'static,
    ) -> Self {
        Self {
            make: Box::new(make),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The client that trusts exactly `trusted` (or nothing).
    pub fn get(&self, trusted: Option<&Authority>) -> reqwest::Client {
        let key = trusted.cloned();
        let mut cache = self.cache.lock();
        if let Some(c) = cache.get(&key) {
            return c.clone();
        }
        if cache.len() >= MAX_CACHED_CLIENTS {
            cache.clear();
        }
        let c = (self.make)(trusted);
        cache.insert(key, c.clone());
        c
    }
}

/// Redirect policy of a core guarded client whose resolver is `resolver`:
/// every hop is checked against the one authority it trusts. IP literals are
/// checked here; host names by the resolver when the redirect connects. The
/// trusted name on another port gets [`NetGuard::check`]'s port rule here,
/// and a hop that passes it first takes the name's trust away
/// ([`GuardedResolver::distrust`]): the resolver cannot tell the ports apart,
/// and the name may resolve elsewhere when the hop connects.
fn guarded_redirect(
    guard: Arc<NetGuard>,
    resolver: Arc<GuardedResolver>,
) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error(format!("stopped after {MAX_REDIRECTS} redirects"));
        }
        let url = attempt.url();
        let trusted = resolver.trusted.as_ref();
        let checked = check_target(url, trusted, guard.allow_private)
            .and_then(|()| guard.check_other_port_blocking(url, trusted));
        let auth = Authority::of(url);
        let other_port = auth.is_some_and(|a| needs_port_check(url, &a, trusted));
        match checked {
            Ok(()) => {
                if other_port {
                    resolver.distrust();
                }
                attempt.follow()
            }
            Err(TargetError::Invalid(m) | TargetError::Forbidden(m)) => {
                attempt.error(BlockedTarget(m))
            }
        }
    })
}

/// Marker and guarded clients installed by the server binary (extension
/// [`SERVER_MODE_EXT`]). Its presence means "server mode": file access by
/// path and download-folder changes are refused, and fetches are guarded.
pub struct ServerMode {
    pub guard: Arc<NetGuard>,
    clients: GuardedClients,
    /// The same clients with [`INTERACTIVE_CONNECT_TIMEOUT`].
    interactive: GuardedClients,
    /// The same clients with [`LONG_READ_TIMEOUT`].
    long: GuardedClients,
    /// The long-wait clients with [`INTERACTIVE_CONNECT_TIMEOUT`].
    long_interactive: GuardedClients,
}

/// Extension key of [`ServerMode`].
pub const SERVER_MODE_EXT: &str = "server_mode";

impl ServerMode {
    /// Installs server mode on `state` (no-op for the desktop app).
    pub fn install(state: &AppState, allow_private: bool) -> Option<Arc<Self>> {
        if state.is_desktop {
            return None;
        }
        let guard = Arc::new(NetGuard::new(allow_private));
        let guarded = |connect: Duration, read: Duration| {
            let g = guard.clone();
            GuardedClients::new(move |trusted| {
                let resolver = g.resolver(trusted);
                build(
                    builder(None)
                        .connect_timeout(connect)
                        .read_timeout(read)
                        .redirect(guarded_redirect(g.clone(), resolver.clone()))
                        .dns_resolver(resolver),
                )
            })
        };
        let clients = guarded(CONNECT_TIMEOUT, READ_TIMEOUT);
        let interactive = guarded(INTERACTIVE_CONNECT_TIMEOUT, READ_TIMEOUT);
        let long = guarded(CONNECT_TIMEOUT, LONG_READ_TIMEOUT);
        let long_interactive = guarded(INTERACTIVE_CONNECT_TIMEOUT, LONG_READ_TIMEOUT);
        let mode = Arc::new(Self {
            guard,
            clients,
            interactive,
            long,
            long_interactive,
        });
        state.set_ext(SERVER_MODE_EXT, mode.clone());
        Some(mode)
    }

    /// The guarded client that trusts exactly `trusted` (or nothing); inside
    /// [`interactive`] its short-connect twin.
    pub fn client(&self, trusted: Option<&Authority>) -> reqwest::Client {
        if is_interactive() {
            self.interactive.get(trusted)
        } else {
            self.clients.get(trusted)
        }
    }

    /// [`ServerMode::client`] with [`LONG_READ_TIMEOUT`].
    pub fn long_client(&self, trusted: Option<&Authority>) -> reqwest::Client {
        if is_interactive() {
            self.long_interactive.get(trusted)
        } else {
            self.long.get(trusted)
        }
    }
}

/// The installed [`ServerMode`], if any.
pub fn server_mode(state: &AppState) -> Option<Arc<ServerMode>> {
    if state.is_desktop {
        return None;
    }
    state.ext::<ServerMode>(SERVER_MODE_EXT)
}

/// True when running inside the server binary.
pub fn is_server_mode(state: &AppState) -> bool {
    server_mode(state).is_some()
}

/// Client for a fetch on behalf of the source whose own authority is
/// `trusted` (`None`: no source): in server mode the guarded client that
/// trusts exactly that authority, otherwise `state.http`. Pass the same
/// `trusted` as to [`check_fetch`].
pub fn guarded_client(state: &AppState, trusted: Option<&Authority>) -> reqwest::Client {
    match server_mode(state) {
        Some(mode) => mode.client(trusted),
        None if is_interactive() => interactive_client(state),
        None => state.http.clone(),
    }
}

/// [`guarded_client`] with [`LONG_READ_TIMEOUT`], for a request that may
/// wait up to 120 s for its response head (a big playlist or provider list).
/// Read its body with an idle limit of its own.
pub fn guarded_long_client(state: &AppState, trusted: Option<&Authority>) -> reqwest::Client {
    match server_mode(state) {
        Some(mode) => mode.long_client(trusted),
        None => desktop_long_client(state),
    }
}

/// `trusted` when `url` is on exactly that `host:port`, else `None`. The
/// guarded resolver trusts host names, not ports, so a fetch of a URL that
/// may be elsewhere (a download, a recording, a logo) passes this to
/// [`guarded_client`]: the same host on another port then gets the client
/// that trusts nothing, which refuses private addresses when it connects.
pub fn trust_for<'a>(url: &str, trusted: Option<&'a Authority>) -> Option<&'a Authority> {
    let parsed = Url::parse(url.trim()).ok();
    let target = parsed.as_ref().and_then(Authority::of);
    trusted.filter(|t| target.as_ref() == Some(*t))
}

/// Extension key of the desktop's short-connect client.
const INTERACTIVE_CLIENT_EXT: &str = "http.interactive";
/// Extension keys of the desktop's long-wait clients.
const LONG_CLIENT_EXT: &str = "http.long";
const LONG_INTERACTIVE_CLIENT_EXT: &str = "http.long.interactive";

/// `state.http` with [`INTERACTIVE_CONNECT_TIMEOUT`], built once.
fn interactive_client(state: &AppState) -> reqwest::Client {
    let client = state.ext_or_insert_with(INTERACTIVE_CLIENT_EXT, || {
        Arc::new(build(
            builder(None)
                .connect_timeout(INTERACTIVE_CONNECT_TIMEOUT)
                .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS)),
        ))
    });
    reqwest::Client::clone(&client)
}

/// `state.http` with [`LONG_READ_TIMEOUT`] (and inside [`interactive`] the
/// short connect timeout), each built once.
fn desktop_long_client(state: &AppState) -> reqwest::Client {
    let (key, connect) = if is_interactive() {
        (LONG_INTERACTIVE_CLIENT_EXT, INTERACTIVE_CONNECT_TIMEOUT)
    } else {
        (LONG_CLIENT_EXT, CONNECT_TIMEOUT)
    };
    let client = state.ext_or_insert_with(key, || {
        Arc::new(build(
            builder(None)
                .connect_timeout(connect)
                .read_timeout(LONG_READ_TIMEOUT)
                .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS)),
        ))
    });
    reqwest::Client::clone(&client)
}

/// Client for fetching user-supplied URLs that trusts no source: the guarded
/// client in server mode, otherwise `state.http`.
pub fn client_for(state: &AppState) -> reqwest::Client {
    guarded_client(state, None)
}

/// [`guarded_client`] for fetching `url` for the stored source `source_id`:
/// trusting the source's authority when `url` is on exactly it
/// ([`trust_for`]), else nothing (also when the source does not exist or
/// cannot be read).
pub async fn source_client(state: &AppState, source_id: &str, url: &str) -> reqwest::Client {
    if !is_server_mode(state) {
        return state.http.clone();
    }
    let trusted = source_authority(state, source_id)
        .await
        .unwrap_or_else(|err| {
            tracing::warn!(error = %err, "could not read the source's address; fetching untrusted");
            None
        });
    guarded_client(state, trust_for(url, trusted.as_ref()))
}

/// Client for a source's own API (Xtream server, Stalker portal). In server
/// mode this is the guarded client that trusts only the `host:port` of
/// `own_url` (the configured server or portal URL), so redirects elsewhere
/// stay guarded and no other request gains that trust; otherwise
/// `state.http`. Only for URLs built on `own_url`.
pub fn trusted_client(state: &AppState, own_url: &str) -> reqwest::Client {
    guarded_client(state, Authority::parse_lenient(own_url).as_ref())
}

/// [`trusted_client`] with [`LONG_READ_TIMEOUT`] ([`guarded_long_client`]).
pub fn trusted_long_client(state: &AppState, own_url: &str) -> reqwest::Client {
    guarded_long_client(state, Authority::parse_lenient(own_url).as_ref())
}

/// Validates a URL about to be fetched in server mode (no-op otherwise).
/// `trusted` is the requesting source's own authority; fetch with
/// [`guarded_client`] for the same authority so the connection and its
/// redirects follow the same trust.
pub async fn check_fetch(
    state: &AppState,
    url: &str,
    trusted: Option<&Authority>,
) -> CoreResult<()> {
    let Some(mode) = server_mode(state) else {
        return Ok(());
    };
    let parsed = Url::parse(url.trim())
        .map_err(|_| CoreError::Invalid("The address is not a valid URL.".into()))?;
    mode.guard.check(&parsed, trusted).await.map_err(Into::into)
}

/// Longest gap between two chunks of a playlist or EPG body before the
/// download is abandoned. Shorter than [`READ_TIMEOUT`]: a server that stops
/// mid-body rarely resumes.
pub const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

/// Next chunk of a response body, waiting at most `idle` for it. A stall is a
/// `Timeout` and any other failure goes through [`transport_error`], so both
/// name `host` and say what to do next.
pub async fn next_body_chunk<S, T>(
    stream: &mut S,
    host: &str,
    idle: Duration,
) -> CoreResult<Option<T>>
where
    S: futures::Stream<Item = reqwest::Result<T>> + Unpin,
{
    use futures::StreamExt;
    match cancellable(tokio::time::timeout(idle, stream.next())).await? {
        Ok(Some(Ok(chunk))) => Ok(Some(chunk)),
        Ok(Some(Err(err))) => Err(transport_error(host, err)),
        Ok(None) => Ok(None),
        Err(_) => Err(CoreError::Timeout(format!(
            "{host} stopped sending data in the middle of the download (nothing for {} s). Check that the server is online, then try again.",
            idle.as_secs()
        ))),
    }
}

/// Reads a response body into memory, failing with `Invalid` once it passes
/// `max` bytes (checked against Content-Length first, then while streaming).
/// `context` starts the error message ("Xtream get_vod_streams").
pub async fn read_capped(
    resp: reqwest::Response,
    context: &str,
    max: usize,
) -> CoreResult<bytes::Bytes> {
    read_body(resp, context, max, None).await
}

/// [`read_capped`] for a large list sent without a whole-request deadline:
/// the body must keep [`crate::m3u::body::MinRate::standard`] instead, and
/// falling under it is a `Timeout` (IN-2).
pub async fn read_capped_at_rate(
    resp: reqwest::Response,
    context: &str,
    max: usize,
) -> CoreResult<bytes::Bytes> {
    let rate = crate::m3u::body::MinRate::standard();
    read_body(resp, context, max, Some(rate)).await
}

async fn read_body(
    mut resp: reqwest::Response,
    context: &str,
    max: usize,
    mut rate: Option<crate::m3u::body::MinRate>,
) -> CoreResult<bytes::Bytes> {
    let host = resp.url().host_str().unwrap_or("the server").to_owned();
    let too_large = || {
        CoreError::Invalid(format!(
            "{context}: the server sent more than {}, which is not an API answer. Check the server URL.",
            size_text(max)
        ))
    };
    let declared = resp.content_length().unwrap_or(0);
    if declared > max as u64 {
        return Err(too_large());
    }
    // Content-Length is only a hint for the first allocation; never trust it
    // for more than a few MB.
    let mut buf = bytes::BytesMut::with_capacity((declared as usize).min(8 * 1024 * 1024));
    let too_slow = || {
        CoreError::Timeout(format!(
            "{context}: the server took too long to send its answer. Try again later."
        ))
    };
    // The request's own deadline ([`send_metadata`]) also bounds these
    // reads, a gap between two chunks ends the read after [`READ_TIMEOUT`]
    // even on a long-wait client, and a cancelled import stops at the next
    // read.
    loop {
        let chunk = match cancellable(tokio::time::timeout(READ_TIMEOUT, resp.chunk())).await? {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(err)) if !err.is_timeout() => return Err(CoreError::from(err)),
            Ok(Err(_)) | Err(_) => return Err(too_slow()),
        };
        if let Some(rate) = rate.as_mut() {
            rate.on_bytes(chunk.len(), &host).map_err(|err| match err {
                CoreError::Timeout(m) => CoreError::Timeout(m.replace("the playlist", "the list")),
                other => other,
            })?;
        }
        if buf.len().saturating_add(chunk.len()) > max {
            return Err(too_large());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf.freeze())
}

fn size_text(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MB", bytes / (1024 * 1024))
    } else {
        format!("{} KB", (bytes / 1024).max(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review round 1: the 401/403 hint fits every source kind, and a 5xx is
    /// `Server` (C12) except 504, which stays a timeout.
    #[test]
    fn status_errors_are_kind_neutral_and_classify_5xx_as_server() {
        let auth = status_error(reqwest::StatusCode::UNAUTHORIZED, "Xtream account");
        let text = auth.to_string();
        assert!(text.contains("Check your login details"), "{text}");
        assert!(!text.contains("MAC"), "{text}");
        for code in [500, 502, 503] {
            let err = status_error(reqwest::StatusCode::from_u16(code).unwrap(), "x");
            assert!(matches!(err, CoreError::Server(_)), "{code}: {err:?}");
            assert!(err.is_retryable());
        }
        let gw = status_error(reqwest::StatusCode::GATEWAY_TIMEOUT, "x");
        assert!(matches!(gw, CoreError::Timeout(_)), "{gw:?}");
        let busy = status_error(reqwest::StatusCode::TOO_MANY_REQUESTS, "x");
        assert!(matches!(busy, CoreError::Server(_)), "{busy:?}");
        assert!(busy.is_retryable());
    }
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn retries_only_transient_errors() {
        let calls = AtomicU32::new(0);
        let r: CoreResult<u32> = with_retry(3, || async {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                Err(CoreError::Network("flaky".into()))
            } else {
                Ok(n)
            }
        })
        .await;
        assert_eq!(r.unwrap(), 2);
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        let calls = AtomicU32::new(0);
        let r: CoreResult<()> = with_retry(5, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(CoreError::Invalid("bad".into()))
        })
        .await;
        assert!(r.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// IN-2: a caller can stop the retries of an error it knows will repeat.
    #[tokio::test]
    async fn retry_if_stops_on_a_rejected_error() {
        let calls = AtomicU32::new(0);
        let r: CoreResult<()> = with_retry_if(
            3,
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(CoreError::Timeout("slow".into()))
            },
            |err| !matches!(err, CoreError::Timeout(_)),
        )
        .await;
        assert!(matches!(r, Err(CoreError::Timeout(_))), "{r:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// IN-2: a large list read without a whole deadline still fails on a
    /// body that drips under the minimum rate (a 2 s window in tests).
    #[tokio::test]
    async fn rate_read_fails_on_a_dripping_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\n\r\n[").await;
                loop {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if sock.write_all(b" ").await.is_err() {
                        break;
                    }
                }
            }
        });
        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        let err = tokio::time::timeout(
            Duration::from_secs(15),
            read_capped_at_rate(resp, "Stalker itv/get_all_channels", 1024 * 1024),
        )
        .await
        .expect("the rate read hung")
        .unwrap_err();
        assert!(
            matches!(err, CoreError::Timeout(ref m) if m.contains("the list too slowly")),
            "{err:?}"
        );
    }

    /// GPT review (long-head-timeout-undercut): reqwest's read timeout also
    /// runs while a response head is awaited, so the normal clients' one cut
    /// big lists off at 60 s. The long-wait clients' read timeout outlasts
    /// every list head deadline they serve: 120 s for a playlist or an
    /// Xtream list in the app (`PLAYLIST_HEADER_TIMEOUT`), and Stalker's.
    #[test]
    fn long_wait_clients_outlast_the_list_head_deadlines() {
        let (normal, long) = (READ_TIMEOUT, LONG_READ_TIMEOUT);
        let heads = [
            Duration::from_secs(120),
            crate::stalker::session::LONG_TIMEOUT,
        ];
        for head in heads {
            assert!(normal < head && head < long, "{head:?}");
        }
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert!(backoff_delay(0) >= Duration::from_millis(300));
        assert!(backoff_delay(2) >= Duration::from_millis(1200));
        assert!(backoff_delay(30) <= Duration::from_secs(10));
    }

    #[test]
    fn status_mapping() {
        assert!(matches!(
            status_error(reqwest::StatusCode::UNAUTHORIZED, "x"),
            CoreError::Auth(_)
        ));
        assert!(status_error(reqwest::StatusCode::BAD_GATEWAY, "x").is_retryable());
        assert!(!status_error(reqwest::StatusCode::BAD_REQUEST, "x").is_retryable());
    }

    /// B8: every status error keeps "HTTP <code>" (the UI classifies on it)
    /// and ends with a next step.
    #[test]
    fn status_errors_say_what_to_do() {
        use reqwest::StatusCode as S;
        let msg = |s: S| status_error(s, "Xtream get_live_streams").to_string();
        let m = msg(S::UNAUTHORIZED);
        assert!(
            m.contains("Xtream get_live_streams: HTTP 401") && m.contains("login details"),
            "{m}"
        );
        assert!(msg(S::FORBIDDEN).contains("subscription"));
        assert!(
            msg(S::NOT_FOUND).contains("HTTP 404") && msg(S::NOT_FOUND).contains("Check the URL")
        );
        assert!(msg(S::GATEWAY_TIMEOUT).contains("Try again later"));
        assert!(msg(S::TOO_MANY_REQUESTS).contains("Wait a minute"));
        assert!(msg(S::SERVICE_UNAVAILABLE).contains("busy or down"));
        let custom = status_error_with_hint(S::NOT_FOUND, "ctx", "Do X.");
        assert!(
            matches!(custom, CoreError::NotFound(ref m) if m == "ctx: HTTP 404 Not Found. Do X.")
        );
    }

    /// A server that accepts TCP and never answers fails after the header
    /// timeout with an actionable, retryable error.
    #[tokio::test]
    async fn hanging_server_times_out_on_the_header_deadline() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = listener.accept().await {
                held.push(sock); // never answer
            }
        });
        let started = std::time::Instant::now();
        let limit = Duration::from_millis(400);
        let err = send_within(client(None).get(format!("http://{addr}/x")), limit)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
        assert!(err.is_retryable());
        assert!(err.to_string().contains("Check the address"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn refused_connection_names_the_host() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let err = send(client(None).get(format!("http://{addr}/x")))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Network(_)), "{err:?}");
        // L1-sources-home-7: a refused connection is final (it was retried
        // three times); the RPC error still offers Try again.
        assert!(!err.is_retryable());
        assert!(crate::error::RpcError::from(CoreError::Network(err.to_string())).retryable);
        assert!(
            err.to_string()
                .contains(&format!("Could not reach 127.0.0.1. {REFUSED_HINT} (")),
            "{err}"
        );
        // The detail is the OS-level cause, not reqwest's generic wrapper.
        assert!(!err.to_string().contains("error sending request"), "{err}");
    }

    /// Error with a fixed text and an optional cause, to build source chains.
    #[derive(Debug)]
    struct Layer(
        &'static str,
        Option<Box<dyn std::error::Error + Send + Sync>>,
    );

    impl fmt::Display for Layer {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1
                .as_deref()
                .map(|e| e as &(dyn std::error::Error + 'static))
        }
    }

    fn chain(outer: &'static str, inner: impl std::error::Error + Send + Sync + 'static) -> Layer {
        Layer(
            "client error (Connect)",
            Some(Box::new(Layer(outer, Some(Box::new(inner))))),
        )
    }

    #[test]
    fn connect_failures_are_classified_by_their_cause() {
        use std::io::{Error as IoError, ErrorKind};
        let refused = chain(
            "tcp connect error",
            IoError::from(ErrorKind::ConnectionRefused),
        );
        assert_eq!(connect_failure(&refused), Some(ConnectFailure::Refused));
        let windows_dns = chain(
            "dns error",
            IoError::other("No such host is known. (os error 11001)"),
        );
        assert_eq!(
            connect_failure(&windows_dns),
            Some(ConnectFailure::UnknownHost)
        );
        let unix_dns = chain(
            "dns error",
            IoError::other("failed to lookup address information: Name or service not known"),
        );
        assert_eq!(
            connect_failure(&unix_dns),
            Some(ConnectFailure::UnknownHost)
        );
        // A resolver that could not ask right now may answer on the next try.
        for temporary in [
            "failed to lookup address information: Temporary failure in name resolution",
            "This is usually a temporary error during hostname resolution and means that the local server did not receive a response from an authoritative server. (os error 11002)",
        ] {
            let e = chain("dns error", IoError::other(temporary));
            assert_eq!(connect_failure(&e), None, "{temporary}");
        }
        // rustls wraps its error in an io::Error whose text is rustls' own.
        let cert = chain(
            "tcp connect error",
            IoError::new(
                ErrorKind::InvalidData,
                Layer("invalid peer certificate: UnknownIssuer", None),
            ),
        );
        assert_eq!(connect_failure(&cert), Some(ConnectFailure::Certificate));
        // A reset or an unreachable network is worth another try.
        let reset = chain(
            "tcp connect error",
            IoError::from(ErrorKind::ConnectionReset),
        );
        assert_eq!(connect_failure(&reset), None);
        let unreachable = chain(
            "tcp connect error",
            IoError::new(ErrorKind::NotConnected, "Network unreachable"),
        );
        assert_eq!(connect_failure(&unreachable), None);
    }

    /// Resolver that fails every lookup with `msg` (no real DNS).
    struct FailingResolver(&'static str);

    impl Resolve for FailingResolver {
        fn resolve(&self, _name: Name) -> Resolving {
            let msg = self.0;
            Box::pin(async move {
                Err(Box::new(std::io::Error::other(msg))
                    as Box<dyn std::error::Error + Send + Sync>)
            })
        }
    }

    /// The real reqwest chain of a failed lookup: an unknown host is final
    /// and says to check the address; a temporary failure stays retryable.
    #[tokio::test]
    async fn unknown_host_is_final_and_temporary_dns_failure_is_retried() {
        let lookup = |msg: &'static str| {
            reqwest::Client::builder()
                .dns_resolver(Arc::new(FailingResolver(msg)))
                .build()
                .unwrap()
        };
        let err = send(
            lookup("No such host is known. (os error 11001)").get("http://tv.example.invalid/x"),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, CoreError::Network(_)), "{err:?}");
        assert!(!err.is_retryable(), "{err}");
        assert!(
            err.to_string().contains(&format!(
                "Could not reach tv.example.invalid. {UNKNOWN_HOST_HINT} ("
            )),
            "{err}"
        );
        let err =
            send(lookup("Temporary failure in name resolution").get("http://tv.example.invalid/x"))
                .await
                .unwrap_err();
        assert!(err.is_retryable(), "{err}");
        assert!(
            err.to_string().contains(&format!(
                "Could not reach tv.example.invalid. {RETRY_HINT} ("
            )),
            "{err}"
        );
    }

    #[test]
    fn permanent_hints_are_recognised_after_a_suffix() {
        for hint in [REFUSED_HINT, UNKNOWN_HOST_HINT, CERTIFICATE_HINT] {
            let msg = format!("Could not reach h. {hint} (x) The download failed after 1 tries.");
            assert!(is_permanent_transport(&msg), "{hint}");
        }
        assert!(!is_permanent_transport(&format!(
            "Could not reach h. {RETRY_HINT} (connection reset)"
        )));
    }

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn a(host: &str, port: u16) -> Authority {
        Authority {
            host: host.into(),
            port,
        }
    }

    #[test]
    fn public_ip_classification() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.5",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.1",
            "64:ff9b::a9fe:a9fe",
            "2002:c0a8:0101::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} should be private");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} should be public");
        }
    }

    #[test]
    fn target_checks() {
        assert!(check_target(&u("https://cdn.example.com/a.m3u8"), None, false).is_ok());
        assert!(matches!(
            check_target(&u("ftp://example.com/x"), None, false),
            Err(TargetError::Invalid(_))
        ));
        assert!(matches!(
            check_target(&u("http://user:pw@example.com/x"), None, false),
            Err(TargetError::Invalid(_))
        ));
        let refused = check_target(&u("http://192.168.1.10/x"), None, false).unwrap_err();
        assert!(
            matches!(&refused, TargetError::Forbidden(m) if m.contains("--allow-private-targets"))
        );
        assert!(matches!(
            check_target(&u("http://[::1]:8080/x"), None, false),
            Err(TargetError::Forbidden(_))
        ));
        assert!(matches!(
            check_target(&u("http://LOCALHOST./x"), None, false),
            Err(TargetError::Forbidden(_))
        ));
        let lan = a("192.168.1.10", 80);
        assert!(check_target(&u("http://192.168.1.10/x"), Some(&lan), false).is_ok());
        // Trust is scoped to host and port.
        assert!(check_target(&u("http://192.168.1.10:22/x"), Some(&lan), false).is_err());
        assert!(check_target(&u("http://[::1]/x"), Some(&a("::1", 80)), false).is_ok());
        assert!(check_target(&u("http://10.0.0.1/x"), None, true).is_ok());
        // Trusting one private host does not open others.
        assert!(check_target(&u("http://10.0.0.2/x"), Some(&a("10.0.0.1", 80)), false).is_err());
    }

    #[test]
    fn authorities() {
        assert_eq!(
            Authority::parse_lenient("http://Portal.Example:8080/c/"),
            Some(a("portal.example", 8080))
        );
        assert_eq!(
            Authority::parse_lenient("portal.example:8080/c/"),
            Some(a("portal.example", 8080))
        );
        assert_eq!(
            Authority::parse_lenient("https://x.example/"),
            Some(a("x.example", 443))
        );
        assert_eq!(
            Authority::parse_lenient("http://[::1]:7290"),
            Some(a("::1", 7290))
        );
        assert_eq!(Authority::parse_lenient("  "), None);
        assert_eq!(
            source_config_authority("xtream", r#"{"serverUrl":"http://10.0.0.5:8000"}"#),
            Some(a("10.0.0.5", 8000))
        );
        assert_eq!(source_config_authority("m3u", r#"{"origin":"text"}"#), None);
    }

    #[tokio::test]
    async fn trusted_name_is_scoped_to_its_port() {
        let g = NetGuard::new(false);
        // localhost names are refused outright unless trusted exactly.
        let lh = a("localhost", 8080);
        assert!(g
            .check(&u("http://localhost:8080/a"), Some(&lh))
            .await
            .is_ok());
        assert!(g
            .check(&u("http://localhost:22/a"), Some(&lh))
            .await
            .is_err());
        assert!(g.check(&u("http://localhost:22/a"), None).await.is_err());
    }

    /// GPT review (trusted-host-dns-rebinding): the resolver trusts a name,
    /// not a port, so the source-trusting client is only for its exact
    /// authority, and a redirect to the trusted name on another port ends
    /// the name's trust in that client's resolver.
    #[test]
    fn trust_is_for_the_exact_authority() {
        let own = a("provider.example", 8080);
        let mine = Some(&own);
        assert_eq!(trust_for("http://Provider.Example:8080/x", mine), mine);
        assert_eq!(trust_for("http://provider.example:8317/x", mine), None);
        assert_eq!(trust_for("https://provider.example/x", mine), None);
        assert_eq!(trust_for("http://other.example:8080/x", mine), None);
        assert_eq!(trust_for("http://provider.example:8080/x", None), None);
        assert_eq!(trust_for("not a url", mine), None);

        let resolver = NetGuard::new(false).resolver(mine);
        assert!(resolver.trusts("provider.example"));
        assert!(!resolver.trusts("other.example"));
        resolver.distrust();
        assert!(!resolver.trusts("provider.example"));
        // --allow-private-targets trusts every name anyway.
        let open = NetGuard::new(true).resolver(mine);
        open.distrust();
        assert!(open.trusts("provider.example"));
    }
}
