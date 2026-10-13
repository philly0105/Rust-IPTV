//! LAN mode address selection (pure, except [`interface_addrs`]).
//!
//! The remote control listens on loopback always and, in LAN mode, also on the
//! machine's private IPv4 addresses: RFC 1918 (`10/8`, `172.16/12`,
//! `192.168/16`) and link-local (`169.254/16`). Public, loopback, unspecified,
//! CGNAT and IPv6 addresses are never bound.

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// A private address the LAN listener binds, with the interface it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAddr {
    pub ip: Ipv4Addr,
    pub interface: String,
}

/// True for RFC 1918 and link-local IPv4 addresses.
pub fn is_lan_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// The LAN-eligible IPv4 address of `ip`, unwrapping IPv4-mapped IPv6.
pub fn lan_ipv4(ip: IpAddr) -> Option<Ipv4Addr> {
    let v4 = match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => v6.to_ipv4_mapped()?,
    };
    is_lan_ipv4(v4).then_some(v4)
}

/// Interface name fragments of VPN and overlay adapters. Their addresses are
/// still bound (the name is only a guess) but sorted after everything else, so
/// the QR code defaults to the home network; Settings lets the user pick
/// another address.
const VPN_HINTS: &[&str] = &[
    "vpn",
    "tap",
    "tun",
    "wireguard",
    "wg",
    "nordlynx",
    "zerotier",
    "openvpn",
    "proton",
    "tailscale",
    "anyconnect",
    "fortinet",
    "forticlient",
    "globalprotect",
    "pangp",
    "cisco",
    "hamachi",
    "radmin",
];

/// Interface name fragments of virtual adapters (Hyper-V, WSL, VMs,
/// containers). Their addresses are still bound but sorted after physical
/// adapters, so the QR code points at the real network first.
const VIRTUAL_HINTS: &[&str] = &[
    "vethernet",
    "hyper-v",
    "wsl",
    "virtualbox",
    "vbox",
    "vmware",
    "vmnet",
    "docker",
    "br-",
    "virbr",
    "veth",
];

fn rank(a: &LanAddr) -> (u8, u8, Ipv4Addr) {
    let name = a.interface.to_ascii_lowercase();
    let hinted = |hints: &[&str]| hints.iter().any(|h| name.contains(h));
    let class = if hinted(VPN_HINTS) {
        2
    } else {
        u8::from(hinted(VIRTUAL_HINTS))
    };
    let o = a.ip.octets();
    let range = match o {
        [192, 168, ..] => 0,
        [10, ..] => 1,
        [172, ..] => 2,
        _ => 3, // link-local
    };
    (class, range, a.ip)
}

/// Keeps the private IPv4 addresses of `candidates` (interface name, address),
/// deduplicated and ordered best first: physical, then virtual, then VPN
/// adapters; within each, `192.168` / `10` / `172.16` / link-local (the
/// usual home ranges first).
pub fn select_lan_addrs<I, S>(candidates: I) -> Vec<LanAddr>
where
    I: IntoIterator<Item = (S, IpAddr)>,
    S: Into<String>,
{
    let mut out: Vec<LanAddr> = Vec::new();
    for (name, ip) in candidates {
        let Some(ip) = lan_ipv4(ip) else { continue };
        if out.iter().any(|a| a.ip == ip) {
            continue;
        }
        out.push(LanAddr {
            ip,
            interface: name.into(),
        });
    }
    out.sort_by_key(rank);
    out
}

/// Addresses the server binds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindPlan {
    pub loopback: SocketAddr,
    pub lan: Vec<LanAddr>,
}

/// Loopback always; LAN addresses only when LAN mode is on and the app runs
/// as the desktop shell (server mode never pairs phones).
pub fn plan_binds(
    port: u16,
    lan_enabled: bool,
    is_desktop: bool,
    candidates: Vec<LanAddr>,
) -> BindPlan {
    BindPlan {
        loopback: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        lan: if lan_enabled && is_desktop {
            candidates
        } else {
            Vec::new()
        },
    }
}

/// Whether an interface can carry phones on the home network: not loopback,
/// and not point-to-point (PPP and tunnel adapters, which is how Windows types
/// many VPNs; a phone is never on the other end of one).
pub fn usable_interface(is_loopback: bool, is_p2p: bool) -> bool {
    !is_loopback && !is_p2p
}

/// The machine's usable interface addresses ([`usable_interface`]). Reading
/// them opens no socket. Errors are logged and read as "no addresses".
pub fn interface_addrs() -> Vec<(String, IpAddr)> {
    match if_addrs::get_if_addrs() {
        Ok(list) => list
            .into_iter()
            .filter(|i| usable_interface(i.is_loopback(), i.is_p2p()))
            .map(|i| {
                let ip = i.ip();
                (i.name, ip)
            })
            .collect(),
        Err(err) => {
            tracing::warn!(%err, "remote control: cannot list network interfaces");
            Vec::new()
        }
    }
}

/// `http://ip:port`.
pub fn lan_url(ip: Ipv4Addr, port: u16) -> String {
    format!("http://{ip}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn private_and_link_local_only() {
        for ok in [
            "10.0.0.1",
            "10.255.255.254",
            "172.16.0.1",
            "172.31.255.1",
            "192.168.1.5",
            "169.254.10.20",
        ] {
            assert!(lan_ipv4(ip(ok)).is_some(), "{ok}");
        }
        for bad in [
            "127.0.0.1",
            "0.0.0.0",
            "8.8.8.8",
            "172.15.0.1",
            "172.32.0.1",
            "100.64.0.1",
            "192.169.0.1",
            "255.255.255.255",
            "224.0.0.1",
            "::1",
            "fe80::1",
            "fd00::1",
            "2001:db8::1",
        ] {
            assert!(lan_ipv4(ip(bad)).is_none(), "{bad}");
        }
        // IPv4-mapped IPv6 unwraps.
        let mapped = IpAddr::V6(Ipv4Addr::new(192, 168, 0, 9).to_ipv6_mapped());
        assert_eq!(lan_ipv4(mapped), Some(Ipv4Addr::new(192, 168, 0, 9)));
        assert_eq!(lan_ipv4(IpAddr::V6(Ipv6Addr::LOCALHOST)), None);
    }

    #[test]
    fn selection_filters_dedupes_and_ranks() {
        let picked = select_lan_addrs([
            ("vEthernet (WSL)", ip("172.20.80.1")),
            ("Ethernet", ip("8.8.4.4")),
            ("Loopback", ip("127.0.0.1")),
            ("Wi-Fi", ip("10.0.0.7")),
            ("Wi-Fi", ip("fe80::1234")),
            ("Ethernet", ip("192.168.1.5")),
            ("Ethernet 2", ip("192.168.1.5")),
            ("Ethernet 3", ip("169.254.3.4")),
            ("Tailscale", ip("100.101.102.103")),
        ]);
        let ips: Vec<String> = picked.iter().map(|a| a.ip.to_string()).collect();
        assert_eq!(
            ips,
            ["192.168.1.5", "10.0.0.7", "169.254.3.4", "172.20.80.1"]
        );
        assert_eq!(picked[0].interface, "Ethernet");
        assert!(select_lan_addrs(Vec::<(String, IpAddr)>::new()).is_empty());
        assert!(select_lan_addrs([("x", ip("203.0.113.9"))]).is_empty());
    }

    /// R-remote-F5: VPN and overlay adapters sort after the home network, so
    /// the QR code does not default to an address the phone cannot reach.
    #[test]
    fn vpn_adapters_rank_last() {
        let picked = select_lan_addrs([
            ("NordLynx", ip("10.5.0.2")),
            ("OpenVPN TAP-Windows6", ip("10.8.0.6")),
            ("vEthernet (WSL)", ip("172.20.80.1")),
            ("ZeroTier One [abc]", ip("172.22.1.9")),
            ("Wi-Fi", ip("172.16.0.20")),
            ("wg0", ip("10.66.66.2")),
            ("Ethernet", ip("10.0.0.7")),
            ("Cisco AnyConnect Secure Mobility Client", ip("10.200.1.4")),
        ]);
        let names: Vec<&str> = picked.iter().map(|a| a.interface.as_str()).collect();
        assert_eq!(
            names,
            [
                "Ethernet",
                "Wi-Fi",
                "vEthernet (WSL)",
                "NordLynx",
                "OpenVPN TAP-Windows6",
                "wg0",
                "Cisco AnyConnect Secure Mobility Client",
                "ZeroTier One [abc]",
            ]
        );
    }

    #[test]
    fn point_to_point_and_loopback_interfaces_are_skipped() {
        assert!(usable_interface(false, false));
        assert!(!usable_interface(true, false));
        assert!(!usable_interface(false, true));
    }

    #[test]
    fn plan_binds_lan_only_when_enabled_on_desktop() {
        let cands = select_lan_addrs([("Ethernet", ip("192.168.1.5"))]);
        let p = plan_binds(7310, false, true, cands.clone());
        assert_eq!(p.loopback, "127.0.0.1:7310".parse().unwrap());
        assert!(p.lan.is_empty());
        assert!(plan_binds(7310, true, false, cands.clone()).lan.is_empty());
        let p = plan_binds(7310, true, true, cands);
        assert_eq!(p.lan.len(), 1);
        assert!(p.lan.iter().all(|a| is_lan_ipv4(a.ip)));
    }

    #[test]
    fn urls() {
        assert_eq!(
            lan_url(Ipv4Addr::new(192, 168, 1, 5), 7310),
            "http://192.168.1.5:7310"
        );
    }
}
