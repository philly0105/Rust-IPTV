//! Per-host breaker for upstream image fetches. A poster host that stops
//! answering (connect or response-head timeouts on two different images
//! within [`WINDOW`]) is not asked again for [`OPEN_FOR`]: its other images
//! fail at once instead of each waiting out the deadlines, and the requests
//! waiting on them let go of their connections. After that, one fetch at a
//! time tries the host again. Any answer from the host, even an error
//! status, closes the breaker; another timeout opens it again.

use crate::http::Authority;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Timeouts on two different images of one host within this window trip its
/// breaker. One timeout alone does not: a single blip on a busy CDN must not
/// send all its posters around the cache.
pub const WINDOW: Duration = Duration::from_secs(60);
/// How long a tripped breaker refuses its host before one fetch tries again.
pub const OPEN_FOR: Duration = Duration::from_secs(2 * 60);
/// The open time set by `imagecache::set_breaker_open_for_tests`, in ms; 0
/// means [`OPEN_FOR`].
pub(super) static OPEN_FOR_MS: AtomicU64 = AtomicU64::new(0);
/// Hosts tracked at most; a full map keeps only the open ones.
const MAX_HOSTS: usize = 1024;

/// [`OPEN_FOR`], or the test hook's value.
pub(super) fn open_for() -> Duration {
    match OPEN_FOR_MS.load(Ordering::Relaxed) {
        0 => OPEN_FOR,
        ms => Duration::from_millis(ms),
    }
}

/// What the breaker says about a new upstream fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Admit {
    /// Nothing is known against the host.
    Go,
    /// The open time is over and this fetch tries the host again; others
    /// are refused until it ends.
    Probe,
    /// Open, or another fetch is probing: fail without asking the host.
    Refuse,
}

#[derive(Debug, Default)]
struct Host {
    /// The last timeout that did not trip the breaker: when, and the image.
    strike: Option<(Instant, String)>,
    /// Set while the breaker is open: new fetches are refused until then.
    open_until: Option<Instant>,
    /// A probe is out.
    probing: bool,
}

/// Breakers by `host:port`. Only hosts that timed out have an entry.
#[derive(Debug, Default)]
pub(super) struct Breakers {
    hosts: HashMap<Authority, Host>,
}

impl Breakers {
    /// Whether a fetch from `host` may go out now.
    pub(super) fn admit(&mut self, host: &Authority, now: Instant) -> Admit {
        let Some(h) = self.hosts.get_mut(host) else {
            return Admit::Go;
        };
        match h.open_until {
            None => Admit::Go,
            Some(until) if now < until || h.probing => Admit::Refuse,
            Some(_) => {
                h.probing = true;
                Admit::Probe
            }
        }
    }

    /// Records how a fetch of `image` that [`Self::admit`] let through
    /// ended: `timed_out` when `host` did not take the connection or send a
    /// response head in time. Returns true when this trips the breaker.
    pub(super) fn record(
        &mut self,
        host: &Authority,
        image: &str,
        admitted: Admit,
        timed_out: bool,
        now: Instant,
    ) -> bool {
        if !timed_out {
            // The host answered (an error status counts): it is there.
            self.hosts.remove(host);
            return false;
        }
        if self.hosts.len() >= MAX_HOSTS && !self.hosts.contains_key(host) {
            self.hosts.retain(|_, h| h.open_until.is_some());
            if self.hosts.len() >= MAX_HOSTS {
                self.hosts.clear();
            }
        }
        let h = self.hosts.entry(host.clone()).or_default();
        if admitted == Admit::Probe && h.probing {
            // Still no answer: refuse the host for another while.
            h.probing = false;
            h.open_until = Some(now + open_for());
            return false;
        }
        if h.open_until.is_some() {
            // A fetch that went out before the breaker opened.
            return false;
        }
        match &h.strike {
            Some((at, earlier)) if earlier != image && now.duration_since(*at) < WINDOW => {
                h.strike = None;
                h.open_until = Some(now + open_for());
                true
            }
            _ => {
                h.strike = Some((now, image.to_owned()));
                false
            }
        }
    }

    /// Forgets every host (`images.clear`: "try again").
    pub(super) fn clear(&mut self) {
        self.hosts.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str) -> Authority {
        Authority {
            host: name.to_owned(),
            port: 80,
        }
    }

    const SECOND: Duration = Duration::from_secs(1);

    /// Two timeouts on different images trip the breaker.
    fn tripped(b: &mut Breakers, h: &Authority, t0: Instant) {
        assert!(!b.record(h, "http://h/a.jpg", Admit::Go, true, t0));
        assert_eq!(b.admit(h, t0), Admit::Go, "one timeout is not enough");
        assert!(b.record(h, "http://h/b.jpg", Admit::Go, true, t0 + SECOND));
    }

    #[test]
    fn two_timeouts_on_different_images_open_the_breaker_for_its_host_only() {
        let mut b = Breakers::default();
        let (dead, other) = (host("dead.example"), host("cdn.example"));
        let t0 = Instant::now();
        tripped(&mut b, &dead, t0);
        assert_eq!(b.admit(&dead, t0 + SECOND), Admit::Refuse);
        assert_eq!(b.admit(&dead, t0 + OPEN_FOR), Admit::Refuse);
        assert_eq!(b.admit(&other, t0 + SECOND), Admit::Go);
        // Fetches that went out before it opened neither trip nor extend it.
        assert!(!b.record(&dead, "http://h/c.jpg", Admit::Go, true, t0 + SECOND * 2));
        assert_eq!(b.admit(&dead, t0 + SECOND + OPEN_FOR), Admit::Probe);
    }

    #[test]
    fn timeouts_of_one_image_far_apart_or_after_an_answer_do_not_trip_it() {
        let mut b = Breakers::default();
        let h = host("slow.example");
        let t0 = Instant::now();
        // The same image twice (two widths of one poster).
        assert!(!b.record(&h, "http://h/a.jpg", Admit::Go, true, t0));
        assert!(!b.record(&h, "http://h/a.jpg", Admit::Go, true, t0 + SECOND));
        assert_eq!(b.admit(&h, t0 + SECOND), Admit::Go);
        // Two images, but further apart than the window.
        assert!(!b.record(&h, "http://h/b.jpg", Admit::Go, true, t0 + SECOND + WINDOW));
        assert_eq!(b.admit(&h, t0 + SECOND + WINDOW), Admit::Go);
        // An answer in between wipes the earlier timeout.
        assert!(!b.record(&h, "http://h/c.jpg", Admit::Go, false, t0 + WINDOW * 2));
        assert!(!b.record(&h, "http://h/d.jpg", Admit::Go, true, t0 + WINDOW * 2));
        assert_eq!(b.admit(&h, t0 + WINDOW * 2), Admit::Go);
    }

    #[test]
    fn after_the_open_time_one_probe_at_a_time_decides() {
        let mut b = Breakers::default();
        let h = host("flaky.example");
        let t0 = Instant::now();
        tripped(&mut b, &h, t0);
        let later = t0 + SECOND + OPEN_FOR;
        assert_eq!(b.admit(&h, later), Admit::Probe);
        assert_eq!(b.admit(&h, later), Admit::Refuse, "one probe at a time");
        // The probe times out: open for another while.
        assert!(!b.record(&h, "http://h/e.jpg", Admit::Probe, true, later + SECOND));
        assert_eq!(b.admit(&h, later + SECOND * 2), Admit::Refuse);
        let again = later + SECOND + OPEN_FOR;
        assert_eq!(b.admit(&h, again), Admit::Probe);
        // The probe gets an answer: closed, and everything goes again.
        assert!(!b.record(&h, "http://h/f.jpg", Admit::Probe, false, again + SECOND));
        assert_eq!(b.admit(&h, again + SECOND), Admit::Go);
        assert_eq!(b.admit(&h, again + SECOND), Admit::Go);
    }

    #[test]
    fn clear_closes_every_breaker() {
        let mut b = Breakers::default();
        let h = host("dead.example");
        let t0 = Instant::now();
        tripped(&mut b, &h, t0);
        b.clear();
        assert_eq!(b.admit(&h, t0 + SECOND), Admit::Go);
    }
}
