//! Channel name matching for live failover (`live.alternates`).
//!
//! A channel's [`Signature`] is what stays of its name after the noise
//! providers add around it: a country or group tag ("UK: ", "FR|", "[DE] ",
//! the same rules as the UI's `stripCountryPrefix`), quality and codec markers
//! (HD, FHD, UHD, 4K, HEVC, 1080p, 50fps), and backup markers ("(backup)",
//! "BK 2"). Two names are the same channel when their keys are equal and
//! their region tags do not contradict each other. Numbers, "+1" timeshift
//! tags and "+" suffixes stay in the key, so "Sky Sports 1" and
//! "Sky Sports 2", "Film4" and "Film4 +1", "Canal" and "Canal+" stay apart.

use serde::{Deserialize, Serialize};

/// Picture quality named in a channel name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Sd,
    Hd,
    Fhd,
    Uhd,
}

/// The comparable form of a channel name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    /// Normalized words joined by one space ("sky sports 1"). Empty when the
    /// name has no letters or digits.
    pub key: String,
    /// The country tag that was stripped ("UK"), when it is a plain 2-3
    /// letter code. "GB" is reported as "UK".
    pub region: Option<String>,
    /// Highest quality marker in the name.
    pub quality: Option<Quality>,
    /// Timeshift tags ("+1", "+24") in name order.
    pub timeshift: Vec<String>,
}

impl Signature {
    /// Same channel by name: equal keys and no conflicting region tags.
    pub fn same_name(&self, other: &Signature) -> bool {
        !self.key.is_empty() && self.key == other.key && self.region_compatible(other)
    }

    /// Region tags agree, or at least one name has none.
    pub fn region_compatible(&self, other: &Signature) -> bool {
        match (&self.region, &other.region) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
    }

    /// The FTS5 phrase that finds every name with these words in this order
    /// (`"sky sports 1"`), or `None` when the key has no word characters.
    pub fn fts_phrase(&self) -> Option<String> {
        let words: Vec<&str> = self
            .key
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .take(16)
            .collect();
        (!words.is_empty()).then(|| format!("\"{}\"", words.join(" ")))
    }
}

/// The signature of a channel name.
pub fn signature(name: &str) -> Signature {
    let (rest, tag) = split_country_prefix(name);
    let mut quality = None;
    let mut region = None;
    if let Some(tag) = tag {
        let upper = tag.to_ascii_uppercase();
        if let Some(q) = quality_of(&upper.to_lowercase()) {
            quality = Some(q);
        } else {
            region = region_code(&upper);
        }
    }

    let folded = fold(&rest.to_lowercase())
        .replace("h.265", "h265")
        .replace("h.264", "h264");
    let raw = tokens(&folded);
    let mut kept: Vec<String> = Vec::with_capacity(raw.len());
    let mut timeshift = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let t = raw[i].as_str();
        if let Some(q) = quality_of(t) {
            quality = quality.max(Some(q));
            i += 1;
            continue;
        }
        if is_backup(t) {
            // "backup 2", "bk 1": the number belongs to the marker.
            let next_is_small_number = raw
                .get(i + 1)
                .is_some_and(|n| n.len() <= 2 && n.chars().all(|c| c.is_ascii_digit()));
            i += if next_is_small_number { 2 } else { 1 };
            continue;
        }
        if is_noise(t) {
            i += 1;
            continue;
        }
        if is_timeshift(t) {
            timeshift.push(t.to_string());
        }
        kept.push(t.to_string());
        i += 1;
    }
    // A name made only of markers ("HD") is its own key.
    if kept.is_empty() {
        kept = raw;
    }
    Signature {
        key: kept.join(" "),
        region,
        quality,
        timeshift,
    }
}

// ---------------------------------------------------------------------------
// Country / group tags (port of src/features/live/lib/channelName.ts)
// ---------------------------------------------------------------------------

const DASH_SEPARATORS: [&str; 3] = [" - ", "- ", " -"];
const COLON_SEPARATOR: &str = ": ";

fn tag_char(c: char) -> bool {
    c.is_ascii_uppercase() || c.is_ascii_digit() || c == '+'
}

/// A short code: `lo..=hi` chars of `[A-Z0-9+]`, at least one a letter.
fn code(s: &str, lo: usize, hi: usize) -> bool {
    (lo..=hi).contains(&s.len())
        && s.chars().all(tag_char)
        && s.chars().any(|c| c.is_ascii_uppercase())
}

/// `TAG_PREFIX_PATTERN`: a 2-3 char code, or a compound of 2-3 codes joined
/// by dashes ("4K-DE", "AR-SUBS"; first 2-5 chars, then 2-6).
fn tag_prefix(s: &str) -> bool {
    if code(s, 2, 3) {
        return true;
    }
    let parts: Vec<&str> = s.split('-').collect();
    (2..=3).contains(&parts.len())
        && code(parts[0], 2, 5)
        && parts[1..].iter().all(|p| code(p, 2, 6))
}

/// `BRACKET_TAG_PATTERN`: `[XX]` with 2-8 chars of `[A-Z0-9+-]` whose first
/// char that is not a digit or `+` is a letter. Returns the tag and the
/// length of the bracket plus the whitespace after it.
fn bracket_tag(s: &str) -> Option<(&str, usize)> {
    let inner = s.strip_prefix('[')?;
    let close = inner.find(']')?;
    let tag = &inner[..close];
    let ok_chars = tag.chars().all(|c| tag_char(c) || c == '-');
    let first_other = tag.chars().find(|c| !(c.is_ascii_digit() || *c == '+'));
    if !(2..=8).contains(&tag.len())
        || !ok_chars
        || !first_other.is_some_and(|c| c.is_ascii_uppercase())
    {
        return None;
    }
    let after = &inner[close + 1..];
    let ws = after.len() - after.trim_start().len();
    Some((tag, 1 + close + 1 + ws))
}

fn find_tag_separator(name: &str) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = name.find('|').map(|i| (i, 1));
    for sep in DASH_SEPARATORS
        .iter()
        .chain(std::iter::once(&COLON_SEPARATOR))
    {
        let Some(index) = name.find(sep) else {
            continue;
        };
        if best.is_some_and(|(b, _)| b <= index) {
            continue;
        }
        let prefix = name[..index].trim();
        let ok = if *sep == COLON_SEPARATOR {
            code(prefix, 2, 3)
        } else {
            tag_prefix(prefix)
        };
        if ok {
            best = Some((index, sep.len()));
        }
    }
    best
}

/// `stripCountryPrefix` plus the tag it removed (the last one, for nested
/// tags like "|DE| ARD").
pub fn split_country_prefix(name: &str) -> (&str, Option<&str>) {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return (trimmed, None);
    }
    if let Some((tag, len)) = bracket_tag(trimmed) {
        let rest = trimmed[len..].trim();
        return if rest.is_empty() {
            (trimmed, None)
        } else {
            (rest, Some(tag))
        };
    }
    let Some((index, len)) = find_tag_separator(trimmed) else {
        return (trimmed, None);
    };
    let prefix = trimmed[..index].trim();
    let stripped = trimmed[index + len..].trim();
    if stripped.is_empty() {
        return (trimmed, None);
    }
    if prefix.is_empty() {
        // A leading separator strips nothing by itself: retry on the rest.
        split_country_prefix(stripped)
    } else {
        (stripped, Some(prefix))
    }
}

/// A stripped tag as a country: any two letters, or a common three-letter
/// code, with aliases folded ("GB" and "GBR" are "UK", "GER" is "DE"). Group
/// tags such as "VIP" or "SPORTS" are no country.
fn region_code(tag: &str) -> Option<String> {
    if !tag.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let code = match tag {
        "GB" | "GBR" => "UK",
        "USA" => "US",
        "DEU" | "GER" => "DE",
        "FRA" => "FR",
        "ITA" => "IT",
        "ESP" => "ES",
        "POR" | "PRT" => "PT",
        "NLD" => "NL",
        "BEL" => "BE",
        "CAN" => "CA",
        "AUS" => "AU",
        "IRL" => "IE",
        "TUR" => "TR",
        "POL" => "PL",
        t if t.len() == 2 => t,
        _ => return None,
    };
    Some(code.to_string())
}

/// The UI's `stripCountryPrefix`.
pub fn strip_country_prefix(name: &str) -> &str {
    split_country_prefix(name).0
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/// Lowercase words. `+` stays part of a word ("canal+", "+1"); a lone `+`
/// joins the word before it ("Canal +" is "canal+").
fn tokens(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in s.split(|c: char| !(c.is_alphanumeric() || c == '+')) {
        if raw.is_empty() {
            continue;
        }
        if raw.chars().all(|c| c == '+') {
            if let Some(last) = out.last_mut() {
                last.push_str(raw);
            }
            continue;
        }
        out.push(raw.to_string());
    }
    out
}

fn quality_of(t: &str) -> Option<Quality> {
    Some(match t {
        "sd" | "lq" | "480p" | "576p" | "576i" | "480i" => Quality::Sd,
        "hd" | "hd+" | "hq" | "720p" | "720" | "ʜᴅ" | "ᴴᴰ" | "ʰᵈ" => Quality::Hd,
        "fhd" | "fullhd" | "1080p" | "1080i" | "1080" | "ꜰʜᴅ" | "ᶠᴴᴰ" => Quality::Fhd,
        "uhd" | "4k" | "8k" | "2160p" | "4320p" | "uhd4k" | "ᵁᴴᴰ" | "ᴜʜᴅ" => {
            Quality::Uhd
        }
        _ => return None,
    })
}

fn is_backup(t: &str) -> bool {
    let base = t.trim_end_matches(|c: char| c.is_ascii_digit());
    matches!(base, "backup" | "bkp" | "bk" | "alt" | "reserve" | "mirror")
}

fn is_noise(t: &str) -> bool {
    matches!(
        t,
        "hevc"
            | "h265"
            | "h264"
            | "x264"
            | "x265"
            | "avc"
            | "hdr"
            | "sdr"
            | "fps"
            | "25fps"
            | "30fps"
            | "50fps"
            | "60fps"
            | "raw"
    )
}

fn is_timeshift(t: &str) -> bool {
    t.strip_prefix('+')
        .is_some_and(|n| (1..=2).contains(&n.len()) && n.chars().all(|c| c.is_ascii_digit()))
}

/// Folds common Latin accents ("télé" is "tele"), as FTS5's unicode61
/// tokenizer does, so accented and plain spellings compare equal.
fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => out.push('a'),
            'ç' | 'ć' | 'č' => out.push('c'),
            'ď' | 'đ' => out.push('d'),
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => out.push('e'),
            'ğ' => out.push('g'),
            'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ı' | 'į' => out.push('i'),
            'ł' | 'ľ' => out.push('l'),
            'ñ' | 'ń' | 'ň' => out.push('n'),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => out.push('o'),
            'ř' => out.push('r'),
            'ś' | 'š' | 'ş' | 'ș' => out.push('s'),
            'ť' | 'ţ' | 'ț' => out.push('t'),
            'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => out.push('u'),
            'ý' | 'ÿ' => out.push('y'),
            'ź' | 'ż' | 'ž' => out.push('z'),
            'ß' => out.push_str("ss"),
            'æ' => out.push_str("ae"),
            'œ' => out.push_str("oe"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> String {
        signature(name).key
    }

    fn same(a: &str, b: &str) -> bool {
        signature(a).same_name(&signature(b))
    }

    /// Mirrors the cases in src/features/live/test (stripCountryPrefix).
    #[test]
    fn strips_country_prefixes_like_the_ui() {
        let cases = [
            ("US | CNN", "CNN"),
            ("FR|TF1", "TF1"),
            ("|DE| ARD", "ARD"),
            ("UK: BBC One", "BBC One"),
            ("[UK] BBC One", "BBC One"),
            ("4K-DE - Das Erste", "Das Erste"),
            ("AR-SUBS - Movie", "Movie"),
            ("UK - Sky News", "Sky News"),
            ("Sky - Sports F1", "Sky - Sports F1"),
            ("NCIS: LA", "NCIS: LA"),
            ("DUNE - Part Two", "DUNE - Part Two"),
            ("1917 - Something", "1917 - Something"),
            ("uk: lower", "uk: lower"),
            ("UK:", "UK:"),
            ("  BBC Two  ", "BBC Two"),
            ("", ""),
        ];
        for (input, want) in cases {
            assert_eq!(strip_country_prefix(input), want, "{input:?}");
        }
    }

    /// Hand-written table: every pair here is the same channel.
    #[test]
    fn matches_the_same_channel_through_provider_noise() {
        let pairs = [
            ("Sky Sports 1", "UK: Sky Sports 1 HD"),
            ("Sky Sports 1", "Sky Sports 1 FHD"),
            ("Sky Sports 1", "SKY SPORTS 1 (backup)"),
            ("Sky Sports 1", "[UK] Sky Sports 1 4K"),
            ("Sky Sports 1", "Sky Sports 1 HEVC"),
            ("Sky Sports 1", "Sky.Sports.1"),
            ("Sky Sports 1", "Sky Sports 1 ᴴᴰ"),
            ("Sky Sports 1", "Sky Sports 1 UHD 50fps"),
            ("Sky Sports 1", "Sky Sports 1 [FHD] (BK 2)"),
            ("Sky Sports 1", "Sky Sports 1 H.265"),
            ("CNN", "US | CNN HD"),
            ("CNN", "cnn"),
            ("Canal+", "Canal +"),
            ("Canal+ Sport", "FR: CANAL+ SPORT FHD"),
            ("Film4 +1", "UK: Film4 +1 HD"),
            ("TF1", "FR|TF1 1080p"),
            ("Télé 5", "TELE 5"),
            ("ProSieben", "DE: ProSieben HD backup2"),
            ("BBC One", "GB: BBC One"),
            ("BBC One", "UK: BBC One"),
            ("Das Erste", "4K-DE - Das Erste"),
            ("HD", "HD"),
        ];
        for (a, b) in pairs {
            assert!(
                same(a, b),
                "{a:?} vs {b:?}: {:?} / {:?}",
                signature(a),
                signature(b)
            );
            assert!(same(b, a), "not symmetric: {a:?} vs {b:?}");
        }
    }

    /// Hand-written table: every pair here is two different channels.
    #[test]
    fn keeps_distinct_channels_apart() {
        let pairs = [
            ("Sky Sports 1", "Sky Sports 2"),
            ("Sky Sports 1", "Sky Sports 1 +1"),
            ("Sky Sports", "Sky Sports 1"),
            ("Sky Sports F1", "Sky Sports Main Event"),
            ("Film4", "Film4 +1"),
            ("Canal", "Canal+"),
            ("Canal+", "Canal+ Sport"),
            ("BBC One", "BBC Two"),
            ("UK: Discovery", "DE: Discovery"),
            ("UK | CNN", "US | CNN"),
            ("ESPN", "ESPN 2"),
            ("Discovery (UK)", "Discovery"),
            ("Rai 1", "Rai 1 +24"),
            ("Eurosport 1", "Eurosport 2"),
            ("Nick Jr", "Nick"),
            ("", ""),
            ("!!!", "???"),
        ];
        for (a, b) in pairs {
            assert!(
                !same(a, b),
                "{a:?} vs {b:?} matched: {:?} / {:?}",
                signature(a),
                signature(b)
            );
        }
    }

    #[test]
    fn reads_quality_region_and_timeshift() {
        let s = signature("UK: Sky Sports 1 FHD");
        assert_eq!(s.key, "sky sports 1");
        assert_eq!(s.region.as_deref(), Some("UK"));
        assert_eq!(s.quality, Some(Quality::Fhd));
        assert!(s.timeshift.is_empty());

        let s = signature("4K | Sky Cinema");
        assert_eq!(s.quality, Some(Quality::Uhd));
        assert_eq!(s.region, None);

        // The highest marker wins.
        assert_eq!(signature("BBC One HD 4K").quality, Some(Quality::Uhd));
        assert_eq!(signature("BBC One SD").quality, Some(Quality::Sd));
        assert_eq!(signature("BBC One").quality, None);

        let s = signature("Film4 +1");
        assert_eq!(s.timeshift, vec!["+1".to_string()]);
        // A group tag that is not a country is no region.
        assert_eq!(signature("VIP | CNN").region, None);
        assert_eq!(signature("VIP | CNN").key, "cnn");
    }

    #[test]
    fn fts_phrase_uses_plain_words() {
        assert_eq!(
            signature("Sky Sports 1 HD").fts_phrase().as_deref(),
            Some("\"sky sports 1\"")
        );
        assert_eq!(
            signature("Canal+ Sport").fts_phrase().as_deref(),
            Some("\"canal sport\"")
        );
        assert_eq!(
            signature("Film4 +1").fts_phrase().as_deref(),
            Some("\"film4 1\"")
        );
        assert_eq!(signature("!!!").fts_phrase(), None);
        assert_eq!(key("A&E"), "a e");
    }
}
