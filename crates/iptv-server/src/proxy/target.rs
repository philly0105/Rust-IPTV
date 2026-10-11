//! Target validation for `/api/proxy` (SSRF guard).
//!
//! The guard lives in [`iptv_core::http`] so the core's own fetches
//! (downloads, playlists, XMLTV) follow the same policy in server mode. A
//! proxy target must be `http`/`https`, must not carry userinfo, and must not
//! point at loopback, private, link-local or otherwise non-public addresses,
//! unless it is the requesting source's own `host:port` (an M3U URL, Xtream
//! server or Stalker portal on the LAN) or the operator passed
//! `--allow-private-targets`.
//!
//! IP literals are checked up front for every hop (redirects are followed
//! manually). Host names are checked by [`GuardedResolver`], the proxy
//! client's DNS resolver, at connect time, so a name cannot be re-resolved to
//! a private address between the check and the connection (DNS rebinding).

pub use iptv_core::http::{
    check_target, find_blocked, is_public_ip, normalize_host, Authority, BlockedTarget,
    GuardedResolver, NetGuard, TargetError, TrustedHosts,
};
