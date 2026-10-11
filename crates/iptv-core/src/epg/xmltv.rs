//! Streaming XMLTV parser (SPEC C4 epg).
//!
//! Reads `<channel>` and `<programme>` elements from any [`BufRead`] with
//! quick-xml, one event at a time, reusing a single buffer, so memory stays
//! flat no matter how large the feed is or whether it has line breaks at all.
//!
//! Tolerated in the wild:
//! - entities: the five XML ones, numeric `&#..;` / `&#x..;`, common HTML
//!   names (`&nbsp;`, `&eacute;`, ...), and bare `&` (kept literally);
//! - `<![CDATA[...]]>` text;
//! - ISO-8859-1 / Windows-1252 feeds (declared in `<?xml encoding=...?>`);
//! - dates `YYYYMMDD[HH[mm[ss]]]` with an optional `±HHMM`, `±HH:MM`, `±HH`,
//!   `Z`, `UTC` or `GMT` offset, plus RFC 3339 as a fallback;
//! - programmes without `stop`: the stop is inferred from the next programme
//!   on the same channel, or start + 1 h when none follows;
//! - mismatched end tags and a truncated tail (data read so far is kept).
//!
//! Only the first non-empty `display-name` / `icon` of a channel and the first
//! non-empty `title` / `desc` / `category` / `icon` of a programme are kept,
//! whatever their `lang`.

use crate::error::{CoreError, CoreResult};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::BufRead;

/// Seconds in a day.
pub const DAY: i64 = 86_400;
/// Programmes whose stop is older than this many seconds before now are skipped.
pub const KEEP_PAST_SECS: i64 = 2 * DAY;
/// Programmes starting later than this many seconds after now are skipped.
pub const KEEP_FUTURE_SECS: i64 = 14 * DAY;
/// Duration given to a programme without `stop` when no later programme follows.
pub const DEFAULT_DURATION_SECS: i64 = 3_600;

const MAX_TITLE_CHARS: usize = 512;
const MAX_DESC_CHARS: usize = 8_192;
const MAX_SHORT_CHARS: usize = 1_024;
/// The read buffer is shrunk back when one event (a giant text node) grew it past this.
const BUF_SHRINK_ABOVE: usize = 1 << 20;

/// A `<channel>` element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmltvChannel {
    pub id: String,
    /// First non-empty `display-name`, or the id when there is none.
    pub display_name: String,
    pub icon: Option<String>,
}

/// A `<programme>` element. Times are unix seconds (UTC).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmltvProgramme {
    pub channel: String,
    pub start: i64,
    pub stop: i64,
    pub title: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub icon: Option<String>,
}

/// One parsed element handed to the sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XmltvItem {
    Channel(XmltvChannel),
    Programme(XmltvProgramme),
}

/// Time window of programmes to keep (unix seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    /// Programmes with `stop <= min_stop` are skipped.
    pub min_stop: i64,
    /// Programmes with `start > max_start` are skipped.
    pub max_start: i64,
}

impl Window {
    /// The ingestion window: 2 days back, 14 days ahead of `now`.
    pub fn around(now: i64) -> Self {
        Self {
            min_stop: now - KEEP_PAST_SECS,
            max_start: now + KEEP_FUTURE_SECS,
        }
    }

    /// Keeps everything.
    pub fn unbounded() -> Self {
        Self {
            min_stop: i64::MIN,
            max_start: i64::MAX,
        }
    }

    fn contains(&self, start: i64, stop: i64) -> bool {
        stop > self.min_stop && start <= self.max_start
    }
}

/// Counters reported by [`parse`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParseStats {
    /// Channels handed to the sink.
    pub channels: u64,
    /// Programmes handed to the sink.
    pub programmes: u64,
    /// Programmes outside the window.
    pub skipped_window: u64,
    /// Programmes without a channel, with an unparseable start, or with stop <= start.
    pub skipped_invalid: u64,
    /// Programmes whose stop was inferred.
    pub inferred_stop: u64,
    /// Set when the document ended with an XML error after some data was read.
    pub truncated: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    DisplayName,
    Title,
    Desc,
    Category,
}

impl Field {
    fn tag(self) -> &'static [u8] {
        match self {
            Field::DisplayName => b"display-name",
            Field::Title => b"title",
            Field::Desc => b"desc",
            Field::Category => b"category",
        }
    }
    fn max_chars(self) -> usize {
        match self {
            Field::Title => MAX_TITLE_CHARS,
            Field::Desc => MAX_DESC_CHARS,
            Field::DisplayName | Field::Category => MAX_SHORT_CHARS,
        }
    }
}

#[derive(Default)]
struct ChannelBuilder {
    id: String,
    display_name: Option<String>,
    icon: Option<String>,
}

#[derive(Default)]
struct ProgrammeBuilder {
    channel: String,
    start: Option<i64>,
    stop: Option<i64>,
    title: Option<String>,
    desc: Option<String>,
    category: Option<String>,
    icon: Option<String>,
}

enum Ctx {
    None,
    Channel(ChannelBuilder),
    Programme(ProgrammeBuilder),
}

struct Capture {
    field: Field,
    text: String,
    chars: usize,
    full: bool,
}

impl Capture {
    fn push(&mut self, s: &str) {
        if self.full {
            return;
        }
        let max = self.field.max_chars();
        for ch in s.chars() {
            if self.chars >= max {
                self.full = true;
                return;
            }
            self.text.push(ch);
            self.chars += 1;
        }
    }
}

struct Parser<'s> {
    window: Window,
    latin1: bool,
    ctx: Ctx,
    capture: Option<Capture>,
    pending: HashMap<String, XmltvProgramme>,
    stats: ParseStats,
    saw_tv: bool,
    sink: &'s mut dyn FnMut(XmltvItem) -> CoreResult<()>,
}

/// Parses an XMLTV document, calling `sink` for every channel and every
/// programme inside `window`. The sink may return an error to abort.
///
/// Errors: `Invalid` when the input is not XMLTV or holds neither channels nor
/// programmes; whatever the sink or the reader returns. An XML syntax error
/// after at least one channel or programme was read ends parsing early and is
/// reported in [`ParseStats::truncated`] instead.
pub fn parse<R: BufRead>(
    reader: R,
    window: Window,
    sink: &mut dyn FnMut(XmltvItem) -> CoreResult<()>,
) -> CoreResult<ParseStats> {
    let mut xml = Reader::from_reader(reader);
    {
        let cfg = xml.config_mut();
        cfg.trim_text(false);
        cfg.check_end_names = false;
        cfg.expand_empty_elements = false;
        cfg.check_comments = false;
    }
    let mut p = Parser {
        window,
        latin1: false,
        ctx: Ctx::None,
        capture: None,
        pending: HashMap::new(),
        stats: ParseStats::default(),
        saw_tv: false,
        sink,
    };
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    loop {
        let event = match xml.read_event_into(&mut buf) {
            Ok(ev) => ev,
            Err(err) => {
                let pos = xml.buffer_position();
                if p.stats.channels + p.stats.programmes + p.stats.skipped_window > 0 {
                    let msg = format!("XMLTV ended early at byte {pos}: {err}");
                    tracing::warn!(%msg, "keeping data parsed before the error");
                    p.stats.truncated = Some(msg);
                    break;
                }
                if let quick_xml::Error::Io(io) = &err {
                    return Err(CoreError::Io(std::io::Error::new(
                        io.kind(),
                        io.to_string(),
                    )));
                }
                return Err(CoreError::Invalid(format!(
                    "not a valid XMLTV document (byte {pos}): {err}"
                )));
            }
        };
        match event {
            Event::Eof => break,
            Event::Decl(d) => {
                if let Some(Ok(enc)) = d.encoding() {
                    let enc = String::from_utf8_lossy(&enc).to_ascii_lowercase();
                    p.latin1 = matches!(
                        enc.as_str(),
                        "iso-8859-1"
                            | "iso8859-1"
                            | "latin1"
                            | "latin-1"
                            | "iso-8859-15"
                            | "windows-1252"
                            | "cp1252"
                    );
                }
            }
            Event::Start(e) => p.on_start(&e, false)?,
            Event::Empty(e) => p.on_start(&e, true)?,
            Event::End(e) => {
                let name = e.local_name();
                p.on_end(name.as_ref())?;
            }
            Event::Text(t) => {
                if let Some(cap) = p.capture.as_mut() {
                    let decoded = decode(&t, p.latin1);
                    cap.push(&unescape_lenient(&decoded));
                }
            }
            Event::CData(t) => {
                if let Some(cap) = p.capture.as_mut() {
                    cap.push(&decode(&t, p.latin1));
                }
            }
            _ => {}
        }
        if buf.capacity() > BUF_SHRINK_ABOVE {
            buf = Vec::with_capacity(64 * 1024);
        } else {
            buf.clear();
        }
    }
    // A programme still open at EOF (truncated file) is finished with what it has.
    if let Ctx::Programme(_) = p.ctx {
        p.on_end(b"programme")?;
    }
    p.flush_pending()?;
    if p.stats.channels == 0 && p.stats.programmes == 0 && p.stats.skipped_window == 0 {
        return Err(CoreError::Invalid(if p.saw_tv {
            "the XMLTV feed contains no channels or programmes".into()
        } else {
            "not an XMLTV document (no <tv> element found)".into()
        }));
    }
    Ok(p.stats)
}

impl Parser<'_> {
    fn attr(&self, e: &BytesStart<'_>, key: &[u8]) -> Option<String> {
        for a in e.attributes().with_checks(false).flatten() {
            if a.key.local_name().as_ref() == key {
                let v = decode(&a.value, self.latin1);
                let v = unescape_lenient(&v);
                let v = v.trim();
                return if v.is_empty() {
                    None
                } else {
                    Some(v.to_string())
                };
            }
        }
        None
    }

    fn on_start(&mut self, e: &BytesStart<'_>, empty: bool) -> CoreResult<()> {
        let name = e.local_name();
        let name = name.as_ref();
        match name {
            b"tv" => self.saw_tv = true,
            b"channel" => {
                self.capture = None;
                let cb = ChannelBuilder {
                    id: self.attr(e, b"id").unwrap_or_default(),
                    ..Default::default()
                };
                self.ctx = Ctx::Channel(cb);
                if empty {
                    self.on_end(b"channel")?;
                }
            }
            b"programme" => {
                self.capture = None;
                let pb = ProgrammeBuilder {
                    channel: self.attr(e, b"channel").unwrap_or_default(),
                    start: self.attr(e, b"start").as_deref().and_then(parse_xmltv_date),
                    stop: self.attr(e, b"stop").as_deref().and_then(parse_xmltv_date),
                    ..Default::default()
                };
                self.ctx = Ctx::Programme(pb);
                if empty {
                    self.on_end(b"programme")?;
                }
            }
            b"icon" => {
                let src = self.attr(e, b"src");
                match &mut self.ctx {
                    Ctx::Channel(c) if c.icon.is_none() => c.icon = src,
                    Ctx::Programme(p) if p.icon.is_none() => p.icon = src,
                    _ => {}
                }
            }
            _ if !empty && self.capture.is_none() => {
                let field = match (&self.ctx, name) {
                    (Ctx::Channel(c), b"display-name") if c.display_name.is_none() => {
                        Some(Field::DisplayName)
                    }
                    (Ctx::Programme(p), b"title") if p.title.is_none() => Some(Field::Title),
                    (Ctx::Programme(p), b"desc") if p.desc.is_none() => Some(Field::Desc),
                    (Ctx::Programme(p), b"category") if p.category.is_none() => {
                        Some(Field::Category)
                    }
                    _ => None,
                };
                if let Some(field) = field {
                    self.capture = Some(Capture {
                        field,
                        text: String::new(),
                        chars: 0,
                        full: false,
                    });
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn on_end(&mut self, name: &[u8]) -> CoreResult<()> {
        if let Some(cap) = &self.capture {
            if cap.field.tag() == name {
                let cap = self.capture.take().expect("checked above");
                let value = collapse(&cap.text);
                if !value.is_empty() {
                    match (&mut self.ctx, cap.field) {
                        (Ctx::Channel(c), Field::DisplayName) => c.display_name = Some(value),
                        (Ctx::Programme(p), Field::Title) => p.title = Some(value),
                        (Ctx::Programme(p), Field::Desc) => p.desc = Some(value),
                        (Ctx::Programme(p), Field::Category) => p.category = Some(value),
                        _ => {}
                    }
                }
                return Ok(());
            }
        }
        match name {
            b"channel" => {
                if let Ctx::Channel(c) = std::mem::replace(&mut self.ctx, Ctx::None) {
                    self.capture = None;
                    if !c.id.is_empty() {
                        let display_name = c.display_name.unwrap_or_else(|| c.id.clone());
                        self.stats.channels += 1;
                        (self.sink)(XmltvItem::Channel(XmltvChannel {
                            id: c.id,
                            display_name,
                            icon: c.icon,
                        }))?;
                    }
                }
            }
            b"programme" => {
                if let Ctx::Programme(p) = std::mem::replace(&mut self.ctx, Ctx::None) {
                    self.capture = None;
                    self.finish_programme(p)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn finish_programme(&mut self, p: ProgrammeBuilder) -> CoreResult<()> {
        let (Some(start), false) = (p.start, p.channel.is_empty()) else {
            self.stats.skipped_invalid += 1;
            return Ok(());
        };
        if !self.pending.is_empty() {
            if let Some(mut prev) = self.pending.remove(&p.channel) {
                prev.stop = if prev.start < start {
                    start
                } else {
                    prev.start + DEFAULT_DURATION_SECS
                };
                self.stats.inferred_stop += 1;
                self.emit(prev)?;
            }
        }
        let prog = XmltvProgramme {
            channel: p.channel,
            start,
            stop: p.stop.unwrap_or(start),
            title: p.title.unwrap_or_default(),
            description: p.desc,
            category: p.category,
            icon: p.icon,
        };
        match p.stop {
            None => {
                self.pending.insert(prog.channel.clone(), prog);
                Ok(())
            }
            Some(stop) if stop > start => self.emit(prog),
            Some(_) => {
                self.stats.skipped_invalid += 1;
                Ok(())
            }
        }
    }

    fn flush_pending(&mut self) -> CoreResult<()> {
        let mut rest: Vec<_> = self.pending.drain().map(|(_, p)| p).collect();
        rest.sort_by(|a, b| a.channel.cmp(&b.channel).then(a.start.cmp(&b.start)));
        for mut p in rest {
            p.stop = p.start + DEFAULT_DURATION_SECS;
            self.stats.inferred_stop += 1;
            self.emit(p)?;
        }
        Ok(())
    }

    fn emit(&mut self, p: XmltvProgramme) -> CoreResult<()> {
        if !self.window.contains(p.start, p.stop) {
            self.stats.skipped_window += 1;
            return Ok(());
        }
        self.stats.programmes += 1;
        (self.sink)(XmltvItem::Programme(p))
    }
}

/// Trims and collapses internal runs of whitespace (newlines, tabs) to one space.
fn collapse(s: &str) -> String {
    let t = s.trim();
    if !t.contains(|c: char| c.is_whitespace() && c != ' ') && !t.contains("  ") {
        return t.to_string();
    }
    let mut out = String::with_capacity(t.len());
    let mut space = false;
    for ch in t.chars() {
        if ch.is_whitespace() {
            if !space {
                out.push(' ');
                space = true;
            }
        } else {
            out.push(ch);
            space = false;
        }
    }
    out
}

/// Bytes to text: Latin-1 maps each byte to the same code point; otherwise
/// UTF-8 with replacement characters for invalid sequences.
fn decode(bytes: &[u8], latin1: bool) -> Cow<'_, str> {
    if latin1 && !bytes.is_ascii() {
        Cow::Owned(bytes.iter().map(|&b| b as char).collect())
    } else {
        String::from_utf8_lossy(bytes)
    }
}

/// Resolves XML / numeric / common HTML entities. Unknown or malformed
/// references (a bare `&` in "Tom & Jerry") are kept literally.
pub fn unescape_lenient(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let resolved = tail[1..]
            .find(';')
            .filter(|&end| end > 0 && end <= 32)
            .and_then(|end| resolve_entity(&tail[1..1 + end]).map(|c| (c, end + 2)));
        match resolved {
            Some((text, consumed)) => {
                out.push_str(&text);
                rest = &tail[consumed..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn resolve_entity(name: &str) -> Option<Cow<'static, str>> {
    if let Some(num) = name.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        let ch = char::from_u32(code).filter(|&c| c != '\0')?;
        return Some(Cow::Owned(ch.to_string()));
    }
    let s: &'static str = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "copy" => "\u{a9}",
        "reg" => "\u{ae}",
        "trade" => "\u{2122}",
        "hellip" => "\u{2026}",
        "ndash" => "\u{2013}",
        "mdash" => "\u{2014}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "laquo" => "\u{ab}",
        "raquo" => "\u{bb}",
        "euro" => "\u{20ac}",
        "pound" => "\u{a3}",
        "deg" => "\u{b0}",
        "middot" => "\u{b7}",
        "bull" => "\u{2022}",
        "eacute" => "\u{e9}",
        "egrave" => "\u{e8}",
        "ecirc" => "\u{ea}",
        "aacute" => "\u{e1}",
        "agrave" => "\u{e0}",
        "acirc" => "\u{e2}",
        "iacute" => "\u{ed}",
        "oacute" => "\u{f3}",
        "uacute" => "\u{fa}",
        "ccedil" => "\u{e7}",
        "ntilde" => "\u{f1}",
        "auml" => "\u{e4}",
        "ouml" => "\u{f6}",
        "uuml" => "\u{fc}",
        "Auml" => "\u{c4}",
        "Ouml" => "\u{d6}",
        "Uuml" => "\u{dc}",
        "szlig" => "\u{df}",
        "Eacute" => "\u{c9}",
        _ => return None,
    };
    Some(Cow::Borrowed(s))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

fn two(b: &[u8], i: usize) -> Option<i64> {
    let (a, c) = (*b.get(i)?, *b.get(i + 1)?);
    if a.is_ascii_digit() && c.is_ascii_digit() {
        Some(((a - b'0') * 10 + (c - b'0')) as i64)
    } else {
        None
    }
}

/// Parses an XMLTV timestamp to unix seconds (UTC).
///
/// Accepts `YYYYMMDD`, `YYYYMMDDHH`, `YYYYMMDDHHmm`, `YYYYMMDDHHmmss`
/// (missing parts are zero), optional spaces, then an optional offset
/// `±HHMM`, `±HH:MM`, `±HH`, `Z`, `UTC` or `GMT`. RFC 3339 strings are
/// accepted as a fallback. Returns `None` for anything else.
pub fn parse_xmltv_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if !matches!(digits, 8 | 10 | 12 | 14) {
        return parse_rfc3339(s);
    }
    let year = two(b, 0)? * 100 + two(b, 2)?;
    let month = two(b, 4)?;
    let day = two(b, 6)?;
    let hour = if digits >= 10 { two(b, 8)? } else { 0 };
    let minute = if digits >= 12 { two(b, 10)? } else { 0 };
    let second = if digits >= 14 { two(b, 12)?.min(59) } else { 0 };
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 24
        || minute > 59
    {
        return None;
    }
    let rest = s[digits..].trim_start();
    // Some feeds append fractional seconds (`20240101120000.000 +0000`).
    let rest = match rest.strip_prefix('.') {
        Some(r) => r
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .trim_start(),
        None => rest,
    };
    let offset = parse_offset(rest)?;
    Some(days_from_civil(year, month, day) * DAY + hour * 3600 + minute * 60 + second - offset)
}

/// Offset in seconds east of UTC.
fn parse_offset(rest: &str) -> Option<i64> {
    let r = rest.trim();
    if r.is_empty()
        || r.eq_ignore_ascii_case("z")
        || r.eq_ignore_ascii_case("utc")
        || r.eq_ignore_ascii_case("gmt")
    {
        return Some(0);
    }
    let r = r
        .strip_prefix("UTC")
        .or_else(|| r.strip_prefix("GMT"))
        .unwrap_or(r)
        .trim_start();
    let b = r.as_bytes();
    let sign = match b.first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hh = two(b, 1)?;
    let mm = match b.len() {
        3 => 0,
        5 => two(b, 3)?,
        6 if b[3] == b':' => two(b, 4)?,
        _ => return None,
    };
    if hh > 18 || mm > 59 {
        return None;
    }
    Some(sign * (hh * 3600 + mm * 60))
}

fn parse_rfc3339(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(xml: &str) -> (Vec<XmltvItem>, ParseStats) {
        let mut items = Vec::new();
        let stats = parse(xml.as_bytes(), Window::unbounded(), &mut |i| {
            items.push(i);
            Ok(())
        })
        .unwrap();
        (items, stats)
    }

    #[test]
    fn dates() {
        assert_eq!(parse_xmltv_date("19700101000000 +0000"), Some(0));
        assert_eq!(
            parse_xmltv_date("20240101120000 +0100"),
            Some(1_704_106_800)
        );
        assert_eq!(
            parse_xmltv_date("20240101120000 +01:00"),
            Some(1_704_106_800)
        );
        assert_eq!(parse_xmltv_date("20240101120000+0100"), Some(1_704_106_800));
        assert_eq!(parse_xmltv_date("20240101110000"), Some(1_704_106_800));
        assert_eq!(parse_xmltv_date("202401011100"), Some(1_704_106_800));
        assert_eq!(parse_xmltv_date("2024010111"), Some(1_704_106_800));
        assert_eq!(parse_xmltv_date("20240101"), Some(1_704_067_200));
        assert_eq!(
            parse_xmltv_date("20240101060000 -0500"),
            Some(1_704_106_800)
        );
        assert_eq!(
            parse_xmltv_date("20240101113000 +0030"),
            Some(1_704_106_800)
        );
        assert_eq!(parse_xmltv_date("20240101110000 Z"), Some(1_704_106_800));
        assert_eq!(parse_xmltv_date("20240101110000 GMT"), Some(1_704_106_800));
        assert_eq!(
            parse_xmltv_date("20240101110000.000 +0000"),
            Some(1_704_106_800)
        );
        assert_eq!(
            parse_xmltv_date("2024-01-01T12:00:00+01:00"),
            Some(1_704_106_800)
        );
        // Crossing the day boundary and leap day.
        assert_eq!(
            parse_xmltv_date("20240229003000 +0100"),
            Some(1_709_163_000)
        );
        assert_eq!(parse_xmltv_date("20230229000000"), None);
        assert_eq!(parse_xmltv_date("20241301000000"), None);
        assert_eq!(parse_xmltv_date(""), None);
        assert_eq!(parse_xmltv_date("tomorrow"), None);
        assert_eq!(parse_xmltv_date("20240101120000 +01x0"), None);
    }

    #[test]
    fn entities() {
        assert_eq!(unescape_lenient("Tom &amp; Jerry"), "Tom & Jerry");
        assert_eq!(unescape_lenient("Tom & Jerry"), "Tom & Jerry");
        assert_eq!(
            unescape_lenient("caf&eacute;&nbsp;&#233;&#xE9;"),
            "café\u{a0}éé"
        );
        assert_eq!(unescape_lenient("a &unknown; b"), "a &unknown; b");
        assert_eq!(unescape_lenient("&#0;"), "&#0;");
        assert_eq!(unescape_lenient("end &"), "end &");
    }

    #[test]
    fn first_of_each_and_cdata() {
        let xml = r#"<?xml version="1.0"?>
<tv><channel id="a"><display-name lang="fr">Chaîne A</display-name><display-name lang="en">Channel A</display-name>
<icon src="http://x/a.png"/><icon src="http://x/b.png"/></channel>
<programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="a">
<title lang="de">Erster</title><title lang="en">First</title>
<desc><![CDATA[Some <b>bold</b> & text]]></desc><category>News</category><category>Talk</category>
<icon src="http://x/p.png"/></programme></tv>"#;
        let (items, stats) = collect(xml);
        assert_eq!(stats.channels, 1);
        assert_eq!(stats.programmes, 1);
        assert_eq!(
            items[0],
            XmltvItem::Channel(XmltvChannel {
                id: "a".into(),
                display_name: "Chaîne A".into(),
                icon: Some("http://x/a.png".into())
            })
        );
        let XmltvItem::Programme(p) = &items[1] else {
            panic!()
        };
        assert_eq!(p.title, "Erster");
        assert_eq!(p.description.as_deref(), Some("Some <b>bold</b> & text"));
        assert_eq!(p.category.as_deref(), Some("News"));
        assert_eq!(p.icon.as_deref(), Some("http://x/p.png"));
        assert_eq!(p.stop - p.start, 3600);
    }

    #[test]
    fn missing_stop_is_inferred() {
        let xml = r#"<tv>
<programme start="20240101120000 +0000" channel="a"><title>One</title></programme>
<programme start="20240101120000 +0000" channel="b"><title>B</title></programme>
<programme start="20240101123000 +0000" channel="a"><title>Two</title></programme>
</tv>"#;
        let (items, stats) = collect(xml);
        let progs: Vec<_> = items
            .into_iter()
            .filter_map(|i| match i {
                XmltvItem::Programme(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(stats.inferred_stop, 3);
        let one = progs.iter().find(|p| p.title == "One").unwrap();
        assert_eq!(one.stop - one.start, 1800);
        let two = progs.iter().find(|p| p.title == "Two").unwrap();
        assert_eq!(two.stop - two.start, DEFAULT_DURATION_SECS);
        assert!(progs.iter().any(|p| p.title == "B"));
    }

    #[test]
    fn not_xmltv() {
        let err = parse(
            &b"<html><body>502</body></html>"[..],
            Window::unbounded(),
            &mut |_| Ok(()),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)));
        let err = parse(&b"<tv></tv>"[..], Window::unbounded(), &mut |_| Ok(())).unwrap_err();
        assert!(err.to_string().contains("no channels"));
    }
}
