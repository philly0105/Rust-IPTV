//! `player_api.php` client.
//!
//! Every request: `GET {server}/player_api.php?username&password[&action..]`
//! with the VLC User-Agent some panels require, retried by
//! [`crate::http::with_retry`] on Network/Timeout. The password lives only in
//! the request query; logs carry the server, masked username and action, never the
//! URL, and errors come from reqwest with the URL stripped.

use super::raw::{RawAccount, RawUserInfo};
use super::url::{api_endpoint, normalize_server_url};
use crate::error::{CoreError, CoreResult};
use crate::http::{send_checked, with_retry};
use crate::model::XtreamSourceConfig;
use serde::de::DeserializeOwned;
use std::fmt;
use std::time::Instant;

/// User-Agent sent to Xtream panels (old app's `XTREAM_CLIENT_USER_AGENT`):
/// some panels challenge generic HTTP clients but allow IPTV players.
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
    attempts: u32,
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
        let password = cfg.password.trim().to_string();
        if username.is_empty() {
            return Err(CoreError::invalid("Enter the Xtream username."));
        }
        if password.is_empty() {
            return Err(CoreError::invalid("Enter the Xtream password."));
        }
        Ok(Self {
            http,
            server,
            username,
            password,
            attempts: ATTEMPTS,
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
    pub async fn get<T: DeserializeOwned>(
        &self,
        action: Option<&str>,
        params: &[(&str, String)],
    ) -> CoreResult<T> {
        let bytes = self.fetch(action, params).await?;
        decode(&bytes, action.unwrap_or("account"))
    }

    /// Raw body of a list action (decoded later on the blocking pool).
    pub async fn get_bytes(&self, action: &str) -> CoreResult<bytes::Bytes> {
        self.fetch(Some(action), &[]).await
    }

    async fn fetch(
        &self,
        action: Option<&str>,
        params: &[(&str, String)],
    ) -> CoreResult<bytes::Bytes> {
        let started = Instant::now();
        let label = action.unwrap_or("account");
        let bytes = with_retry(self.attempts, || async {
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
                .header(reqwest::header::USER_AGENT, XTREAM_USER_AGENT)
                .header(reqwest::header::ACCEPT, "application/json, */*")
                .query(&query);
            let resp = send_checked(req, &format!("Xtream {label}")).await?;
            Ok(resp.bytes().await?)
        })
        .await
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

    /// Account info. Fails with `Auth` when `user_info.auth == 0` and with
    /// `Invalid` when the response is not an Xtream account payload.
    pub async fn account(&self) -> CoreResult<RawAccount> {
        let acc: RawAccount = self.get(None, &[]).await?;
        check_auth(acc.user_info.as_ref())?;
        Ok(acc)
    }
}

/// Decodes a body; empty bodies are `null`, HTML or garbage is `Invalid`.
pub fn decode<T: DeserializeOwned>(bytes: &[u8], label: &str) -> CoreResult<T> {
    let trimmed = bytes.trim_ascii();
    let body: &[u8] = if trimmed.is_empty() { b"null" } else { trimmed };
    serde_json::from_slice(body).map_err(|err| {
        let looks_html = body.first() == Some(&b'<');
        CoreError::Invalid(if looks_html {
            format!("Xtream {label}: the server answered with a web page instead of JSON. Check the server URL.")
        } else {
            format!("Xtream {label}: unreadable response ({err}).")
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
        };
        assert!(matches!(
            XtreamClient::new(reqwest::Client::new(), &cfg),
            Err(CoreError::Invalid(_))
        ));
    }

    #[test]
    fn decode_handles_empty_and_html() {
        let v: serde_json::Value = decode(b"  ", "x").unwrap();
        assert!(v.is_null());
        let e = decode::<serde_json::Value>(b"<html>", "x").unwrap_err();
        assert!(e.to_string().contains("web page"));
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
}
