//! Tsrust IPTV core library.
//!
//! One crate owns everything heavy: storage, parsers, portal clients, EPG,
//! downloads, TMDB, remote control and players. The Tauri shell
//! (`iptv-tauri`) and the web server (`iptv-server`) are thin hosts that build
//! an [`state::AppState`], call [`rpc::init_all`], and forward
//! `rpc(cmd, args)` calls to [`rpc::RpcRouter::dispatch`].
//!
//! Contracts live in `docs/SPEC.md` section 4.

pub mod db;
pub mod error;
pub mod events;
pub mod http;
pub mod logging;
pub mod model;
pub mod rpc;
pub mod state;

// Feature modules (wave 1). Each exposes `rpc::register` and `init`.
// account:
pub mod account;
pub mod backup;
pub mod catalog;
// guide:
pub mod catchup;
pub mod downloads;
pub mod epg;
pub mod m3u;
pub mod player;
// recording:
pub mod recording;
pub mod remote;
pub mod settings;
pub mod sources;
pub mod stalker;
pub mod tmdb;
pub mod userstate;
pub mod xtream;

// failover: live channel alternates (`live.alternates`).
pub mod live;

pub use error::{CoreError, CoreResult, RpcError, RpcErrorCode};
pub use events::{AppEvent, BroadcastSink, EventSink, NoopSink};
pub use state::AppState;
