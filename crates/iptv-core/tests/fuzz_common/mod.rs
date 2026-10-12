//! Shared helpers for the `fuzz_*` integration tests: a seeded xorshift PRNG,
//! generators for random bytes, hostile UTF-8, fixture mutations and random
//! JSON, and a runner that catches panics per input and prints the seed and
//! the input that triggered them.
//!
//! Every run is deterministic. `FUZZ_SEED=<u64>` changes the base seed and
//! `FUZZ_CASES=<n>` the number of inputs per entry point, for longer local
//! runs: `FUZZ_CASES=200000 cargo test -p iptv-core --test fuzz_m3u`.
//! To replay one failure, run with the printed `FUZZ_SEED` and `FUZZ_CASES=1`.

#![allow(dead_code)]

use serde_json::{json, Map, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Default inputs per entry point.
pub const DEFAULT_CASES: usize = 10_000;

/// xorshift64* PRNG. Never seeded with 0.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        // splitmix64 the seed so nearby seeds give unrelated streams.
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        Self(if z == 0 { 0x2545_F491_4F6C_DD1D } else { z })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform-ish in `0..n` (`n > 0`).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// True with probability `num / den`.
    pub fn chance(&mut self, num: u32, den: u32) -> bool {
        (self.next_u64() % u64::from(den)) < u64::from(num)
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    /// Small lengths are much more likely than large ones.
    pub fn size(&mut self, max: usize) -> usize {
        match self.below(4) {
            0 => self.below(8.min(max) + 1),
            1 => self.below(64.min(max) + 1),
            _ => self.below(max + 1),
        }
    }
}

/// Characters that break naive text handling: multi-byte scripts, emoji
/// (including ZWJ sequences and flags), combining marks, characters whose
/// lowercase has a different UTF-8 length, digits from other scripts,
/// separators, controls and BOMs.
pub const HOSTILE_CHARS: &[&str] = &[
    "ب",
    "ع",
    "ر",
    "ي",
    "٠",
    "٥",
    "٩",
    "۱",
    "中",
    "文",
    "日",
    "本",
    "語",
    "한",
    "国",
    "😀",
    "🙂",
    "👨\u{200d}👩\u{200d}👧",
    "🇬🇧",
    "\u{301}",
    "\u{308}",
    "\u{20dd}",
    "e\u{301}",
    "İ",
    "ẞ",
    "Ⱥ",
    "Σ",
    "ﬃ",
    "ß",
    "é",
    "ü",
    "ñ",
    "ø",
    "Ω",
    "\u{200b}",
    "\u{200e}",
    "\u{202e}",
    "\u{feff}",
    "\u{a0}",
    "\u{2028}",
    "\u{0}",
    "\u{1}",
    "\u{7f}",
    "\u{85}",
    "\u{fffd}",
    "\u{10ffff}",
    "\t",
    "\r",
    "\n",
    "\r\n",
    " ",
    "  ",
    "\"",
    "'",
    "<",
    ">",
    "&",
    ";",
    ":",
    ",",
    "=",
    "/",
    "\\",
    "?",
    "#",
    "%",
    "%00",
    "%zz",
    "+",
    "-",
    ".",
    "0",
    "1",
    "9",
    "a",
    "Z",
];

/// Random string of up to `max_chars` items drawn from ASCII and
/// [`HOSTILE_CHARS`].
pub fn random_utf8(rng: &mut Rng, max_chars: usize) -> String {
    let n = rng.size(max_chars);
    let mut s = String::new();
    for _ in 0..n {
        match rng.below(4) {
            0 => s.push((b' ' + rng.below(95) as u8) as char),
            1 => s.push(char::from_u32(rng.below(0x11_0000) as u32).unwrap_or('?')),
            _ => s.push_str(rng.pick(HOSTILE_CHARS)),
        }
    }
    s
}

/// Random string mixing `dict` tokens (domain keywords) with hostile text.
pub fn random_tokens(rng: &mut Rng, dict: &[&str], max_tokens: usize) -> String {
    let n = rng.size(max_tokens);
    let mut s = String::new();
    for _ in 0..n {
        if rng.chance(2, 3) && !dict.is_empty() {
            s.push_str(rng.pick(dict));
        } else {
            s.push_str(&random_utf8(rng, 6));
        }
    }
    s
}

pub fn random_bytes(rng: &mut Rng, max_len: usize) -> Vec<u8> {
    let n = rng.size(max_len);
    (0..n).map(|_| rng.next_u64() as u8).collect()
}

/// Numbers that overflow, truncate or confuse parsers, as text.
pub const INTERESTING_NUMBERS: &[&str] = &[
    "0",
    "-0",
    "1",
    "-1",
    "2",
    "23",
    "24",
    "59",
    "60",
    "99",
    "100",
    "255",
    "256",
    "1000",
    "1900",
    "2100",
    "9999",
    "65535",
    "65536",
    "2147483647",
    "2147483648",
    "-2147483649",
    "4294967296",
    "1700000000",
    "1700000000000",
    "100000000000",
    "253402300799",
    "9223372036854775807",
    "-9223372036854775808",
    "9223372036854775808",
    "18446744073709551616",
    "153722867280912930",
    "384307168202282325",
    "99999999999999999999",
    "1e308",
    "1e309",
    "-1e309",
    "NaN",
    "nan",
    "inf",
    "-inf",
    "Infinity",
    "1.5",
    "0.5",
    "-0.5",
    "7,5",
    "1_000",
    "0x10",
    "+5",
    "١٢",
    "",
];

/// One mutation step on `buf`, using `dict` for token insertions.
fn mutate_once(rng: &mut Rng, buf: &mut Vec<u8>, dict: &[&str]) {
    let len = buf.len();
    match rng.below(10) {
        // Truncate.
        0 if len > 0 => buf.truncate(rng.below(len + 1)),
        // Flip / overwrite a byte.
        1 if len > 0 => {
            let i = rng.below(len);
            buf[i] = match rng.below(3) {
                0 => buf[i] ^ (1 << rng.below(8)),
                1 => rng.next_u64() as u8,
                _ => *rng.pick(&[
                    0u8, b'"', b'<', b'>', b'&', b'\n', b'-', b'9', 0x80, 0xc3, 0xff,
                ]),
            };
        }
        // Delete a range.
        2 if len > 0 => {
            let a = rng.below(len);
            let b = (a + rng.size(64)).min(len);
            buf.drain(a..b);
        }
        // Duplicate a range in place.
        3 if len > 0 => {
            let a = rng.below(len);
            let b = (a + rng.size(256)).min(len);
            let piece = buf[a..b].to_vec();
            let at = rng.below(buf.len() + 1);
            buf.splice(at..at, piece);
        }
        // Insert a domain token.
        4 | 5 if !dict.is_empty() => {
            let at = rng.below(len + 1);
            let tok = rng.pick(dict).as_bytes().to_vec();
            buf.splice(at..at, tok);
        }
        // Insert hostile text.
        6 => {
            let at = rng.below(len + 1);
            let s = random_utf8(rng, 8).into_bytes();
            buf.splice(at..at, s);
        }
        // Insert an interesting number.
        7 => {
            let at = rng.below(len + 1);
            let s = rng.pick(INTERESTING_NUMBERS).as_bytes().to_vec();
            buf.splice(at..at, s);
        }
        // Insert raw bytes (invalid UTF-8 likely).
        8 => {
            let at = rng.below(len + 1);
            let s = random_bytes(rng, 8);
            buf.splice(at..at, s);
        }
        // Cut inside a multi-byte character, if there is one.
        _ => {
            if let Some(i) = buf.iter().position(|&b| b >= 0x80) {
                let skip = rng.below(4);
                buf.truncate((i + skip).min(buf.len()));
            } else if len > 0 {
                buf.truncate(rng.below(len));
            }
        }
    }
}

/// `seed` with 1 to 8 random mutations applied.
pub fn mutate(rng: &mut Rng, seed: &[u8], dict: &[&str]) -> Vec<u8> {
    let mut buf = seed.to_vec();
    for _ in 0..=rng.below(8) {
        mutate_once(rng, &mut buf, dict);
    }
    buf
}

/// A random window of `seed` (a slice starting and ending anywhere), so large
/// fixtures yield small, varied inputs.
pub fn window(rng: &mut Rng, seed: &[u8], max_len: usize) -> Vec<u8> {
    if seed.is_empty() {
        return Vec::new();
    }
    let a = rng.below(seed.len());
    let b = (a + rng.size(max_len)).min(seed.len());
    seed[a..b].to_vec()
}

/// One input in the usual mix: random bytes, random UTF-8, dictionary text,
/// whole-fixture mutations and truncations, and windows of fixtures.
pub fn mixed_input(rng: &mut Rng, seeds: &[Vec<u8>], dict: &[&str], max_len: usize) -> Vec<u8> {
    let seed = if seeds.is_empty() {
        &[][..]
    } else {
        &seeds[rng.below(seeds.len())][..]
    };
    match rng.below(20) {
        0..=2 => random_bytes(rng, max_len),
        3..=5 => random_utf8(rng, max_len / 4).into_bytes(),
        6..=8 => random_tokens(rng, dict, max_len / 8).into_bytes(),
        9 => seed[..rng.below(seed.len() + 1)].to_vec(),
        10..=12 => {
            let w = window(rng, seed, max_len);
            mutate(rng, &w, dict)
        }
        _ => {
            // Mutate a bounded prefix so huge fixtures stay fast.
            let end = seed.len().min(max_len);
            mutate(rng, &seed[..end], dict)
        }
    }
}

/// A random JSON value. Objects draw their keys from `keys`, so the mapping
/// code sees its real field names with hostile values.
pub fn random_json(rng: &mut Rng, keys: &[&str], depth: usize) -> Value {
    let leaf = |rng: &mut Rng| -> Value {
        match rng.below(10) {
            0 => Value::Null,
            1 => json!(rng.chance(1, 2)),
            2 => {
                let n = *rng.pick(&[
                    i64::MAX,
                    i64::MIN,
                    i64::MAX / 24,
                    i64::MAX / 60 + 1,
                    i64::MAX / 3600 + 1,
                    -1,
                    0,
                    1,
                    24,
                    1_700_000_000,
                    1_700_000_000_000,
                    253_402_300_800,
                ]);
                json!(n)
            }
            3 => json!(rng.next_u64()),
            4 => {
                let f = *rng.pick(&[1e308, -1e308, 0.5, 7.25, -0.0, 1e-300, 9.3e18, 4.0e15]);
                json!(f)
            }
            5 | 6 => json!(rng.pick(INTERESTING_NUMBERS).to_string()),
            _ => json!(random_utf8(rng, 24)),
        }
    };
    if depth == 0 {
        return leaf(rng);
    }
    match rng.below(6) {
        0 => {
            let n = rng.size(6);
            Value::Array((0..n).map(|_| random_json(rng, keys, depth - 1)).collect())
        }
        1..=3 => {
            let n = rng.size(12);
            let mut m = Map::new();
            for _ in 0..n {
                let k = if rng.chance(9, 10) && !keys.is_empty() {
                    rng.pick(keys).to_string()
                } else {
                    random_utf8(rng, 6)
                };
                m.insert(k, random_json(rng, keys, depth - 1));
            }
            Value::Object(m)
        }
        _ => leaf(rng),
    }
}

/// An object whose keys are all from `keys` (each present with probability
/// 2/3), values random. The shape most mapping code expects.
pub fn random_record(rng: &mut Rng, keys: &[&str]) -> Value {
    let mut m = Map::new();
    for k in keys {
        if rng.chance(2, 3) {
            m.insert((*k).to_string(), random_json(rng, keys, 1));
        }
    }
    Value::Object(m)
}

/// Base seed: `FUZZ_SEED` or `default`.
pub fn base_seed(default: u64) -> u64 {
    std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(default)
}

/// Cases per entry point: `FUZZ_CASES` or [`DEFAULT_CASES`].
pub fn cases() -> usize {
    std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(DEFAULT_CASES)
}

fn show(input: &[u8]) -> String {
    const MAX: usize = 2048;
    let shown = &input[..input.len().min(MAX)];
    let text = match std::str::from_utf8(shown) {
        Ok(s) => format!("{s:?}"),
        Err(_) => format!("bytes {shown:?}"),
    };
    if input.len() > MAX {
        format!("{text} ... ({} bytes total)", input.len())
    } else {
        text
    }
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic".into())
}

/// Runs `check` on [`cases`] inputs from `generate`. Each case gets its own
/// seed (`base ^ index`, splitmixed), so a failure is replayable with
/// `FUZZ_SEED=<printed seed> FUZZ_CASES=1`. Panics after the run when any
/// input panicked, listing up to five of them.
pub fn run(
    name: &str,
    default_seed: u64,
    mut generate: impl FnMut(&mut Rng) -> Vec<u8>,
    mut check: impl FnMut(&[u8]),
) {
    let base = base_seed(default_seed);
    let n = cases();
    let mut failures: Vec<String> = Vec::new();
    let mut failed = 0usize;
    for i in 0..n {
        let case_seed = base ^ (i as u64);
        let mut rng = Rng::new(case_seed);
        let input = generate(&mut rng);
        if let Err(p) = catch_unwind(AssertUnwindSafe(|| check(&input))) {
            failed += 1;
            if failures.len() < 5 {
                failures.push(format!(
                    "[{name}] case {i}: FUZZ_SEED={case_seed} FUZZ_CASES=1\n  panic: {}\n  input: {}",
                    panic_text(&*p),
                    show(&input)
                ));
            }
        }
    }
    if failed > 0 {
        panic!(
            "{failed} of {n} inputs panicked in {name}:\n{}",
            failures.join("\n")
        );
    }
}
