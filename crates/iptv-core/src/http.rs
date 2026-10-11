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
//! ([`METADATA_DEADLINE`]).
//!
//! Server mode (SSRF guard): the server binary installs [`ServerMode`] in the
//! state's extensions. Core fetches of user-supplied URLs (downloads,
//! playlists, XMLTV; Xtream/Stalker via [`trusted_client`]) then use the
//! guarded client ([`client_for`]), whose DNS resolver and redirect
//! policy refuse loopback, private and link-local addresses, and call
//! [`check_fetch`] first. A source's own `host:port` is trusted for that
//! source's fetches; `--allow-private-targets` turns the guard off. The
//! desktop app and tests without [`ServerMode`] are unaffected.

use crate::error::{CoreError, CoreResult};
use crate::model::RequestHeaders;
use crate::state::AppState;
use parking_lot::RwLock;
use rand::Rng;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use url::{Host, Url};

/// Connect timeout for every request.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Read (idle body) timeout for every request.
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);
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

/// Runs `op` up to `attempts` times (at least once). Retries only
/// `CoreError::Network` and `CoreError::Timeout`, sleeping [`backoff_delay`]
/// between tries. Returns the last error.
pub async fn with_retry<T, F, Fut>(attempts: u32, op: F) -> CoreResult<T>
where
    F: Fn() -> Fut,
    Fut: Future<Output = CoreResult<T>>,
{
    let attempts = attempts.max(1);
    let mut n = 0;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(err) if err.is_retryable() && n + 1 < attempts => {
                let delay = backoff_delay(n);
                tracing::debug!(attempt = n + 1, ?delay, error = %err, "retrying after transient error");
                tokio::time::sleep(delay).await;
                n += 1;
            }
            Err(err) => return Err(err),
        }
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

/// Maps a non-success HTTP status to a `CoreError` (401/403 Auth, 404 NotFound,
/// 408/504 Timeout, 5xx and 429 Network (retryable), other 4xx Invalid).
pub fn status_error(status: reqwest::StatusCode, context: &str) -> CoreError {
    let msg = format!("{context}: HTTP {status}");
    match status.as_u16() {
        401 | 403 => CoreError::Auth(msg),
        404 => CoreError::NotFound(msg),
        408 | 504 => CoreError::Timeout(msg),
        429 | 500..=599 => CoreError::Network(msg),
        _ => CoreError::Invalid(msg),
    }
}

/// Turns a transport failure into an actionable error. Timeouts stay
/// `Timeout` and everything else `Network`, so both remain retryable; a
/// request refused by the server-mode guard becomes `Invalid` (not retried).
pub fn transport_error(host: &str, err: reqwest::Error) -> CoreError {
    if let Some(blocked) = find_blocked(&err) {
        return CoreError::Invalid(blocked.0);
    }
    if err.is_timeout() {
        return CoreError::Timeout(format!(
            "{host} did not respond in time. Check the address and that the server is online, then try again."
        ));
    }
    let detail = root_cause(&err.without_url());
    CoreError::Network(format!(
        "Could not reach {host}. Check the address and that the server is online, then try again. ({detail})"
    ))
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
    match tokio::time::timeout(header_timeout, client.execute(request)).await {
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
    let resp = send(req).await?;
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

/// Source authorities allowed to reach private addresses (each source's own
/// `host:port`, recorded when the source is used).
#[derive(Debug, Default)]
pub struct TrustedHosts(RwLock<HashSet<Authority>>);

impl TrustedHosts {
    pub fn insert(&self, auth: &Authority) {
        if !self.0.read().contains(auth) {
            self.0.write().insert(auth.clone());
        }
    }

    /// Exact `host:port` match.
    pub fn contains(&self, auth: &Authority) -> bool {
        self.0.read().contains(auth)
    }

    /// Any port of `host` is trusted (DNS resolution only sees names).
    pub fn contains_host(&self, host: &str) -> bool {
        let host = normalize_host(host);
        self.0.read().iter().any(|a| a.host == host)
    }
}

/// DNS resolver of guarded clients: drops non-public addresses unless the
/// name belongs to a trusted source or private targets are allowed.
pub struct GuardedResolver {
    pub trusted: Arc<TrustedHosts>,
    pub allow_private: bool,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = normalize_host(name.as_str());
        let trusted = self.allow_private || self.trusted.contains_host(&host);
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

/// Guard policy shared by the server's proxy and the core's guarded client.
#[derive(Debug, Default)]
pub struct NetGuard {
    pub trusted: Arc<TrustedHosts>,
    pub allow_private: bool,
}

impl NetGuard {
    pub fn new(allow_private: bool) -> Self {
        Self {
            trusted: Arc::default(),
            allow_private,
        }
    }

    /// Records a source's own authority as trusted.
    pub fn trust(&self, auth: &Authority) {
        self.trusted.insert(auth);
    }

    /// Resolver for a client that follows this policy.
    pub fn resolver(&self) -> Arc<GuardedResolver> {
        Arc::new(GuardedResolver {
            trusted: self.trusted.clone(),
            allow_private: self.allow_private,
        })
    }

    /// [`check_target`], plus: a host name trusted only on another port
    /// (the resolver trusts names, not ports) is resolved now and refused
    /// when it points at a non-public address.
    pub async fn check(&self, url: &Url, trusted: Option<&Authority>) -> Result<(), TargetError> {
        check_target(url, trusted, self.allow_private)?;
        if self.allow_private {
            return Ok(());
        }
        let Some(auth) = Authority::of(url) else {
            return Ok(());
        };
        if !self.needs_port_check(url, &auth, trusted) {
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
    /// redirect to a trusted host name on a port that is not trusted.
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
        if !self.needs_port_check(url, &auth, trusted) {
            return Ok(());
        }
        use std::net::ToSocketAddrs;
        let addrs: Vec<SocketAddr> = (auth.host.as_str(), auth.port)
            .to_socket_addrs()
            .map(Iterator::collect)
            .unwrap_or_default();
        other_port_verdict(&auth, &addrs)
    }

    /// A host name trusted only on another port.
    fn needs_port_check(&self, url: &Url, auth: &Authority, trusted: Option<&Authority>) -> bool {
        matches!(url.host(), Some(Host::Domain(_)))
            && trusted != Some(auth)
            && !self.trusted.contains(auth)
            && self.trusted.contains_host(&auth.host)
    }
}

fn other_port_verdict(auth: &Authority, addrs: &[SocketAddr]) -> Result<(), TargetError> {
    if addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(TargetError::Forbidden(format!(
            "Refusing to connect to {auth}: only the source's own port on this private host is allowed. {ALLOW_PRIVATE_HINT}"
        )));
    }
    Ok(())
}

/// Marker and guarded client installed by the server binary (extension
/// [`SERVER_MODE_EXT`]). Its presence means "server mode": file access by
/// path and download-folder changes are refused, and fetches are guarded.
pub struct ServerMode {
    pub guard: Arc<NetGuard>,
    client: reqwest::Client,
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
        let policy_guard = guard.clone();
        let redirect = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error(format!("stopped after {MAX_REDIRECTS} redirects"));
            }
            let url = attempt.url();
            // IP literals are checked here (exact host:port trust); host
            // names by the resolver when the redirect connects, except a
            // name trusted only on another port (the resolver trusts names
            // on every port), which gets NetGuard::check's port rule here.
            let trusted = Authority::of(url).filter(|a| policy_guard.trusted.contains(a));
            let checked = check_target(url, trusted.as_ref(), policy_guard.allow_private)
                .and_then(|()| policy_guard.check_other_port_blocking(url, trusted.as_ref()));
            match checked {
                Ok(()) => attempt.follow(),
                Err(TargetError::Invalid(m) | TargetError::Forbidden(m)) => {
                    attempt.error(BlockedTarget(m))
                }
            }
        });
        let client = build(
            builder(None)
                .redirect(redirect)
                .dns_resolver(guard.resolver()),
        );
        let mode = Arc::new(Self { guard, client });
        state.set_ext(SERVER_MODE_EXT, mode.clone());
        Some(mode)
    }

    /// The guarded client.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
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

/// Client for fetching user-supplied URLs: the guarded client in server
/// mode, otherwise `state.http`.
pub fn client_for(state: &AppState) -> reqwest::Client {
    match server_mode(state) {
        Some(mode) => mode.client.clone(),
        None => state.http.clone(),
    }
}

/// Client for a source's own API (Xtream server, Stalker portal). In server
/// mode this is the guarded client with the `host:port` of `own_url` (the
/// configured server or portal URL) trusted, so redirects elsewhere stay
/// guarded; otherwise `state.http`.
pub fn trusted_client(state: &AppState, own_url: &str) -> reqwest::Client {
    match server_mode(state) {
        Some(mode) => {
            if let Some(a) = Authority::parse_lenient(own_url) {
                mode.guard.trust(&a);
            }
            mode.client.clone()
        }
        None => state.http.clone(),
    }
}

/// Validates a URL about to be fetched in server mode (no-op otherwise).
/// `trusted` is the requesting source's own authority; it is recorded so the
/// guarded resolver lets that host resolve to a private address.
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
    if let Some(t) = trusted {
        mode.guard.trust(t);
    }
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
    match tokio::time::timeout(idle, stream.next()).await {
        Ok(Some(Ok(chunk))) => Ok(Some(chunk)),
        Ok(Some(Err(err))) => Err(transport_error(host, err)),
        Ok(None) => Ok(None),
        Err(_) => Err(CoreError::Timeout(format!(
            "{host} stopped sending data in the middle of the download (nothing for {} s). Check that the server is online, then try again.",
            idle.as_secs()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(err.is_retryable());
        assert!(
            err.to_string()
                .contains("Could not reach 127.0.0.1. Check the address"),
            "{err}"
        );
        // The detail is the OS-level cause, not reqwest's generic wrapper.
        assert!(!err.to_string().contains("error sending request"), "{err}");
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
        g.trust(&lh);
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
}
