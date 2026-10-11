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
//! - mismatched end tags, unclosed tags (`<br>` inside a description) and a
//!   truncated tail (data read so far is kept).
//!
//! Hostile input is bounded: the document stops with an `Invalid` error once
//! more than [`MAX_DOCUMENT_BYTES`] (decompressed) were read, a text, CDATA or
//! comment / processing-instruction node keeps only its first
//! [`MAX_NODE_BYTES`] (the rest is read and discarded), and a single tag
//! (quoted attribute values included) or DOCTYPE declaration larger than that
//! is an `Invalid` error. Element nesting is bounded too: once more than
//! [`MAX_OPEN_DEPTH`] elements (or [`MAX_OPEN_NAME_BYTES`] of their names)
//! are open, quick-xml's stack of open names is dropped, since the parser only
//! needs the names of the elements it is inside. Channel ids and programme
//! `channel` attributes longer than [`MAX_ID_BYTES`] skip the element, and
//! icon URLs longer than [`MAX_URL_BYTES`] are dropped. At most
//! [`MAX_PENDING`] stop-less programmes wait for their next programme; past
//! that the oldest gets the default duration.
//!
//! Only the first non-empty `display-name` / `icon` of a channel and the first
//! non-empty `title` / `desc` / `category` / `icon` of a programme are kept,
//! whatever their `lang`.

use crate::error::{CoreError, CoreResult};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read};

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
/// Largest decompressed document [`parse`] accepts.
pub const MAX_DOCUMENT_BYTES: u64 = 2 << 30;
/// Bytes of one text / CDATA / comment node handed to quick-xml; the rest of
/// the node is discarded. Also the largest tag accepted.
pub const MAX_NODE_BYTES: usize = 4 << 20;
/// Open elements beyond which quick-xml's stack of open names is dropped.
pub const MAX_OPEN_DEPTH: usize = 256;
/// Bytes of open element names beyond which quick-xml's stack is dropped.
pub const MAX_OPEN_NAME_BYTES: usize = 64 * 1024;
/// Longest channel id / programme `channel` attribute (and date) accepted;
/// an element with a longer one is skipped.
pub const MAX_ID_BYTES: usize = 1024;
/// Longest icon URL kept; a longer one is dropped.
pub const MAX_URL_BYTES: usize = 4096;
/// Stop-less programmes held while waiting for the next programme on their
/// channel; past this (or [`MAX_PENDING_BYTES`]) the oldest is finished with
/// [`DEFAULT_DURATION_SECS`].
pub const MAX_PENDING: usize = 100_000;
/// Approximate bytes of held stop-less programmes (see [`MAX_PENDING`]).
pub const MAX_PENDING_BYTES: usize = 64 << 20;

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
    /// Programmes without a channel, with an unparseable start, or with
    /// stop <= start; channels and programmes whose id is over [`MAX_ID_BYTES`].
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
    /// The id was longer than [`MAX_ID_BYTES`].
    bad_id: bool,
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
    /// Stop-less programmes by channel, with their sequence number.
    pending: HashMap<String, (u64, XmltvProgramme)>,
    /// (start, sequence) -> channel of every entry in `pending`, oldest first.
    pending_order: BTreeMap<(i64, u64), String>,
    pending_bytes: usize,
    pending_seq: u64,
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
    parse_with_limits(reader, window, MAX_DOCUMENT_BYTES, MAX_NODE_BYTES, sink)
}

/// [`parse`] with explicit size limits: `max_document` bytes read in total
/// (exceeding it is an `Invalid` error) and `max_node` bytes kept per text,
/// CDATA or comment node (also the largest tag accepted).
pub fn parse_with_limits<R: BufRead>(
    reader: R,
    window: Window,
    max_document: u64,
    max_node: usize,
    sink: &mut dyn FnMut(XmltvItem) -> CoreResult<()>,
) -> CoreResult<ParseStats> {
    let guard = Guard {
        inner: reader,
        f: Filter::new(max_document, max_node.max(16)),
    };
    let mut xml = xml_reader(BufReader::with_capacity(64 * 1024, guard));
    // Mirror of quick-xml's stack of open names (their lengths): Start pushes,
    // End pops one, whatever its name. quick-xml keeps every unclosed name, so
    // a feed of `<a><a><a>...` would grow it without bound.
    let mut open: Vec<usize> = Vec::new();
    let mut open_bytes: usize = 0;
    // Bytes consumed by readers dropped when the stack was reset.
    let mut pos_base: u64 = 0;
    let mut p = Parser {
        window,
        latin1: false,
        ctx: Ctx::None,
        capture: None,
        pending: HashMap::new(),
        pending_order: BTreeMap::new(),
        pending_bytes: 0,
        pending_seq: 0,
        stats: ParseStats::default(),
        saw_tv: false,
        sink,
    };
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    loop {
        let event = match xml.read_event_into(&mut buf) {
            Ok(ev) => ev,
            Err(err) => {
                // A size limit is fatal even after data was read: the rest of
                // the feed is not trustworthy and must not replace stored data.
                if let quick_xml::Error::Io(io) = &err {
                    if let Some(limit) = io.get_ref().and_then(|e| e.downcast_ref::<LimitError>()) {
                        return Err(CoreError::Invalid(limit.0.clone()));
                    }
                }
                let pos = pos_base + xml.buffer_position();
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
            Event::Start(e) => {
                let n = e.name().as_ref().len();
                open.push(n);
                open_bytes += n;
                p.on_start(&e, false)?;
            }
            Event::Empty(e) => p.on_start(&e, true)?,
            Event::End(e) => {
                if let Some(n) = open.pop() {
                    open_bytes -= n;
                }
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
        if open.len() > MAX_OPEN_DEPTH || open_bytes > MAX_OPEN_NAME_BYTES {
            // Only reached right after a Start, where a fresh reader picks up
            // in the same (text) state; the parser's own context does not
            // depend on quick-xml's stack, and unmatched ends are allowed.
            tracing::debug!(
                depth = open.len(),
                "XMLTV nesting too deep; dropping open names"
            );
            pos_base += xml.buffer_position();
            xml = xml_reader(xml.into_inner());
            open.clear();
            open_bytes = 0;
        }
    }
    let skipped = xml.get_ref().get_ref().f.skipped_nodes;
    if skipped > 0 {
        tracing::warn!(
            nodes = skipped,
            "XMLTV text nodes larger than {max_node} bytes were cut"
        );
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

/// A quick-xml reader over `inner` with the lenient settings [`parse`] uses.
fn xml_reader<R: BufRead>(inner: R) -> Reader<R> {
    let mut xml = Reader::from_reader(inner);
    let cfg = xml.config_mut();
    cfg.trim_text(false);
    cfg.check_end_names = false;
    cfg.allow_unmatched_ends = true;
    cfg.expand_empty_elements = false;
    cfg.check_comments = false;
    xml
}

/// Approximate heap bytes of a held programme.
fn programme_bytes(p: &XmltvProgramme) -> usize {
    let opt = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    128 + 2 * p.channel.len()
        + p.title.len()
        + opt(&p.description)
        + opt(&p.category)
        + opt(&p.icon)
}

impl Parser<'_> {
    /// The trimmed, unescaped value of attribute `key`: `Ok(None)` when it is
    /// missing or blank, `Err(())` when it is longer than `max` bytes.
    fn attr(&self, e: &BytesStart<'_>, key: &[u8], max: usize) -> Result<Option<String>, ()> {
        for a in e.attributes().with_checks(false).flatten() {
            if a.key.local_name().as_ref() == key {
                let v = decode(&a.value, self.latin1);
                let v = unescape_lenient(&v);
                let v = v.trim();
                return if v.is_empty() {
                    Ok(None)
                } else if v.len() > max {
                    Err(())
                } else {
                    Ok(Some(v.to_string()))
                };
            }
        }
        Ok(None)
    }

    /// [`Self::attr`] with an over-long value treated as missing.
    fn attr_or_none(&self, e: &BytesStart<'_>, key: &[u8], max: usize) -> Option<String> {
        self.attr(e, key, max).ok().flatten()
    }

    fn on_start(&mut self, e: &BytesStart<'_>, empty: bool) -> CoreResult<()> {
        let name = e.local_name();
        let name = name.as_ref();
        match name {
            b"tv" => self.saw_tv = true,
            b"channel" => {
                self.capture = None;
                let id = self.attr(e, b"id", MAX_ID_BYTES);
                let cb = ChannelBuilder {
                    bad_id: id.is_err(),
                    id: id.ok().flatten().unwrap_or_default(),
                    ..Default::default()
                };
                self.ctx = Ctx::Channel(cb);
                if empty {
                    self.on_end(b"channel")?;
                }
            }
            b"programme" => {
                self.capture = None;
                // An over-long channel leaves it empty: skipped as invalid.
                let pb = ProgrammeBuilder {
                    channel: self
                        .attr_or_none(e, b"channel", MAX_ID_BYTES)
                        .unwrap_or_default(),
                    start: self
                        .attr_or_none(e, b"start", MAX_ID_BYTES)
                        .as_deref()
                        .and_then(parse_xmltv_date),
                    stop: self
                        .attr_or_none(e, b"stop", MAX_ID_BYTES)
                        .as_deref()
                        .and_then(parse_xmltv_date),
                    ..Default::default()
                };
                self.ctx = Ctx::Programme(pb);
                if empty {
                    self.on_end(b"programme")?;
                }
            }
            b"icon" => {
                let src = self.attr_or_none(e, b"src", MAX_URL_BYTES);
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
                    if c.bad_id {
                        self.stats.skipped_invalid += 1;
                    } else if !c.id.is_empty() {
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
        if let Some(mut prev) = self.take_pending(&p.channel) {
            prev.stop = if prev.start < start {
                start
            } else {
                prev.start + DEFAULT_DURATION_SECS
            };
            self.stats.inferred_stop += 1;
            self.emit(prev)?;
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
            // Its stop is at least its start, so a start past the window is
            // outside it whatever stop is inferred later.
            None if start > self.window.max_start => {
                self.stats.skipped_window += 1;
                Ok(())
            }
            None => self.hold(prog),
            Some(stop) if stop > start => self.emit(prog),
            Some(_) => {
                self.stats.skipped_invalid += 1;
                Ok(())
            }
        }
    }

    /// Removes and returns the held programme of `channel`.
    fn take_pending(&mut self, channel: &str) -> Option<XmltvProgramme> {
        let (seq, prog) = self.pending.remove(channel)?;
        self.pending_order.remove(&(prog.start, seq));
        self.pending_bytes -= programme_bytes(&prog);
        Some(prog)
    }

    /// Holds a stop-less programme until the next one on its channel (none is
    /// held for that channel: [`Self::finish_programme`] took it). Past the
    /// caps the oldest held programme gets the default duration.
    fn hold(&mut self, prog: XmltvProgramme) -> CoreResult<()> {
        self.pending_seq += 1;
        let seq = self.pending_seq;
        self.pending_bytes += programme_bytes(&prog);
        self.pending_order
            .insert((prog.start, seq), prog.channel.clone());
        self.pending.insert(prog.channel.clone(), (seq, prog));
        while self.pending.len() > MAX_PENDING || self.pending_bytes > MAX_PENDING_BYTES {
            let Some((_, channel)) = self.pending_order.first_key_value() else {
                break;
            };
            let channel = channel.clone();
            if let Some(mut oldest) = self.take_pending(&channel) {
                oldest.stop = oldest.start + DEFAULT_DURATION_SECS;
                self.stats.inferred_stop += 1;
                self.emit(oldest)?;
            }
        }
        Ok(())
    }

    fn flush_pending(&mut self) -> CoreResult<()> {
        self.pending_order.clear();
        self.pending_bytes = 0;
        let mut rest: Vec<_> = self.pending.drain().map(|(_, (_, p))| p).collect();
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

/// Error raised by [`Guard`] when a size limit is passed.
#[derive(Debug)]
struct LimitError(String);

impl std::fmt::Display for LimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LimitError {}

fn limit_error(msg: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, LimitError(msg))
}

fn size_text(bytes: u64) -> String {
    if bytes >= 1 << 20 {
        format!("{} MB", bytes >> 20)
    } else {
        format!("{bytes} bytes")
    }
}

#[derive(Clone, Copy)]
enum Mode {
    /// Character data, up to the next `<`.
    Text,
    /// Just after `<`.
    Open,
    /// Just after `<!`.
    Bang,
    /// Just after `<![`: `k` bytes of `CDATA[` matched (passed as part of the
    /// opener, so they do not count against the node cap).
    CdataOpen { k: usize },
    /// Just after `<!-`: quick-xml takes one more byte as part of the opener
    /// before it looks for `-->` (so `<!--->` is not a whole comment).
    CommentOpen,
    /// Inside an element or end tag, up to the next `>` outside quotes;
    /// `quote` is the open quote byte, 0 when outside quotes.
    Tag { quote: u8 },
    /// Inside `<!DOCTYPE ...>`: `<` and `>` nest, the `>` at depth 0 ends it.
    DocType { depth: u32 },
    /// Inside CDATA, a comment or a processing instruction, up to `end`;
    /// `m` bytes of `end` matched.
    Delim { end: &'static [u8], m: usize },
}

/// Byte-level state of [`Guard`]: a coarse XML lexer that splits the input
/// into nodes exactly where quick-xml 0.37 splits it into events (quoted
/// attribute values, `<?...?>`, `<!DOCTYPE [...]>`, CDATA and comments are one
/// node each), enough to cut oversized nodes before quick-xml buffers them.
struct Filter {
    mode: Mode,
    /// Bytes of the current node passed through.
    run: usize,
    total: u64,
    max_total: u64,
    max_node: usize,
    skipped_nodes: u64,
    skipping: bool,
}

impl Filter {
    fn new(max_total: u64, max_node: usize) -> Self {
        Self {
            mode: Mode::Text,
            run: 0,
            total: 0,
            max_total,
            max_node,
            skipped_nodes: 0,
            skipping: false,
        }
    }

    fn start_node(&mut self, mode: Mode) {
        self.mode = mode;
        self.run = 0;
        self.skipping = false;
    }

    fn note_skip(&mut self) {
        if !self.skipping {
            self.skipping = true;
            self.skipped_nodes += 1;
        }
    }

    /// Copies the content bytes `src` (no delimiters) of the current node to
    /// `out` while the node is under the cap, discarding the rest. Returns
    /// (bytes consumed, bytes written).
    fn content(&mut self, src: &[u8], out: &mut [u8]) -> (usize, usize) {
        if self.run < self.max_node {
            let n = src.len().min(self.max_node - self.run).min(out.len());
            out[..n].copy_from_slice(&src[..n]);
            self.run += n;
            (n, n)
        } else {
            self.note_skip();
            (src.len(), 0)
        }
    }

    /// Copies bytes of a tag or DOCTYPE (which cannot be cut) to `out`;
    /// errors once the node passes the cap. Returns the bytes copied.
    fn tag_bytes(&mut self, src: &[u8], out: &mut [u8], what: &str) -> std::io::Result<usize> {
        let n = src.len().min(out.len());
        if self.run + n > self.max_node {
            return Err(limit_error(format!(
                "the XMLTV feed has {what} larger than {}",
                size_text(self.max_node as u64)
            )));
        }
        out[..n].copy_from_slice(&src[..n]);
        self.run += n;
        Ok(n)
    }

    /// Filters `input` into `out`; returns (bytes consumed, bytes written).
    /// Makes progress whenever `out.len() >= 3`.
    fn step(&mut self, input: &[u8], out: &mut [u8]) -> std::io::Result<(usize, usize)> {
        const TAG: &str = "a tag";
        let (mut i, mut w) = (0, 0);
        while i < input.len() && w < out.len() {
            let b = input[i];
            match self.mode {
                Mode::Text if b == b'<' => {
                    out[w] = b;
                    (i, w) = (i + 1, w + 1);
                    self.start_node(Mode::Open);
                    self.run = 1;
                }
                Mode::Text => {
                    let rest = &input[i..];
                    let end = rest.iter().position(|&c| c == b'<').unwrap_or(rest.len());
                    let (used, wrote) = self.content(&rest[..end], &mut out[w..]);
                    (i, w) = (i + used, w + wrote);
                }
                Mode::Open if b == b'!' => {
                    out[w] = b;
                    (i, w) = (i + 1, w + 1);
                    self.run += 1;
                    self.mode = Mode::Bang;
                }
                Mode::Open if b == b'?' => {
                    // quick-xml's PI scan starts at this `?`, so `<?>` is complete.
                    out[w] = b;
                    (i, w) = (i + 1, w + 1);
                    self.start_node(Mode::Delim { end: b"?>", m: 1 });
                }
                // Element or end tag: this byte is the first of the tag.
                Mode::Open => self.mode = Mode::Tag { quote: 0 },
                Mode::Bang if matches!(b, b'[' | b'-' | b'D' | b'd') => {
                    out[w] = b;
                    (i, w) = (i + 1, w + 1);
                    match b {
                        b'[' => self.mode = Mode::CdataOpen { k: 0 },
                        b'-' => self.mode = Mode::CommentOpen,
                        _ => {
                            self.run += 1;
                            self.mode = Mode::DocType { depth: 0 };
                        }
                    }
                }
                // quick-xml rejects any other `<!`; bound it like a tag.
                Mode::Bang => self.mode = Mode::Tag { quote: 0 },
                Mode::CdataOpen { k } if k < 6 && b == b"CDATA["[k] => {
                    out[w] = b;
                    (i, w) = (i + 1, w + 1);
                    self.mode = Mode::CdataOpen { k: k + 1 };
                }
                // quick-xml ends any `<![` at `]]>`; this byte is content.
                Mode::CdataOpen { .. } => self.start_node(Mode::Delim { end: b"]]>", m: 0 }),
                Mode::CommentOpen => {
                    out[w] = b;
                    (i, w) = (i + 1, w + 1);
                    self.start_node(Mode::Delim { end: b"-->", m: 0 });
                }
                Mode::Tag { quote: 0 } if b == b'>' => {
                    out[w] = b;
                    (i, w) = (i + 1, w + 1);
                    self.start_node(Mode::Text);
                }
                Mode::Tag { quote } => {
                    let rest = &input[i..];
                    let stop = rest
                        .iter()
                        .position(|&c| {
                            if quote == 0 {
                                matches!(c, b'>' | b'"' | b'\'')
                            } else {
                                c == quote
                            }
                        })
                        .unwrap_or(rest.len());
                    if stop > 0 {
                        let n = self.tag_bytes(&rest[..stop], &mut out[w..], TAG)?;
                        (i, w) = (i + n, w + n);
                    } else {
                        // `b` opens or closes a quoted value.
                        self.tag_bytes(&rest[..1], &mut out[w..], TAG)?;
                        (i, w) = (i + 1, w + 1);
                        self.mode = Mode::Tag {
                            quote: if quote == 0 { b } else { 0 },
                        };
                    }
                }
                Mode::DocType { depth } => {
                    const WHAT: &str = "a DOCTYPE declaration";
                    let rest = &input[i..];
                    let stop = rest
                        .iter()
                        .position(|&c| c == b'<' || c == b'>')
                        .unwrap_or(rest.len());
                    if stop > 0 {
                        let n = self.tag_bytes(&rest[..stop], &mut out[w..], WHAT)?;
                        (i, w) = (i + n, w + n);
                    } else {
                        self.tag_bytes(&rest[..1], &mut out[w..], WHAT)?;
                        (i, w) = (i + 1, w + 1);
                        match (b, depth) {
                            (b'>', 0) => self.start_node(Mode::Text),
                            (b'>', d) => self.mode = Mode::DocType { depth: d - 1 },
                            (_, d) => self.mode = Mode::DocType { depth: d + 1 },
                        }
                    }
                }
                Mode::Delim { end, m: 0 } if b != end[0] => {
                    // Plain content up to the next possible terminator byte.
                    let rest = &input[i..];
                    let n = rest.iter().position(|&c| c == end[0]).unwrap_or(rest.len());
                    let (used, wrote) = self.content(&rest[..n], &mut out[w..]);
                    (i, w) = (i + used, w + wrote);
                }
                Mode::Delim { end, m } => {
                    let next = if b == end[m] {
                        m + 1
                    } else if b == end[0] {
                        // `]]]>` / `--->`: keep the longest partial match.
                        if m == 2 && end[1] == end[0] {
                            2
                        } else {
                            1
                        }
                    } else {
                        0
                    };
                    if next == end.len() {
                        if self.skipping {
                            // The partial match was discarded: write the whole terminator.
                            if out.len() - w < end.len() {
                                break;
                            }
                            out[w..w + end.len()].copy_from_slice(end);
                            w += end.len();
                        } else {
                            out[w] = b;
                            w += 1;
                        }
                        i += 1;
                        self.start_node(Mode::Text);
                        continue;
                    }
                    let (used, wrote) = self.content(&input[i..=i], &mut out[w..]);
                    (i, w) = (i + used, w + wrote);
                    self.mode = Mode::Delim { end, m: next };
                }
            }
        }
        Ok((i, w))
    }
}

/// Reader adapter enforcing the document and node size limits.
struct Guard<R> {
    inner: R,
    f: Filter,
}

impl<R: BufRead> Read for Guard<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let mut written = 0;
        while written < out.len() {
            let input = self.inner.fill_buf()?;
            if input.is_empty() {
                break;
            }
            let (used, wrote) = self.f.step(input, &mut out[written..])?;
            self.inner.consume(used);
            self.f.total += used as u64;
            if self.f.total > self.f.max_total {
                return Err(limit_error(format!(
                    "the XMLTV feed is larger than {} once decompressed",
                    size_text(self.f.max_total)
                )));
            }
            written += wrote;
            if used == 0 {
                // Too little room left in `out` for a terminator.
                break;
            }
        }
        Ok(written)
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

    fn collect_limited(xml: &[u8], max_doc: u64, max_node: usize) -> CoreResult<Vec<XmltvItem>> {
        let mut items = Vec::new();
        parse_with_limits(xml, Window::unbounded(), max_doc, max_node, &mut |i| {
            items.push(i);
            Ok(())
        })?;
        Ok(items)
    }

    fn titles(items: &[XmltvItem]) -> Vec<String> {
        items
            .iter()
            .filter_map(|i| match i {
                XmltvItem::Programme(p) => Some(p.title.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn oversized_nodes_are_cut_and_parsing_continues() {
        let big = "x".repeat(5_000);
        let xml = format!(
            r#"<tv><!-- {big} -- > ]]> --><programme start="20240101120000" stop="20240101130000" channel="a"><title>{big}</title><desc><![CDATA[{big}]]]]]></desc></programme>
<programme start="20240101130000" stop="20240101140000" channel="a"><title><![CDATA[a]b]]c]]></title><desc>Tom &amp; Jerry</desc></programme></tv>"#
        );
        let items = collect_limited(xml.as_bytes(), u64::MAX, 100).unwrap();
        let t = titles(&items);
        assert_eq!(t, vec!["x".repeat(100), "a]b]]c".to_string()]);
        let XmltvItem::Programme(p) = &items[0] else {
            panic!()
        };
        // The cut CDATA keeps its first 100 bytes; stray `]` before `]]>` are content.
        assert!(p
            .description
            .as_deref()
            .unwrap()
            .starts_with(&"x".repeat(100)));
        assert!(p.description.as_deref().unwrap().len() <= 100 + 4);
        let XmltvItem::Programme(p) = &items[1] else {
            panic!()
        };
        assert_eq!(p.description.as_deref(), Some("Tom & Jerry"));
        // Same document unlimited parses identically for the small programme.
        let items = collect_limited(xml.as_bytes(), u64::MAX, MAX_NODE_BYTES).unwrap();
        assert_eq!(titles(&items)[0].len(), MAX_TITLE_CHARS);
    }

    #[test]
    fn filter_is_transparent_under_the_cap() {
        let xml = r#"<?xml version="1.0"?><!DOCTYPE tv SYSTEM "x.dtd"><tv><channel id="c"><display-name><![CDATA[A <b> ]] > B]]></display-name></channel><!----><!-- a - b --></tv>"#;
        let mut out = Vec::new();
        let mut g = Guard {
            inner: xml.as_bytes(),
            f: Filter::new(u64::MAX, 1 << 20),
        };
        g.read_to_end(&mut out).unwrap();
        assert_eq!(out, xml.as_bytes());
        let items = collect_limited(xml.as_bytes(), u64::MAX, 1 << 20).unwrap();
        let XmltvItem::Channel(c) = &items[0] else {
            panic!()
        };
        assert_eq!(c.display_name, "A <b> ]] > B");
    }

    #[test]
    fn document_and_tag_limits_are_invalid_errors() {
        let mut xml = String::from(r#"<tv><channel id="a"/>"#);
        xml.push_str(&" ".repeat(10_000));
        xml.push_str("</tv>");
        let err = collect_limited(xml.as_bytes(), 4_096, 64).unwrap_err();
        assert!(
            matches!(err, CoreError::Invalid(ref m) if m.contains("decompressed")),
            "{err}"
        );
        let xml = format!(r#"<tv><channel id="a" x="{}"/></tv>"#, "y".repeat(500));
        let err = collect_limited(xml.as_bytes(), u64::MAX, 64).unwrap_err();
        assert!(
            matches!(err, CoreError::Invalid(ref m) if m.contains("tag")),
            "{err}"
        );
    }

    /// Runs the byte filter alone over `xml`.
    fn filtered(xml: &[u8], max_node: usize) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut g = Guard {
            inner: xml,
            f: Filter::new(u64::MAX, max_node),
        };
        g.read_to_end(&mut out)?;
        Ok(out)
    }

    /// `head`, then `reps` copies of `>` + 1000 `y` + `<z`, then `tail`.
    fn angle_bomb(head: &str, reps: usize, tail: &str) -> Vec<u8> {
        let mut v = head.as_bytes().to_vec();
        for _ in 0..reps {
            v.push(b'>');
            v.extend(std::iter::repeat_n(b'y', 1000));
            v.extend_from_slice(b"<z");
        }
        v.extend_from_slice(tail.as_bytes());
        v
    }

    #[test]
    fn quoted_attribute_with_angle_brackets_is_one_capped_tag() {
        // R7-r2 F1 (a): quick-xml reads the quoted value as one tag.
        for (open, close) in [("\"", "\""), ("'", "'")] {
            let xml = angle_bomb(
                &format!(r#"<tv><channel id="a"/><programme x={open}"#),
                100,
                &format!("{close}></programme></tv>"),
            );
            let err = filtered(&xml, 4096).unwrap_err();
            assert!(err.to_string().contains("a tag larger"), "{err}");
            let err = collect_limited(&xml, u64::MAX, 4096).unwrap_err();
            assert!(
                matches!(err, CoreError::Invalid(ref m) if m.contains("tag")),
                "{err}"
            );
        }
        // Same in an end tag (quick-xml tracks quotes there too).
        let xml = angle_bomb(r#"<tv><channel id="a"></channel x=""#, 100, "\"></tv>");
        assert!(filtered(&xml, 4096).is_err());
    }

    #[test]
    fn doctype_internal_subset_is_one_capped_node() {
        // R7-r2 F1 (b).
        let mut xml = b"<?xml version=\"1.0\"?><!DOCTYPE tv [".to_vec();
        for _ in 0..100 {
            xml.extend_from_slice(b"<!ELEMENT a ANY>");
            xml.extend(std::iter::repeat_n(b' ', 1000));
        }
        xml.extend_from_slice(br#"]><tv><channel id="a"/></tv>"#);
        let err = filtered(&xml, 4096).unwrap_err();
        assert!(err.to_string().contains("DOCTYPE"), "{err}");
        let err = collect_limited(&xml, u64::MAX, 4096).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{err}");
        // A small subset passes through untouched.
        let xml = br#"<!DOCTYPE tv [<!ELEMENT tv ANY><!ATTLIST tv x CDATA "a>b">]><tv><channel id="a"/></tv>"#;
        assert_eq!(filtered(xml, 4096).unwrap(), xml.to_vec());
        assert_eq!(collect_limited(xml, u64::MAX, 4096).unwrap().len(), 1);
    }

    #[test]
    fn processing_instruction_is_cut_like_a_text_node() {
        // R7-r2 F1 (c): `>` / `<` inside `<?...?>` do not end it.
        let xml = angle_bomb(
            r#"<tv><channel id="a"/><?pi "#,
            100,
            r#"?><channel id="b"/></tv>"#,
        );
        let out = filtered(&xml, 4096).unwrap();
        assert!(out.len() < 4096 + 100, "{} bytes passed", out.len());
        let items = collect_limited(&xml, u64::MAX, 4096).unwrap();
        assert_eq!(items.len(), 2, "the channel after the PI is still read");
    }

    #[test]
    fn bang_nodes_follow_quick_xml_boundaries() {
        // `<!--->` is not a whole comment for quick-xml; `<!-x` and `<![x`
        // open a comment and a CDATA section.
        for head in ["<tv><!--->", "<tv><!-x", "<tv><![x"] {
            let tail = if head.contains("<![") {
                "]]></tv>"
            } else {
                "--></tv>"
            };
            let mut xml = head.as_bytes().to_vec();
            for _ in 0..100 {
                xml.extend_from_slice(b"<a>");
                xml.extend(std::iter::repeat_n(b'y', 1000));
            }
            xml.extend_from_slice(tail.as_bytes());
            let out = filtered(&xml, 4096).unwrap();
            assert!(out.len() < 4096 + 100, "{head}: {} bytes passed", out.len());
        }
        // Transparent under the cap, odd but valid shapes included.
        let xml = br#"<?xml version="1.0"?><??><tv a='>"' b=">'"><!-- x --><!----><![CDATA[]]><![CDATA[]]]><channel id="c"/></tv>"#;
        assert_eq!(filtered(xml, 4096).unwrap(), xml.to_vec());
        assert_eq!(collect_limited(xml, u64::MAX, 4096).unwrap().len(), 1);
        // `<?>` is a whole (if empty) PI for quick-xml's lexer.
        let xml = br#"<?><tv x="1">"#;
        assert_eq!(filtered(xml, 4096).unwrap(), xml.to_vec());
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
