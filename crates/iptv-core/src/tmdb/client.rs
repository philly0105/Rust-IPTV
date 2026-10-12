//! Thin TMDB v3 HTTP client.
//!
//! - Base URL is configurable (tests point it at a local axum stub).
//! - v3 keys travel as the `api_key` query param, v4 tokens as `Bearer`.
//! - Every request goes through `http::with_retry` (Network/Timeout only).
//! - 429 responses honour `Retry-After` (capped) for every caller: the
//!   client remembers "rate limited until" and later requests wait it out.
//! - At most `MAX_CONCURRENT_REQUESTS` requests in flight.
//! - Never logs URLs or keys; only the API path.

use super::config::{
    ApiKey, MAX_CONCURRENT_REQUESTS, MAX_RETRY_AFTER, REQUEST_TIMEOUT, RETRY_ATTEMPTS,
};
use crate::error::{CoreError, CoreResult};
use serde::de::DeserializeOwned;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

pub struct TmdbClient {
    http: reqwest::Client,
    base_url: String,
    limiter: Semaphore,
    rate_limited_until: parking_lot::Mutex<Option<Instant>>,
}

/// Largest TMDB answer read into memory; real ones are a few hundred KB.
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// Parses `Retry-After` as delta-seconds or an HTTP date; capped.
pub fn parse_retry_after(value: Option<&str>) -> Duration {
    let fallback = Duration::from_secs(1);
    let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return fallback;
    };
    let d = if let Ok(secs) = v.parse::<f64>() {
        if secs.is_finite() && secs >= 0.0 {
            Duration::from_secs_f64(secs)
        } else {
            fallback
        }
    } else if let Ok(when) = chrono::DateTime::parse_from_rfc2822(v) {
        (when.with_timezone(&chrono::Utc) - chrono::Utc::now())
            .to_std()
            .unwrap_or(Duration::ZERO)
    } else {
        fallback
    };
    d.min(MAX_RETRY_AFTER)
}

impl TmdbClient {
    pub fn new(http: reqwest::Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            limiter: Semaphore::new(MAX_CONCURRENT_REQUESTS),
            rate_limited_until: parking_lot::Mutex::new(None),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// GET `{base}{path}` with `params`, decoded as JSON, with retries.
    pub async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
        key: &ApiKey,
    ) -> CoreResult<T> {
        crate::http::with_retry(RETRY_ATTEMPTS, || self.get_once(path, params, key)).await
    }

    async fn wait_for_rate_limit(&self) {
        let until = *self.rate_limited_until.lock();
        if let Some(until) = until {
            let now = Instant::now();
            if until > now {
                tokio::time::sleep(until - now).await;
            }
        }
    }

    async fn get_once<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
        key: &ApiKey,
    ) -> CoreResult<T> {
        self.wait_for_rate_limit().await;
        let _permit = self
            .limiter
            .acquire()
            .await
            .map_err(|_| CoreError::Network("TMDB client is shutting down".into()))?;

        let url = format!("{}{}", self.base_url, path);
        let mut req = self
            .http
            .get(&url)
            .timeout(REQUEST_TIMEOUT)
            .header(reqwest::header::ACCEPT, "application/json")
            .query(params);
        req = if key.is_bearer() {
            req.bearer_auth(key.expose())
        } else {
            req.query(&[("api_key", key.expose())])
        };

        let started = Instant::now();
        // http::send strips the URL (it may carry the api_key query param)
        // and names the host in transport failures ("Could not reach
        // api.themoviedb.org. ..."); statuses are handled below.
        let resp = crate::http::send(req).await.map_err(|err| match err {
            CoreError::Timeout(_) => CoreError::Timeout(
                "TMDB did not answer in time. Check your connection and try again.".into(),
            ),
            other => other,
        })?;
        let status = resp.status();
        tracing::debug!(
            path,
            status = status.as_u16(),
            ms = started.elapsed().as_millis() as u64,
            "tmdb request"
        );

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = parse_retry_after(
                resp.headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok()),
            );
            let until = Instant::now() + wait;
            {
                let mut slot = self.rate_limited_until.lock();
                if slot.is_none_or(|u| u < until) {
                    *slot = Some(until);
                }
            }
            tracing::warn!(path, wait_ms = wait.as_millis() as u64, "tmdb rate limited");
            return Err(CoreError::Network(
                "TMDB rate limit reached. Try again in a few seconds.".into(),
            ));
        }
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => CoreError::Auth(
                    "TMDB rejected the API key. Check it in Settings > TMDB.".into(),
                ),
                404 => CoreError::NotFound(format!("TMDB has no entry at {path}")),
                _ => crate::http::status_error(status, "TMDB request failed"),
            });
        }
        let bytes = crate::http::read_capped(resp, "TMDB", MAX_RESPONSE_BYTES).await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| CoreError::Invalid(format!("TMDB returned an unreadable response: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_parsing() {
        assert_eq!(parse_retry_after(Some("2")), Duration::from_secs(2));
        assert_eq!(parse_retry_after(Some("0.5")), Duration::from_millis(500));
        assert_eq!(parse_retry_after(Some("3600")), MAX_RETRY_AFTER);
        assert_eq!(parse_retry_after(None), Duration::from_secs(1));
        assert_eq!(parse_retry_after(Some("soon")), Duration::from_secs(1));
        assert_eq!(
            parse_retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")),
            Duration::ZERO
        );
    }
}
