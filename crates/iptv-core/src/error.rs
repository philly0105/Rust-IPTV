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
    /// The player engine (mpv) is missing or cannot run (C12).
    EngineMissing,
    /// The upstream server answered with HTTP 5xx (C12).
    Server,
}

impl RpcErrorCode {
    /// HTTP status used by the server binary for this code (C1).
    pub const fn http_status(self) -> u16 {
        match self {
            Self::NotFound => 404,
            Self::Invalid => 400,
            Self::Auth => 401,
            Self::Timeout => 504,
            Self::Network | Self::Server => 502,
            Self::EngineMissing => 503,
            Self::Unsupported => 501,
            Self::Conflict => 409,
            Self::Io | Self::Db | Self::Internal => 500,
        }
    }

    /// The snake_case wire name (`"not_found"`), also stored in
    /// `sources.last_error_code` (C10).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Invalid => "invalid",
            Self::Network => "network",
            Self::Auth => "auth",
            Self::Timeout => "timeout",
            Self::Io => "io",
            Self::Db => "db",
            Self::Unsupported => "unsupported",
            Self::Conflict => "conflict",
            Self::Internal => "internal",
            Self::EngineMissing => "engine_missing",
            Self::Server => "server",
        }
    }

    /// Parses a wire name; `None` for anything unknown (an older or newer
    /// build's value is dropped rather than failing the read).
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim() {
            "not_found" => Self::NotFound,
            "invalid" => Self::Invalid,
            "network" => Self::Network,
            "auth" => Self::Auth,
            "timeout" => Self::Timeout,
            "io" => Self::Io,
            "db" => Self::Db,
            "unsupported" => Self::Unsupported,
            "conflict" => Self::Conflict,
            "internal" => Self::Internal,
            "engine_missing" => Self::EngineMissing,
            "server" => Self::Server,
            _ => return None,
        })
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
        let retryable = matches!(
            code,
            RpcErrorCode::Network | RpcErrorCode::Timeout | RpcErrorCode::Server
        );
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
    /// Upstream HTTP 5xx (retryable, code `server`).
    #[error("server: {0}")]
    Server(String),
    /// The player engine is missing or cannot run (code `engine_missing`).
    #[error("engine missing: {0}")]
    EngineMissing(String),
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
    /// True for errors `http::with_retry` retries (Network, Timeout, Server).
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Network(_) | Self::Timeout(_) | Self::Server(_))
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

    /// The RPC code this error crosses the boundary with (same mapping as
    /// `RpcError::from(CoreError)`), without consuming it. Used for
    /// `Source.lastErrorCode` and `import.progress` `code` (C10).
    pub fn code(&self) -> RpcErrorCode {
        match self {
            Self::NotFound(_) => RpcErrorCode::NotFound,
            Self::Invalid(_) => RpcErrorCode::Invalid,
            Self::Network(_) => RpcErrorCode::Network,
            Self::Auth(_) => RpcErrorCode::Auth,
            Self::Timeout(_) => RpcErrorCode::Timeout,
            Self::Server(_) => RpcErrorCode::Server,
            Self::EngineMissing(_) => RpcErrorCode::EngineMissing,
            Self::Io(e) => match e.kind() {
                std::io::ErrorKind::NotFound => RpcErrorCode::NotFound,
                std::io::ErrorKind::TimedOut => RpcErrorCode::Timeout,
                _ => RpcErrorCode::Io,
            },
            Self::Db(rusqlite::Error::QueryReturnedNoRows) => RpcErrorCode::NotFound,
            Self::Db(_) => RpcErrorCode::Db,
            Self::Conflict(_) => RpcErrorCode::Conflict,
            Self::Unsupported(_) => RpcErrorCode::Unsupported,
            Self::Other(_) => RpcErrorCode::Internal,
        }
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
            Some(s)
                if s == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || (s.is_server_error() && s != reqwest::StatusCode::GATEWAY_TIMEOUT) =>
            {
                CoreError::Server(msg)
            }
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
    /// Last line of defence for "messages must never contain secrets": the
    /// message is passed through [`crate::logging::redact_text`].
    fn from(err: CoreError) -> Self {
        let mut rpc = Self::from_unredacted(err);
        if let std::borrow::Cow::Owned(clean) = crate::logging::redact_text(&rpc.message) {
            rpc.message = clean;
        }
        rpc
    }
}

impl RpcError {
    fn from_unredacted(err: CoreError) -> Self {
        match err {
            CoreError::NotFound(m) => RpcError::not_found(m),
            CoreError::Invalid(m) => RpcError::invalid(m),
            CoreError::Network(m) => RpcError::network(m),
            CoreError::Auth(m) => RpcError::auth(m),
            CoreError::Timeout(m) => RpcError::timeout(m),
            CoreError::Server(m) => RpcError::new(RpcErrorCode::Server, m),
            CoreError::EngineMissing(m) => RpcError::new(RpcErrorCode::EngineMissing, m),
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
        // B8: secrets in a core message never cross the RPC boundary.
        let leaked = RpcError::from(CoreError::Network(
            "upstream said: bad request ?username=bob&password=hunter2".into(),
        ));
        assert!(!leaked.message.contains("hunter2") && !leaked.message.contains("bob"));
        assert_eq!(leaked.code, RpcErrorCode::Network);
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

    /// C10: `CoreError::code` agrees with the RPC mapping, and wire names
    /// round-trip through `as_str` / `parse` and serde.
    #[test]
    fn core_error_code_matches_rpc_mapping_and_names_roundtrip() {
        let cases = vec![
            CoreError::NotFound("x".into()),
            CoreError::Invalid("x".into()),
            CoreError::Network("x".into()),
            CoreError::Auth("x".into()),
            CoreError::Timeout("x".into()),
            CoreError::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "t")),
            CoreError::Io(std::io::Error::other("o")),
            CoreError::Db(rusqlite::Error::QueryReturnedNoRows),
            CoreError::Db(rusqlite::Error::InvalidQuery),
            CoreError::Conflict("x".into()),
            CoreError::Unsupported("x".into()),
            CoreError::Other(anyhow::anyhow!("x")),
        ];
        for e in cases {
            let code = e.code();
            assert_eq!(RpcError::from(e).code, code);
            assert_eq!(RpcErrorCode::parse(code.as_str()), Some(code));
            assert_eq!(serde_json::to_value(code).unwrap(), code.as_str());
        }
        assert_eq!(RpcErrorCode::parse("bogus"), None);
    }
}
