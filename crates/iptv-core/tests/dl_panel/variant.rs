//! Copies of a file on other panels: byte-identical, different everywhere, or
//! different only where a fingerprint does not look (the planted mismatch
//! that only the engine's overlap checks can catch).

use super::content;

/// Length of one fingerprint sample window.
pub const SAMPLE_LEN: u64 = 64 * 1024;

/// What a panel's copy of a file holds, against the canonical [`content`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Variant {
    /// Byte-identical to the canonical file.
    #[default]
    Same,
    /// The same size, every byte different (another encode).
    Differs,
    /// Canonical inside the three [`sample_offsets`] windows, different
    /// everywhere else: passes fingerprint verification, fails any overlap
    /// check outside the windows.
    DiffersOutsideSamples,
}

/// XORed into a byte that differs: never 0, so every such byte changes.
const FLIP: u8 = 0xA5;

/// Start of each fingerprint window of a `total`-byte file:
/// `[0, align_down(total/2, SAMPLE_LEN), total - SAMPLE_LEN]`.
///
/// Mirrors `iptv_core::downloads::shared::sample_offsets` (written in
/// parallel; this panel cannot import it yet). Keep the two in step. Small
/// files saturate at 0 instead of failing.
pub fn sample_offsets(total: u64) -> [u64; 3] {
    [
        0,
        total / 2 / SAMPLE_LEN * SAMPLE_LEN,
        total.saturating_sub(SAMPLE_LEN),
    ]
}

/// The sample windows as sorted, merged `[start, end)` ranges inside the file.
fn windows(total: u64) -> Vec<(u64, u64)> {
    let mut ws: Vec<(u64, u64)> = sample_offsets(total)
        .iter()
        .map(|&o| (o, (o + SAMPLE_LEN).min(total)))
        .filter(|(a, b)| a < b)
        .collect();
    ws.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(3);
    for (a, b) in ws {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    merged
}

/// Whether byte `at` of a `total`-byte file lies inside a sample window.
pub fn inside_samples(total: u64, at: u64) -> bool {
    windows(total).iter().any(|&(a, b)| (a..b).contains(&at))
}

/// `len` bytes from `offset` of `variant`'s copy of file `file`, which is
/// `total` bytes long (the windows depend on it).
pub fn variant_content(
    file: u32,
    variant: Variant,
    total: u64,
    offset: u64,
    len: usize,
) -> Vec<u8> {
    let mut out = content(file, offset, len);
    let end = offset + len as u64;
    let mut flip = |from: u64, to: u64| {
        let (from, to) = (from.max(offset), to.min(end));
        if from < to {
            let range = (from - offset) as usize..(to - offset) as usize;
            out[range].iter_mut().for_each(|b| *b ^= FLIP);
        }
    };
    match variant {
        Variant::Same => {}
        Variant::Differs => flip(offset, end),
        Variant::DiffersOutsideSamples => {
            let mut cursor = offset;
            for (a, b) in windows(total) {
                flip(cursor, a);
                cursor = cursor.max(b);
            }
            flip(cursor, end);
        }
    }
    out
}
