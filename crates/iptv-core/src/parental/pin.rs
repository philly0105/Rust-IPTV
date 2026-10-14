//! PIN rules and hashing.
//!
//! A PIN is 4 to 8 ASCII digits. It is stored as PBKDF2-HMAC-SHA256 over a
//! random 16-byte salt (`pbkdf2-sha256$<iterations>$<hex>` in `pin_hash`,
//! the salt as hex in `pin_salt`) and compared in constant time. The
//! iteration count is part of the stored string, so it can change later
//! without invalidating saved PINs.
//!
//! No PBKDF2 or HMAC crate is a dependency, so both are built here on `sha2`
//! (RFC 2104 and RFC 8018), with the RFC 6070-style SHA-256 vectors in the
//! tests below.

use rand::RngCore;
use sha2::{Digest, Sha256};

/// PBKDF2 rounds for new hashes.
pub const ITERATIONS: u32 = 100_000;
/// Scheme tag in the stored hash.
const SCHEME: &str = "pbkdf2-sha256";
/// Salt length in bytes.
const SALT_LEN: usize = 16;
/// Rounds a stored hash may ask for (guards against a doctored row that
/// would make every check take minutes).
const MAX_ITERATIONS: u32 = 10_000_000;

/// True when `pin` is 4 to 8 ASCII digits.
pub fn is_valid(pin: &str) -> bool {
    super::PIN_LENGTH.contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

/// A stored PIN: the hash string and the hex salt.
pub struct Stored {
    pub hash: String,
    pub salt: String,
}

/// Hashes a new PIN with a fresh random salt.
pub fn hash_new(pin: &str) -> Stored {
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let dk = pbkdf2_sha256(pin.as_bytes(), &salt, ITERATIONS);
    Stored {
        hash: format!("{SCHEME}${ITERATIONS}${}", hex::encode(dk)),
        salt: hex::encode(salt),
    }
}

/// True when `pin` matches the stored hash. A malformed stored value never
/// matches.
pub fn verify(pin: &str, hash: &str, salt_hex: &str) -> bool {
    let mut parts = hash.splitn(3, '$');
    let (Some(SCHEME), Some(iter), Some(expected)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Ok(iterations) = iter.parse::<u32>() else {
        return false;
    };
    let (Ok(expected), Ok(salt)) = (hex::decode(expected), hex::decode(salt_hex)) else {
        return false;
    };
    if !(1..=MAX_ITERATIONS).contains(&iterations) || expected.len() != 32 || salt.is_empty() {
        return false;
    }
    let actual = pbkdf2_sha256(pin.as_bytes(), &salt, iterations);
    constant_time_eq(&actual, &expected)
}

/// Compares two byte strings without an early exit on the first difference.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    // black_box keeps the optimizer from turning the fold into an early exit.
    std::hint::black_box(diff) == 0
}

/// HMAC-SHA256 with the key schedule done once: the hasher states after the
/// ipad and opad blocks are cloned for every message.
struct Hmac {
    inner: Sha256,
    outer: Sha256,
}

impl Hmac {
    fn new(key: &[u8]) -> Self {
        let mut block = [0u8; 64];
        if key.len() > block.len() {
            block[..32].copy_from_slice(&Sha256::digest(key));
        } else {
            block[..key.len()].copy_from_slice(key);
        }
        let mut ipad = block;
        let mut opad = block;
        for b in &mut ipad {
            *b ^= 0x36;
        }
        for b in &mut opad {
            *b ^= 0x5c;
        }
        let mut inner = Sha256::new();
        inner.update(ipad);
        let mut outer = Sha256::new();
        outer.update(opad);
        Self { inner, outer }
    }

    fn mac(&self, parts: &[&[u8]]) -> [u8; 32] {
        let mut h = self.inner.clone();
        for p in parts {
            h.update(p);
        }
        let ih = h.finalize();
        let mut o = self.outer.clone();
        o.update(ih);
        o.finalize().into()
    }
}

/// PBKDF2-HMAC-SHA256 with a 32-byte output (one block).
pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let prf = Hmac::new(password);
    let mut u = prf.mac(&[salt, &1u32.to_be_bytes()]);
    let mut t = u;
    for _ in 1..iterations {
        u = prf.mac(&[&u]);
        for (a, b) in t.iter_mut().zip(u.iter()) {
            *a ^= b;
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_matches_known_vectors() {
        let cases = [
            (
                1,
                "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
            ),
            (
                2,
                "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43",
            ),
            (
                4096,
                "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
            ),
        ];
        for (c, want) in cases {
            assert_eq!(
                hex::encode(pbkdf2_sha256(b"password", b"salt", c)),
                want,
                "c={c}"
            );
        }
        // A key longer than one block is hashed first (RFC 2104).
        let long = [b'k'; 100];
        assert_eq!(
            pbkdf2_sha256(&long, b"salt", 1),
            pbkdf2_sha256(&Sha256::digest(long), b"salt", 1)
        );
    }

    #[test]
    fn pin_rules() {
        for ok in ["0000", "1234", "12345678", "00000000"] {
            assert!(is_valid(ok), "{ok}");
        }
        for bad in [
            "",
            "123",
            "123456789",
            "12a4",
            " 1234",
            "1234 ",
            "١٢٣٤",
            "12.4",
            "-123",
        ] {
            assert!(!is_valid(bad), "{bad:?}");
        }
    }

    #[test]
    fn hash_and_verify() {
        let s = hash_new("2468");
        assert!(s.hash.starts_with("pbkdf2-sha256$100000$"));
        assert_eq!(s.hash.len(), "pbkdf2-sha256$100000$".len() + 64);
        assert_eq!(s.salt.len(), 32);
        assert!(verify("2468", &s.hash, &s.salt));
        assert!(!verify("2469", &s.hash, &s.salt));
        assert!(!verify("2468", &s.hash, "00"));
        // Fresh salt per hash.
        let t = hash_new("2468");
        assert_ne!(s.hash, t.hash);
        // Malformed rows never match.
        for bad in [
            "",
            "plain",
            "pbkdf2-sha256$x$00",
            "md5$1$00",
            "pbkdf2-sha256$0$00",
        ] {
            assert!(!verify("2468", bad, &s.salt), "{bad}");
        }
    }

    #[test]
    fn constant_time_eq_compares_whole_strings() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }
}
