//! Target validation for `/api/proxy` (SSRF guard).
//!
//! A proxy target must be `http`/`https`, must not carry userinfo, and must
//! not point at loopback, private, link-local or otherwise non-public
//! addresses, unless it is the requesting source's own host (an M3U URL,
//! Xtream server or Stalker portal on the LAN) or the operator passed
//! `--allow-private-targets`.
//!
//! IP literals are checked up front for every hop (redirects are followed
//! manually). Host names are checked by [`GuardedResolver`], the proxy
//! client's DNS resolver, at connect time, so a name cannot be re-resolved to
//! a private address between the check and the connection (DNS rebinding).

use parking_lot::RwLock;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashSet;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use url::{Host, Url};

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

/// Normalized host for comparisons: lowercase, no trailing dot, IPv6 without brackets.
pub fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// Host of a configured source URL; tolerates a missing scheme (`portal.example:8080/c/`).
pub fn source_host(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = Url::parse(raw)
        .ok()
        .filter(|u| u.has_host())
        .or_else(|| Url::parse(&format!("http://{raw}")).ok())?;
    parsed
        .host_str()
        .map(normalize_host)
        .filter(|h| !h.is_empty())
}

/// Checks scheme, userinfo and IP-literal hosts. `trusted_host` is the
/// source's own host; `allow_private` disables the address check entirely.
pub fn check_target(
    url: &Url,
    trusted_host: Option<&str>,
    allow_private: bool,
) -> Result<(), TargetError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(TargetError::Invalid(format!(
            "only http and https URLs can be proxied (got {}:)",
            url.scheme()
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(TargetError::Invalid(
            "URLs with credentials in the user-info part cannot be proxied".into(),
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| TargetError::Invalid("URL has no host".into()))?;
    let host_str = normalize_host(url.host_str().unwrap_or_default());
    if allow_private || trusted_host.is_some_and(|t| t == host_str) {
        return Ok(());
    }
    let refused = |what: &str| {
        Err(TargetError::Forbidden(format!(
            "refusing to proxy {what} {host_str}; only public hosts or the source's own host are allowed"
        )))
    };
    match host {
        Host::Ipv4(ip) if !is_public_ip(IpAddr::V4(ip)) => refused("private address"),
        Host::Ipv6(ip) if !is_public_ip(IpAddr::V6(ip)) => refused("private address"),
        Host::Domain(_) if host_str == "localhost" || host_str.ends_with(".localhost") => {
            refused("loopback host")
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

/// Hosts allowed to resolve to private addresses: the hosts of sources that
/// were used with the proxy. Shared between the handler and the resolver.
#[derive(Debug, Default)]
pub struct TrustedHosts(RwLock<HashSet<String>>);

impl TrustedHosts {
    pub fn insert(&self, host: &str) {
        let host = normalize_host(host);
        if !self.0.read().contains(&host) {
            self.0.write().insert(host);
        }
    }

    pub fn contains(&self, host: &str) -> bool {
        self.0.read().contains(&normalize_host(host))
    }
}

/// DNS resolver of the proxy client: drops non-public addresses unless the
/// name is a trusted source host or private targets are allowed.
pub struct GuardedResolver {
    pub trusted: Arc<TrustedHosts>,
    pub allow_private: bool,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = normalize_host(name.as_str());
        let trusted = self.allow_private || self.trusted.contains(&host);
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
                    "refusing to proxy {host}: it resolves only to private or loopback addresses"
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

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
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
        assert!(matches!(
            check_target(&u("http://192.168.1.10/x"), None, false),
            Err(TargetError::Forbidden(_))
        ));
        assert!(matches!(
            check_target(&u("http://[::1]:8080/x"), None, false),
            Err(TargetError::Forbidden(_))
        ));
        assert!(matches!(
            check_target(&u("http://LOCALHOST./x"), None, false),
            Err(TargetError::Forbidden(_))
        ));
        assert!(check_target(&u("http://192.168.1.10/x"), Some("192.168.1.10"), false).is_ok());
        assert!(check_target(&u("http://[::1]/x"), Some("::1"), false).is_ok());
        assert!(check_target(&u("http://10.0.0.1/x"), None, true).is_ok());
        // Trusting one private host does not open others.
        assert!(check_target(&u("http://10.0.0.2/x"), Some("10.0.0.1"), false).is_err());
    }

    #[test]
    fn source_hosts() {
        assert_eq!(
            source_host("http://Portal.Example:8080/c/").as_deref(),
            Some("portal.example")
        );
        assert_eq!(
            source_host("portal.example:8080/c/").as_deref(),
            Some("portal.example")
        );
        assert_eq!(source_host("http://[::1]:7290").as_deref(), Some("::1"));
        assert_eq!(source_host("  ").as_deref(), None);
    }
}
