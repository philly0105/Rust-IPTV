//! Phone pairing for LAN mode: one-time pairing codes, the pairing rate
//! limiter, per-device sessions, and the QR code. Everything here is pure
//! (time is passed in) so the lifecycle is testable without sockets.
//!
//! Secrets: the pairing code lives in memory only. Session tokens go to the
//! phone as an HttpOnly cookie; the core keeps only their SHA-256 hashes, in
//! `app_state` under [`DEVICES_KEY`] (never in Settings, backups or exports).

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::net::IpAddr;
use std::time::{Duration, Instant};

/// `app_state` key of the paired devices (token hashes, names, times).
pub const DEVICES_KEY: &str = "remote_paired_devices";

/// Session cookie name. Also listed in the log redaction parameters.
pub const SESSION_COOKIE: &str = "tsr_remote";

/// Cookie lifetime: 400 days, the most browsers keep.
pub const SESSION_MAX_AGE_SECS: u64 = 400 * 24 * 3600;

/// How long a pairing code stays valid.
pub const PAIR_CODE_TTL: Duration = Duration::from_secs(5 * 60);

/// Most paired devices kept; pairing another drops the least recently seen.
pub const MAX_DEVICES: usize = 16;

/// Failed pairing attempts allowed per address per window.
pub const PAIR_FAILS_PER_PEER: usize = 5;
/// Failures from all addresses together per window. Past this ceiling,
/// addresses that already failed are refused without a look at their code;
/// addresses with no recent failure (the owner's phone) still get theirs
/// checked. See [`PairLimiter`].
pub const PAIR_FAILS_GLOBAL: usize = 200;
pub const PAIR_WINDOW: Duration = Duration::from_secs(60);

/// `last_seen` is written to the database at most this often per device.
pub const LAST_SEEN_PERSIST: Duration = Duration::from_secs(5 * 60);

/// URL-safe random token of `bytes` bytes from the OS generator.
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Hex SHA-256 of a session token (what the database stores).
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Compares without an early exit on the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------------------
// Pairing code
// ---------------------------------------------------------------------------

struct PairCode {
    code: String,
    created: Instant,
}

/// The current one-time pairing code (128 bits, valid [`PAIR_CODE_TTL`]).
#[derive(Default)]
pub struct Pairing {
    current: Option<PairCode>,
}

impl fmt::Debug for Pairing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pairing")
            .field("code", &self.current.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl Pairing {
    /// The valid code and its remaining lifetime; mints a new one when there
    /// is none or it expired.
    pub fn current_or_new(&mut self, now: Instant) -> (String, Duration) {
        let fresh = self
            .current
            .as_ref()
            .is_some_and(|c| now.saturating_duration_since(c.created) < PAIR_CODE_TTL);
        if !fresh {
            self.current = Some(PairCode {
                code: random_token(16),
                created: now,
            });
        }
        let c = self.current.as_ref().expect("code just set");
        let left = PAIR_CODE_TTL.saturating_sub(now.saturating_duration_since(c.created));
        (c.code.clone(), left)
    }

    /// Uses up `candidate`: true when it is the current, unexpired code. The
    /// code is then gone, so it works once.
    pub fn consume(&mut self, candidate: &str, now: Instant) -> bool {
        let Some(c) = &self.current else {
            return false;
        };
        if now.saturating_duration_since(c.created) >= PAIR_CODE_TTL {
            self.current = None;
            return false;
        }
        if constant_time_eq(c.code.as_bytes(), candidate.trim().as_bytes()) {
            self.current = None;
            return true;
        }
        false
    }

    /// Drops the current code (Reset pairing).
    pub fn revoke(&mut self) {
        self.current = None;
    }
}

// ---------------------------------------------------------------------------
// Rate limiter for pairing attempts
// ---------------------------------------------------------------------------

/// Sliding-window limit on failed pairing attempts.
///
/// The 128-bit code is what keeps guessers out; the limiter only slows them
/// and keeps one noisy device from locking out everyone else:
///
/// - Each address gets [`PAIR_FAILS_PER_PEER`] failures per window, tracked in
///   a table of at most [`MAX_TRACKED_PEERS`] addresses.
/// - Past [`PAIR_FAILS_GLOBAL`] failures from everyone, addresses that failed
///   recently are refused at once, but an address with no recent failure
///   still gets its code checked, so the owner's phone pairs while another
///   device floods wrong codes.
/// - Trade-off: when the table is full of failing addresses (an attacker
///   with more than [`MAX_TRACKED_PEERS`] addresses on the network) and the
///   ceiling is reached, untracked addresses are refused too, because they
///   cannot be told apart from the attacker's. Pairing then waits for the
///   window to pass.
#[derive(Debug, Default)]
pub struct PairLimiter {
    per_peer: HashMap<IpAddr, VecDeque<Instant>>,
    global: VecDeque<Instant>,
}

pub const MAX_TRACKED_PEERS: usize = 256;

fn prune(q: &mut VecDeque<Instant>, now: Instant) {
    while q
        .front()
        .is_some_and(|t| now.saturating_duration_since(*t) >= PAIR_WINDOW)
    {
        q.pop_front();
    }
}

fn retry_after(q: &VecDeque<Instant>, now: Instant) -> Duration {
    q.front()
        .map(|t| PAIR_WINDOW.saturating_sub(now.saturating_duration_since(*t)))
        .unwrap_or(PAIR_WINDOW)
        .max(Duration::from_secs(1))
}

impl PairLimiter {
    /// `Err(retry_after)` when `peer` may not try a code now (see the type
    /// docs). Checked before the code is looked at.
    pub fn check(&mut self, peer: IpAddr, now: Instant) -> Result<(), Duration> {
        let own = self.per_peer.get_mut(&peer).map(|q| {
            prune(q, now);
            q.len()
        });
        if let Some(n) = own {
            if n >= PAIR_FAILS_PER_PEER {
                return Err(retry_after(&self.per_peer[&peer], now));
            }
        }
        prune(&mut self.global, now);
        if self.global.len() >= PAIR_FAILS_GLOBAL {
            let suspect = match own {
                Some(n) => n > 0,
                None => self.table_full(now),
            };
            if suspect {
                return Err(retry_after(&self.global, now));
            }
        }
        Ok(())
    }

    /// Records a failed attempt. Memory stays bounded: at most
    /// [`MAX_TRACKED_PEERS`] addresses and [`PAIR_FAILS_GLOBAL`] timestamps.
    pub fn record_failure(&mut self, peer: IpAddr, now: Instant) {
        if !self.per_peer.contains_key(&peer) && self.table_full(now) {
            // Full of addresses that are still failing: keep their counts
            // rather than evicting one, so a flood cannot reset them.
        } else {
            let q = self.per_peer.entry(peer).or_default();
            prune(q, now);
            q.push_back(now);
            while q.len() > PAIR_FAILS_PER_PEER {
                q.pop_front();
            }
        }
        prune(&mut self.global, now);
        self.global.push_back(now);
        while self.global.len() > PAIR_FAILS_GLOBAL {
            self.global.pop_front();
        }
    }

    /// True when the peer table holds [`MAX_TRACKED_PEERS`] addresses with
    /// failures inside the window (stale entries are dropped first).
    fn table_full(&mut self, now: Instant) -> bool {
        if self.per_peer.len() >= MAX_TRACKED_PEERS {
            self.per_peer.retain(|_, q| {
                prune(q, now);
                !q.is_empty()
            });
        }
        self.per_peer.len() >= MAX_TRACKED_PEERS
    }
}

// ---------------------------------------------------------------------------
// Devices and sessions
// ---------------------------------------------------------------------------

/// Browser and OS read from a User-Agent, for the paired-devices list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceName {
    /// Empty when unknown.
    #[serde(default)]
    pub browser: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
}

/// Short browser and OS names from a User-Agent header. Only fixed names are
/// returned, never header text, so nothing user-controlled reaches the UI.
pub fn summarize_user_agent(ua: &str) -> DeviceName {
    let has = |s: &str| ua.contains(s);
    let browser = if has("Edg/") || has("EdgA/") || has("EdgiOS/") {
        "Edge"
    } else if has("SamsungBrowser/") {
        "Samsung Internet"
    } else if has("OPR/") || has("Opera") {
        "Opera"
    } else if has("Firefox/") || has("FxiOS/") {
        "Firefox"
    } else if has("CriOS/") || has("Chrome/") {
        "Chrome"
    } else if has("Safari/") {
        "Safari"
    } else {
        ""
    };
    let os = if has("iPhone") {
        Some("iPhone")
    } else if has("iPad") {
        Some("iPad")
    } else if has("Android") {
        Some("Android")
    } else if has("Windows") {
        Some("Windows")
    } else if has("CrOS") {
        Some("ChromeOS")
    } else if has("Macintosh") || has("Mac OS X") {
        Some("Mac")
    } else if has("Linux") {
        Some("Linux")
    } else {
        None
    };
    DeviceName {
        browser: browser.to_string(),
        os: os.map(str::to_string),
    }
}

/// A paired device as stored.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    pub id: String,
    pub token_hash: String,
    pub name: DeviceName,
    pub paired_at: String,
    pub last_seen: String,
}

impl fmt::Debug for StoredDevice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredDevice")
            .field("id", &self.id)
            .field("token_hash", &"<redacted>")
            .field("name", &self.name)
            .field("last_seen", &self.last_seen)
            .finish()
    }
}

/// A paired device as listed by `remote.devices`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: DeviceName,
    pub paired_at: String,
    pub last_seen: String,
}

fn rfc3339(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Paired devices keyed by session token hash.
#[derive(Debug, Default)]
pub struct Sessions {
    devices: Vec<StoredDevice>,
    /// When each device's `last_seen` was last written to the database.
    persisted: HashMap<String, Instant>,
}

impl Sessions {
    /// Loads the stored list; unreadable JSON reads as no devices.
    pub fn from_json(text: &str) -> Self {
        let devices: Vec<StoredDevice> = serde_json::from_str(text).unwrap_or_else(|err| {
            tracing::warn!(%err, "remote control: stored paired devices unreadable; starting empty");
            Vec::new()
        });
        Self {
            devices,
            persisted: HashMap::new(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.devices).unwrap_or_else(|_| "[]".into())
    }

    pub fn len(&self) -> usize {
        self.devices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.devices.is_empty()
    }

    /// Pairs a device. Returns the new session token (sent once, as the cookie).
    pub fn add(
        &mut self,
        user_agent: &str,
        now: chrono::DateTime<chrono::Utc>,
        mono: Instant,
    ) -> String {
        let token = random_token(32);
        while self.devices.len() >= MAX_DEVICES {
            // Drop the least recently seen.
            let (i, _) = self
                .devices
                .iter()
                .enumerate()
                .min_by(|a, b| a.1.last_seen.cmp(&b.1.last_seen))
                .expect("non-empty");
            let gone = self.devices.remove(i);
            self.persisted.remove(&gone.id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let at = rfc3339(now);
        self.persisted.insert(id.clone(), mono);
        self.devices.push(StoredDevice {
            id,
            token_hash: hash_token(&token),
            name: summarize_user_agent(user_agent),
            paired_at: at.clone(),
            last_seen: at,
        });
        token
    }

    /// Validates a session token and stamps `last_seen`. `Some(true)` when the
    /// new `last_seen` should be written to the database.
    pub fn touch(
        &mut self,
        token: &str,
        now: chrono::DateTime<chrono::Utc>,
        mono: Instant,
    ) -> Option<bool> {
        let hash = hash_token(token);
        let d = self
            .devices
            .iter_mut()
            .find(|d| constant_time_eq(d.token_hash.as_bytes(), hash.as_bytes()))?;
        d.last_seen = rfc3339(now);
        let due = self
            .persisted
            .get(&d.id)
            .is_none_or(|t| mono.saturating_duration_since(*t) >= LAST_SEEN_PERSIST);
        if due {
            self.persisted.insert(d.id.clone(), mono);
        }
        Some(due)
    }

    /// Revokes one device. False when the id is unknown.
    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|d| d.id != id);
        self.persisted.remove(id);
        self.devices.len() != before
    }

    /// Revokes every device.
    pub fn clear(&mut self) {
        self.devices.clear();
        self.persisted.clear();
    }

    /// Devices, most recently seen first.
    pub fn list(&self) -> Vec<DeviceInfo> {
        let mut v: Vec<DeviceInfo> = self
            .devices
            .iter()
            .map(|d| DeviceInfo {
                id: d.id.clone(),
                name: d.name.clone(),
                paired_at: d.paired_at.clone(),
                last_seen: d.last_seen.clone(),
            })
            .collect();
        v.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        v
    }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/// The session token from a `Cookie` header, if present and well formed.
pub fn session_from_cookie(header: &str) -> Option<&str> {
    header.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name.trim() == SESSION_COOKIE)
            .then(|| value.trim())
            .filter(|v| !v.is_empty() && v.len() <= 128 && v.bytes().all(is_token_byte))
    })
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// Cookie path: only the API needs the session, so the browser does not send
/// it for other paths on this host. Cookies ignore the port, so another
/// service on the same IP that also serves `/api/remote-control` would still
/// get it; that residual is documented in `docs/architecture/remote-control.md`.
pub const COOKIE_PATH: &str = "/api/remote-control";

/// `Set-Cookie` value for a new session.
pub fn session_cookie(token: &str) -> String {
    format!("{SESSION_COOKIE}={token}; Path={COOKIE_PATH}; Max-Age={SESSION_MAX_AGE_SECS}; HttpOnly; SameSite=Strict")
}

/// `Set-Cookie` values that remove the session cookie: the current path and
/// `/`, which builds before the path was narrowed used.
pub fn clear_cookies() -> [String; 2] {
    [COOKIE_PATH, "/"]
        .map(|p| format!("{SESSION_COOKIE}=; Path={p}; Max-Age=0; HttpOnly; SameSite=Strict"))
}

// ---------------------------------------------------------------------------
// QR code
// ---------------------------------------------------------------------------

/// A QR code as one SVG path of dark modules in a `size` x `size` grid
/// (no quiet zone; the UI adds it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrSvg {
    pub size: u32,
    pub path: String,
}

/// Encodes `text` (medium error correction). `None` if it does not fit.
pub fn qr_svg(text: &str) -> Option<QrSvg> {
    use qrcodegen::{QrCode, QrCodeEcc};
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium).ok()?;
    let size = qr.size();
    let mut path = String::new();
    for y in 0..size {
        let mut x = 0;
        while x < size {
            if qr.get_module(x, y) {
                let start = x;
                while x < size && qr.get_module(x, y) {
                    x += 1;
                }
                let run = x - start;
                path.push_str(&format!("M{start} {y}h{run}v1h-{run}z"));
            } else {
                x += 1;
            }
        }
    }
    Some(QrSvg {
        size: u32::try_from(size).ok()?,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn tokens_are_random_url_safe_and_long() {
        let a = random_token(16);
        let b = random_token(16);
        assert_ne!(a, b);
        assert_eq!(a.len(), 22);
        assert!(a.bytes().all(is_token_byte));
        assert_eq!(random_token(32).len(), 43);
        assert_eq!(hash_token("x").len(), 64);
        assert_ne!(hash_token("x"), "x");
    }

    #[test]
    fn code_is_stable_until_used_or_expired() {
        let now = t0();
        let mut p = Pairing::default();
        let (c1, left) = p.current_or_new(now);
        assert_eq!(left, PAIR_CODE_TTL);
        let (c2, left) = p.current_or_new(now + Duration::from_secs(60));
        assert_eq!(c1, c2);
        assert_eq!(left, PAIR_CODE_TTL - Duration::from_secs(60));
        // Expired: a new code.
        let (c3, _) = p.current_or_new(now + PAIR_CODE_TTL);
        assert_ne!(c1, c3);
    }

    #[test]
    fn code_works_once() {
        let now = t0();
        let mut p = Pairing::default();
        let (code, _) = p.current_or_new(now);
        assert!(!p.consume("wrong", now));
        assert!(!p.consume("", now));
        assert!(p.consume(&code, now));
        assert!(!p.consume(&code, now), "second use must fail");
        let (next, _) = p.current_or_new(now);
        assert_ne!(next, code);
    }

    #[test]
    fn expired_code_is_refused() {
        let now = t0();
        let mut p = Pairing::default();
        let (code, _) = p.current_or_new(now);
        assert!(!p.consume(&code, now + PAIR_CODE_TTL));
        // Still refused after expiry even if asked again just before a new one.
        assert!(!p.consume(&code, now + PAIR_CODE_TTL + Duration::from_secs(1)));
    }

    #[test]
    fn revoked_code_is_refused() {
        let now = t0();
        let mut p = Pairing::default();
        let (code, _) = p.current_or_new(now);
        p.revoke();
        assert!(!p.consume(&code, now));
    }

    #[test]
    fn debug_never_prints_the_code() {
        let mut p = Pairing::default();
        let (code, _) = p.current_or_new(t0());
        let dbg = format!("{p:?}");
        assert!(!dbg.contains(&code));
        assert!(dbg.contains("<redacted>"));
    }

    #[test]
    fn limiter_blocks_per_peer_then_recovers() {
        let now = t0();
        let a: IpAddr = "192.168.1.20".parse().unwrap();
        let b: IpAddr = "192.168.1.21".parse().unwrap();
        let mut l = PairLimiter::default();
        for _ in 0..PAIR_FAILS_PER_PEER {
            assert!(l.check(a, now).is_ok());
            l.record_failure(a, now);
        }
        let wait = l.check(a, now).unwrap_err();
        assert_eq!(wait, PAIR_WINDOW);
        // Another phone is not affected.
        assert!(l.check(b, now).is_ok());
        // After the window the peer may try again.
        assert!(l.check(a, now + PAIR_WINDOW).is_ok());
    }

    fn nth_peer(i: usize) -> IpAddr {
        format!("10.1.{}.{}", i / 250, i % 250 + 1).parse().unwrap()
    }

    /// R-remote-F4: other devices flooding wrong codes past the global
    /// ceiling do not lock out a phone that has not failed.
    #[test]
    fn global_ceiling_refuses_failing_peers_but_not_clean_ones() {
        let now = t0();
        let mut l = PairLimiter::default();
        // A few addresses (well under the table size) fail until the ceiling.
        let attackers = PAIR_FAILS_GLOBAL / (PAIR_FAILS_PER_PEER - 1);
        for i in 0..attackers {
            for _ in 0..PAIR_FAILS_PER_PEER - 1 {
                l.record_failure(nth_peer(i), now);
            }
        }
        assert_eq!(l.global.len(), PAIR_FAILS_GLOBAL);
        // An attacker under its own limit is refused by the ceiling.
        assert!(l.check(nth_peer(0), now).is_err());
        // The owner's phone has no failures and still gets its code checked.
        let phone: IpAddr = "192.168.1.30".parse().unwrap();
        assert!(l.check(phone, now).is_ok());
        // Once it fails it counts as suspect too.
        l.record_failure(phone, now);
        assert!(l.check(phone, now).is_err());
        // Memory stays bounded.
        assert!(l.global.len() <= PAIR_FAILS_GLOBAL);
        assert!(l.per_peer.values().all(|q| q.len() <= PAIR_FAILS_PER_PEER));
        // The window passes.
        assert!(l.check(nth_peer(0), now + PAIR_WINDOW).is_ok());
    }

    /// The documented trade-off: with the table full of failing addresses
    /// and the ceiling reached, untracked addresses are refused as well.
    #[test]
    fn saturated_table_refuses_untracked_peers_and_bounds_memory() {
        let now = t0();
        let mut l = PairLimiter::default();
        // Stale entries are dropped to make room.
        for i in 0..MAX_TRACKED_PEERS {
            l.record_failure(nth_peer(i), now - PAIR_WINDOW);
        }
        l.record_failure("10.9.9.9".parse().unwrap(), now);
        assert_eq!(l.per_peer.len(), 1);

        for i in 0..(MAX_TRACKED_PEERS + 10) {
            l.record_failure(nth_peer(i), now);
        }
        assert_eq!(l.per_peer.len(), MAX_TRACKED_PEERS);
        assert_eq!(l.global.len(), PAIR_FAILS_GLOBAL);
        let fresh: IpAddr = "192.168.1.30".parse().unwrap();
        assert!(l.check(fresh, now).is_err());
        assert!(l.check(fresh, now + PAIR_WINDOW).is_ok());
    }

    const IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const ANDROID: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

    #[test]
    fn user_agents_summarize_to_fixed_names() {
        let n = summarize_user_agent(IPHONE);
        assert_eq!(
            (n.browser.as_str(), n.os.as_deref()),
            ("Safari", Some("iPhone"))
        );
        let n = summarize_user_agent(ANDROID);
        assert_eq!(
            (n.browser.as_str(), n.os.as_deref()),
            ("Chrome", Some("Android"))
        );
        let n = summarize_user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
        );
        assert_eq!(
            (n.browser.as_str(), n.os.as_deref()),
            ("Firefox", Some("Windows"))
        );
        let n = summarize_user_agent("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36");
        assert_eq!(n.browser, "Samsung Internet");
        let n = summarize_user_agent("<script>alert(1)</script>");
        assert_eq!(n, DeviceName::default());
        assert_eq!(summarize_user_agent(""), DeviceName::default());
    }

    #[test]
    fn session_lifecycle() {
        let now = chrono::Utc::now();
        let mono = t0();
        let mut s = Sessions::default();
        let tok = s.add(IPHONE, now, mono);
        assert_eq!(s.len(), 1);
        // Stored as a hash only.
        let json = s.to_json();
        assert!(!json.contains(&tok));
        assert!(json.contains(&hash_token(&tok)));
        assert!(!format!("{s:?}").contains(&hash_token(&tok)));

        // Valid token; last_seen persisted at most every LAST_SEEN_PERSIST.
        assert_eq!(s.touch(&tok, now, mono), Some(false));
        assert_eq!(s.touch(&tok, now, mono + LAST_SEEN_PERSIST), Some(true));
        assert_eq!(s.touch(&tok, now, mono + LAST_SEEN_PERSIST), Some(false));
        assert_eq!(s.touch("bogus", now, mono), None);

        // Survives a reload (desktop restart).
        let mut reloaded = Sessions::from_json(&json);
        assert_eq!(reloaded.touch(&tok, now, mono), Some(true));

        // Revoke one.
        let id = s.list()[0].id.clone();
        assert!(s.revoke(&id));
        assert!(!s.revoke(&id));
        assert_eq!(s.touch(&tok, now, mono), None);

        // Reset revokes all.
        let a = reloaded.add(ANDROID, now, mono);
        reloaded.clear();
        assert!(reloaded.is_empty());
        assert_eq!(reloaded.touch(&a, now, mono), None);
        assert_eq!(reloaded.touch(&tok, now, mono), None);
    }

    #[test]
    fn device_cap_drops_least_recently_seen() {
        let base = chrono::Utc::now();
        let mono = t0();
        let mut s = Sessions::default();
        let first = s.add(IPHONE, base, mono);
        let mut toks = Vec::new();
        for i in 1..MAX_DEVICES {
            toks.push(s.add(ANDROID, base + chrono::Duration::seconds(i as i64), mono));
        }
        assert_eq!(s.len(), MAX_DEVICES);
        // `first` is the oldest; seeing it makes toks[0] the oldest.
        s.touch(&first, base + chrono::Duration::hours(1), mono);
        s.add(ANDROID, base + chrono::Duration::hours(2), mono);
        assert_eq!(s.len(), MAX_DEVICES);
        assert!(s.touch(&first, base, mono).is_some());
        assert!(s.touch(&toks[0], base, mono).is_none());
    }

    #[test]
    fn corrupt_store_reads_empty() {
        assert!(Sessions::from_json("not json").is_empty());
        assert!(Sessions::from_json("[]").is_empty());
    }

    #[test]
    fn cookie_parsing() {
        assert_eq!(session_from_cookie("tsr_remote=abc-_1"), Some("abc-_1"));
        assert_eq!(
            session_from_cookie("a=1; tsr_remote=xyz ; b=2"),
            Some("xyz")
        );
        assert_eq!(session_from_cookie("tsr_remote="), None);
        assert_eq!(session_from_cookie("tsr_remote=a b"), None);
        assert_eq!(session_from_cookie("tsr_remote=a;b"), Some("a"));
        assert_eq!(session_from_cookie("other=1"), None);
        assert_eq!(session_from_cookie("xtsr_remote=1"), None);
        let c = session_cookie("tok");
        assert!(c.contains("HttpOnly"));
        assert!(c.contains("SameSite=Strict"));
        assert!(c.starts_with("tsr_remote=tok;"));
        for clear in clear_cookies() {
            assert!(clear.contains("Max-Age=0"), "{clear}");
        }
    }

    /// R-remote-F7: the session cookie is scoped to the API path, so other
    /// pages and services on the same host do not receive it.
    #[test]
    fn session_cookie_is_scoped_to_the_api_path() {
        let c = session_cookie("tok");
        assert!(c.contains("; Path=/api/remote-control;"), "{c}");
        assert!(!c.contains("Path=/;"), "{c}");
        let [scoped, legacy] = clear_cookies();
        assert!(scoped.contains("Path=/api/remote-control;"), "{scoped}");
        assert!(legacy.contains("Path=/;"), "{legacy}");
    }

    #[test]
    fn qr_encodes_a_pairing_url() {
        let q = qr_svg("http://192.168.1.5:7310/?pair=AAAAAAAAAAAAAAAAAAAAAA").unwrap();
        assert!(q.size >= 21);
        assert!(
            q.path.starts_with("M0 0h7"),
            "finder pattern first: {}",
            &q.path[..20]
        );
    }
}
