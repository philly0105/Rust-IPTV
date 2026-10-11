//! Error types (SPEC C1).
//!
//! `CoreError` is the internal error used across modules (`CoreResult<T>`).
//! `RpcError` is what crosses the IPC / HTTP boundary as JSON
//! `{code, message, retryable, details?}`.
//!
//! Messages must never contain secrets. `From<reqwest::Error>` strips the URL
//! (Xtream URLs carry the username and password in the path and query).

use serde::{Deserialize, Serialize};

/// Machine-readable error category. Serialized snake_case (`"not_found"`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RpcErrorCode {
    NotFound,
    Invalid,
    Network,
    Auth,
    Timeout,
    Io,
    Db,
    Unsupported,
    Conflict,
    Internal,
}

impl RpcErrorCode {
    /// HTTP status used by the server binary for this code (C1).
    pub const fn http_status(self) -> u16 {
        match self {
            Self::NotFound => 404,
            Self::Invalid => 400,
            Self::Auth => 401,
            Self::Timeout => 504,
            Self::Network => 502,
            Self::Unsupported => 501,
            Self::Conflict => 409,
            Self::Io | Self::Db | Self::Internal => 500,
        }
    }
}

/// Error returned by every RPC handler.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error, PartialEq)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}: {message}")]
pub struct RpcError {
    pub code: RpcErrorCode,
    pub message: String,
    /// True when repeating the same call later may succeed (network, timeout, busy db).
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl RpcError {
    pub fn new(code: RpcErrorCode, msg: impl Into<String>) -> Self {
        let retryable = matches!(code, RpcErrorCode::Network | RpcErrorCode::Timeout);
        Self {
            code,
            message: msg.into(),
            retryable,
            details: None,
        }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::NotFound, msg)
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::Invalid, msg)
    }
    /// Network failure; `retryable = true`.
    pub fn network(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::Network, msg)
    }
    pub fn auth(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::Auth, msg)
    }
    /// Timeout; `retryable = true`.
    pub fn timeout(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::Timeout, msg)
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::Unsupported, msg)
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::Conflict, msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::Internal, msg)
    }
    /// Attaches structured details (shown by the UI's ErrorState, never secrets).
    pub fn with_details(mut self, v: serde_json::Value) -> Self {
        self.details = Some(v);
        self
    }
    /// Overrides the retryable flag.
    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

/// Internal error type for core modules.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid: {0}")]
    Invalid(String),
    #[error("network: {0}")]
    Network(String),
    #[error("auth: {0}")]
    Auth(String),
    #[error("timeout: {0}")]
    Timeout(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Result alias for core code.
pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    /// True for errors `http::with_retry` retries (Network, Timeout).
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Network(_) | Self::Timeout(_))
    }

    /// Shorthand constructors.
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::Invalid(msg.into())
    }
    pub fn network(msg: impl Into<String>) -> Self {
        Self::Network(msg.into())
    }
}

/// True when a SQLite error means the database file itself is unusable.
pub fn is_sqlite_corruption(err: &rusqlite::Error) -> bool {
    use rusqlite::ErrorCode;
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _)
            if matches!(e.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

fn is_sqlite_busy(err: &rusqlite::Error) -> bool {
    use rusqlite::ErrorCode;
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _) if matches!(e.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

impl From<reqwest::Error> for CoreError {
    fn from(err: reqwest::Error) -> Self {
        let timeout = err.is_timeout();
        let status = err.status();
        // Strip the URL: it may carry credentials.
        let msg = err.without_url().to_string();
        match status {
            Some(s)
                if s == reqwest::StatusCode::UNAUTHORIZED
                    || s == reqwest::StatusCode::FORBIDDEN =>
            {
                CoreError::Auth(msg)
            }
            Some(s) if s == reqwest::StatusCode::NOT_FOUND => CoreError::NotFound(msg),
            _ if timeout => CoreError::Timeout(msg),
            _ => CoreError::Network(msg),
        }
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(err: serde_json::Error) -> Self {
        CoreError::Invalid(err.to_string())
    }
}

impl From<r2d2::Error> for CoreError {
    fn from(err: r2d2::Error) -> Self {
        CoreError::Other(anyhow::anyhow!("database pool: {err}"))
    }
}

impl From<tokio::task::JoinError> for CoreError {
    fn from(err: tokio::task::JoinError) -> Self {
        CoreError::Other(anyhow::anyhow!("background task failed: {err}"))
    }
}

impl From<CoreError> for RpcError {
    fn from(err: CoreError) -> Self {
        match err {
            CoreError::NotFound(m) => RpcError::not_found(m),
            CoreError::Invalid(m) => RpcError::invalid(m),
            CoreError::Network(m) => RpcError::network(m),
            CoreError::Auth(m) => RpcError::auth(m),
            CoreError::Timeout(m) => RpcError::timeout(m),
            CoreError::Io(e) => RpcError::from(e),
            CoreError::Db(e) => RpcError::from(e),
            CoreError::Conflict(m) => RpcError::conflict(m),
            CoreError::Unsupported(m) => RpcError::unsupported(m),
            CoreError::Other(e) => RpcError::internal(format!("{e:#}")),
        }
    }
}

impl From<rusqlite::Error> for RpcError {
    fn from(err: rusqlite::Error) -> Self {
        if matches!(err, rusqlite::Error::QueryReturnedNoRows) {
            return RpcError::not_found("no matching record");
        }
        let busy = is_sqlite_busy(&err);
        RpcError::new(RpcErrorCode::Db, err.to_string()).retryable(busy)
    }
}

impl From<reqwest::Error> for RpcError {
    fn from(err: reqwest::Error) -> Self {
        RpcError::from(CoreError::from(err))
    }
}

impl From<std::io::Error> for RpcError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => RpcError::not_found(err.to_string()),
            std::io::ErrorKind::TimedOut => RpcError::timeout(err.to_string()),
            _ => RpcError::new(RpcErrorCode::Io, err.to_string()),
        }
    }
}

impl From<serde_json::Error> for RpcError {
    fn from(err: serde_json::Error) -> Self {
        RpcError::invalid(err.to_string())
    }
}

impl From<anyhow::Error> for RpcError {
    fn from(err: anyhow::Error) -> Self {
        RpcError::from(CoreError::Other(err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_error_json_shape() {
        let e = RpcError::network("down").with_details(serde_json::json!({"host": "x"}));
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "network");
        assert_eq!(v["retryable"], true);
        assert_eq!(v["details"]["host"], "x");
        let nf = serde_json::to_value(RpcError::not_found("x")).unwrap();
        assert_eq!(nf["code"], "not_found");
        assert!(nf.get("details").is_none());
        assert_eq!(nf["retryable"], false);
    }

    #[test]
    fn core_error_maps_codes() {
        assert_eq!(
            RpcError::from(CoreError::Timeout("t".into())).code,
            RpcErrorCode::Timeout
        );
        assert_eq!(
            RpcError::from(CoreError::Db(rusqlite::Error::QueryReturnedNoRows)).code,
            RpcErrorCode::NotFound
        );
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope");
        assert_eq!(RpcError::from(CoreError::Io(io)).code, RpcErrorCode::Io);
        assert_eq!(RpcErrorCode::Unsupported.http_status(), 501);
    }
}
