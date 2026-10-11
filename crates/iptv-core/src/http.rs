//! Shared HTTP client and retry helper (SPEC C1).
//!
//! Every network call in the core goes through a client built here (timeouts,
//! gzip/brotli, bounded redirects) and, for idempotent requests, through
//! [`with_retry`]. Never log full URLs of portal requests; use
//! [`crate::logging::redact_url`].

use crate::error::{CoreError, CoreResult};
use crate::model::RequestHeaders;
use rand::Rng;
use std::future::Future;
use std::time::Duration;

/// Connect timeout for every request.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Read (idle body) timeout for every request.
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Maximum redirects followed.
pub const MAX_REDIRECTS: usize = 5;
/// Base delay of the exponential backoff in [`with_retry`].
pub const RETRY_BASE: Duration = Duration::from_millis(300);

/// Default User-Agent: `TsrustIPTV/<version>`.
pub fn default_user_agent() -> String {
    format!("TsrustIPTV/{}", env!("CARGO_PKG_VERSION"))
}

/// Builds a reqwest client: 20 s connect, 60 s read, gzip + brotli, at most 5
/// redirects, User-Agent `TsrustIPTV/<version>` unless overridden.
pub fn client(user_agent: Option<&str>) -> reqwest::Client {
    let ua = user_agent
        .map(str::to_owned)
        .unwrap_or_else(default_user_agent);
    reqwest::Client::builder()
        .user_agent(ua)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .gzip(true)
        .brotli(true)
        .build()
        .unwrap_or_else(|err| {
            tracing::error!(%err, "failed to build configured HTTP client; using defaults");
            reqwest::Client::new()
        })
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

/// Sends a request and turns a non-2xx status into [`status_error`].
pub async fn send_checked(
    req: reqwest::RequestBuilder,
    context: &str,
) -> CoreResult<reqwest::Response> {
    let resp = req.send().await?;
    let status = resp.status();
    if status.is_success() {
        Ok(resp)
    } else {
        Err(status_error(status, context))
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
}
