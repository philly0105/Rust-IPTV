//! Text generators: the sample M3U and XMLTV, and the large streamed M3U and
//! XMLTV feeds used for performance tests.
//!
//! The large generators are iterators of byte chunks (`~64 KiB` each), so the
//! mock can stream them as an HTTP body and `iptv-fixtures` can write them to
//! disk without ever holding the whole document in memory.

use std::fmt::Write as _;

use crate::catalog::{self, Channel, Programme};

/// Base URL baked into static fixture files (`fixtures/sample.m3u`,
/// `fixtures/backup-v1.json`): the e2e mock port.
pub const DEFAULT_BASE: &str = "http://127.0.0.1:7290";

/// Target chunk size for streamed generators.
pub const CHUNK: usize = 64 * 1024;

/// One mebibyte, the unit of `?mb=` and `write_xmltv(.., megabytes)`.
pub const MIB: usize = 1024 * 1024;

/// Number of channels in the large XMLTV feed.
pub const LARGE_XMLTV_CHANNELS: usize = 400;

/// Escapes text for XML element content and attribute values.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// M3U attribute values cannot contain `"`; replace with `'`.
fn m3u_attr(s: &str) -> String {
    s.replace('"', "'")
}

/// Logo URL for a channel key (served by the mock as an SVG).
pub fn logo_url(base: &str, key: &str) -> String {
    format!("{base}/img/logo/{key}.svg")
}

/// Live HLS URL for an Xtream stream id.
pub fn live_url(base: &str, id: u32) -> String {
    format!("{base}/xtream/live/demo/secret/{id}.m3u8")
}

/// Radio stream URL (MP3, Range-capable).
pub fn radio_url(base: &str) -> String {
    format!("{base}/media/radio.mp3")
}

// ---------------------------------------------------------------------------
// Sample M3U
// ---------------------------------------------------------------------------

/// The 25-channel sample playlist with every URL rooted at `base`.
///
/// `fixtures/sample.m3u` is exactly `sample_m3u(DEFAULT_BASE)`; the mock
/// serves `sample_m3u(<its own base>)` at `/m3u/sample.m3u`.
pub fn sample_m3u(base: &str) -> String {
    let mut out = String::with_capacity(8 * 1024);
    let _ = writeln!(
        out,
        "#EXTM3U url-tvg=\"{base}/xmltv/sample.xml\" x-tvg-url=\"{base}/xmltv/sample.xml\" refresh=\"3600\""
    );
    let _ = writeln!(out, "#PLAYLIST:Tsrust IPTV sample");
    for (chno, (id, group)) in catalog::SAMPLE_M3U_CHANNELS.iter().enumerate() {
        let c = catalog::channel(*id).expect("sample channel in catalog");
        let mut attrs = format!(
            "tvg-id=\"{}\" tvg-name=\"{}\" tvg-logo=\"{}\" tvg-chno=\"{}\" group-title=\"{}\"",
            c.epg_id,
            m3u_attr(c.name),
            logo_url(base, c.epg_id),
            chno + 1,
            group
        );
        match c.id {
            101..=103 => attrs.push_str(" catchup=\"xc\" catchup-days=\"7\""),
            104 | 105 => attrs.push_str(
                " catchup=\"append\" catchup-days=\"3\" catchup-source=\"?utc={utc}&lutc={lutc}\"",
            ),
            _ => {}
        }
        if c.radio {
            attrs.push_str(" radio=\"true\"");
        }
        let _ = writeln!(out, "#EXTINF:-1 {attrs},{}", c.name);
        if c.id == 117 {
            // Per-channel headers, as VLC-style options.
            let _ = writeln!(out, "#EXTVLCOPT:http-user-agent=IPTVMockAgent/1.0");
            let _ = writeln!(out, "#EXTVLCOPT:http-referrer=http://referer.mock/");
        }
        if c.id == 118 {
            let _ = writeln!(out, "#EXTGRP:Sports");
        }
        let url = if c.radio {
            radio_url(base)
        } else {
            live_url(base, c.id)
        };
        let _ = writeln!(out, "{url}");
    }
    out
}

// ---------------------------------------------------------------------------
// XMLTV for catalog channels
// ---------------------------------------------------------------------------

const XMLTV_HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE tv SYSTEM \"xmltv.dtd\">\n<tv generator-info-name=\"iptv-mock\" source-info-name=\"Tsrust IPTV mock\">\n";

fn push_channel(out: &mut String, id: &str, name: &str, icon: &str) {
    let _ = write!(
        out,
        "  <channel id=\"{}\">\n    <display-name lang=\"en\">{}</display-name>\n    <icon src=\"{}\" />\n  </channel>\n",
        xml_escape(id),
        xml_escape(name),
        xml_escape(icon)
    );
}

fn push_programme(out: &mut String, channel_id: &str, p: &Programme, cdata: bool, extra: bool) {
    let _ = writeln!(
        out,
        "  <programme start=\"{}\" stop=\"{}\" channel=\"{}\">",
        catalog::xmltv_time(p.start),
        catalog::xmltv_time(p.stop),
        xml_escape(channel_id)
    );
    let _ = writeln!(
        out,
        "    <title lang=\"en\">{}</title>",
        xml_escape(&p.title)
    );
    if let Some(sub) = &p.sub_title {
        let _ = writeln!(
            out,
            "    <sub-title lang=\"en\">{}</sub-title>",
            xml_escape(sub)
        );
    }
    if cdata {
        let _ = writeln!(out, "    <desc lang=\"en\"><![CDATA[{}]]></desc>", p.desc);
    } else {
        let _ = writeln!(out, "    <desc lang=\"en\">{}</desc>", xml_escape(&p.desc));
    }
    if extra {
        let _ = writeln!(
            out,
            "    <credits>\n      <director>Elena March</director>\n      <presenter>Sam Rowe</presenter>\n      <guest>Ari Cole</guest>\n    </credits>\n    <date>{}</date>",
            &catalog::date(p.start)[..4]
        );
    }
    let _ = writeln!(out, "    <category lang=\"en\">{}</category>", p.category);
    if let Some(ns) = &p.episode_ns {
        let _ = writeln!(
            out,
            "    <episode-num system=\"xmltv_ns\">{ns}</episode-num>"
        );
    }
    if extra {
        let _ = writeln!(
            out,
            "    <rating system=\"VCHIP\">\n      <value>TV-PG</value>\n    </rating>\n    <star-rating>\n      <value>{}/10</value>\n    </star-rating>",
            6 + (p.start / 60 % 4)
        );
        if (p.start / 1800) % 2 == 0 {
            out.push_str("    <new />\n");
        } else {
            out.push_str("    <previously-shown />\n");
        }
    }
    out.push_str("  </programme>\n");
}

/// XMLTV for the given catalog channels over `days` UTC days starting at the
/// day containing `from`. Every fifth programme description is CDATA.
pub fn xmltv_for(base: &str, channels: &[&Channel], from: i64, days: i64) -> String {
    let start = catalog::day_start(from);
    let end = start + days * 86_400;
    let mut out = String::with_capacity(channels.len() * 40 * 400);
    out.push_str(XMLTV_HEAD);
    for c in channels {
        push_channel(&mut out, c.epg_id, c.name, &logo_url(base, c.epg_id));
    }
    for c in channels {
        let idx = catalog::channel_index(c.id);
        for p in catalog::channel_schedule(c.id, start, end) {
            let cdata = (p.start / 60 + idx as i64) % 5 == 0;
            push_programme(&mut out, c.epg_id, &p, cdata, false);
        }
    }
    out.push_str("</tv>\n");
    out
}

/// The channels in the sample M3U, in playlist order.
pub fn sample_channels() -> Vec<&'static Channel> {
    catalog::SAMPLE_M3U_CHANNELS
        .iter()
        .filter_map(|(id, _)| catalog::channel(*id))
        .collect()
}

/// Sample XMLTV (the 25 sample channels, 3 days starting the day containing
/// `from`). `fixtures/sample.xml` is `sample_xmltv(DEFAULT_BASE, EPOCH)`; the
/// mock serves `sample_xmltv(base, now - 1 day)` so "now" is always covered.
pub fn sample_xmltv(base: &str, from: i64) -> String {
    xmltv_for(base, &sample_channels(), from, 3)
}

/// XMLTV for all 40 Xtream channels (yesterday, today, tomorrow around `now`).
pub fn xtream_xmltv(base: &str, now: i64) -> String {
    let all: Vec<&Channel> = catalog::CHANNELS.iter().collect();
    xmltv_for(base, &all, now - 86_400, 3)
}

// ---------------------------------------------------------------------------
// Large M3U (streamed)
// ---------------------------------------------------------------------------

const GROUP_NAMES: [&str; 12] = [
    "News",
    "Sports",
    "Movies",
    "Kids",
    "Music",
    "Documentary",
    "Entertainment",
    "Lifestyle",
    "Regional",
    "International",
    "Series",
    "Radio",
];

const NAME_STEMS: [&str; 8] = [
    "Metro News",
    "Arena Sports",
    "Prime Cinema",
    "Kids Club",
    "Hit Music",
    "Planet Docs",
    "Family Fun",
    "World Travel",
];

/// XMLTV id of generated channel `n` (shared by the large M3U and XMLTV, so
/// a generated playlist matches a generated guide).
pub fn gen_channel_id(n: usize) -> String {
    format!("gen-{n:04}.tv")
}

/// Display name of generated XMLTV channel `n`.
pub fn gen_channel_name(n: usize) -> String {
    format!("{} {:04}", NAME_STEMS[n % NAME_STEMS.len()], n)
}

/// Group title for group `k`.
pub fn gen_group_name(k: usize) -> String {
    let stem = GROUP_NAMES[k % GROUP_NAMES.len()];
    if k < GROUP_NAMES.len() {
        stem.to_string()
    } else {
        format!("{stem} {}", k / GROUP_NAMES.len() + 1)
    }
}

/// Streaming generator for an M3U playlist of `channels` entries spread in
/// contiguous blocks over `groups` groups.
///
/// Variety per entry index `i`: every entry has `tvg-id` (matching the large
/// XMLTV ids), `tvg-name`, `tvg-logo`, `tvg-chno`, `group-title`; every 10th
/// (i % 10 == 3) is a movie-like `.mp4` URL; every 50th (i % 50 == 7) is
/// `radio="true"`; every 25th has catch-up attributes; every 100th carries
/// `#EXTVLCOPT` headers. URLs are unique per entry.
pub struct M3uGen {
    base: String,
    channels: usize,
    groups: usize,
    next: usize,
    header_done: bool,
}

impl M3uGen {
    pub fn new(base: &str, channels: usize, groups: usize) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            channels,
            groups: groups.max(1),
            next: 0,
            header_done: false,
        }
    }

    fn push_entry(&self, out: &mut String, i: usize) {
        let base = &self.base;
        let group = gen_group_name(i * self.groups / self.channels.max(1));
        let gen_n = i % LARGE_XMLTV_CHANNELS;
        let tvg_id = gen_channel_id(gen_n);
        let name = format!(
            "{} {} {:05}",
            NAME_STEMS[i % NAME_STEMS.len()],
            if i.is_multiple_of(4) { "HD" } else { "" },
            i + 1
        )
        .replace("  ", " ");
        let _ = write!(
            out,
            "#EXTINF:-1 tvg-id=\"{tvg_id}\" tvg-name=\"{name}\" tvg-logo=\"{base}/img/logo/{tvg_id}.svg\" tvg-chno=\"{}\" group-title=\"{group}\"",
            i + 1
        );
        if i.is_multiple_of(25) {
            out.push_str(" catchup=\"xc\" catchup-days=\"3\"");
        }
        let radio = i % 50 == 7;
        if radio {
            out.push_str(" radio=\"true\"");
        }
        let _ = writeln!(out, ",{name}");
        if i % 100 == 11 {
            out.push_str("#EXTVLCOPT:http-user-agent=IPTVMockAgent/1.0\n#EXTVLCOPT:http-referrer=http://referer.mock/\n");
        }
        if radio {
            let _ = writeln!(out, "{base}/media/radio.mp3?station={}", i + 1);
        } else if i % 10 == 3 {
            let _ = writeln!(out, "{base}/xtream/movie/demo/secret/{}.mp4", 100_000 + i);
        } else {
            let _ = writeln!(out, "{base}/xtream/live/demo/secret/{}.m3u8", 10_000 + i);
        }
    }
}

impl Iterator for M3uGen {
    type Item = String;

    fn next(&mut self) -> Option<String> {
        if self.header_done && self.next >= self.channels {
            return None;
        }
        let mut out = String::with_capacity(CHUNK + 1024);
        if !self.header_done {
            self.header_done = true;
            let _ = writeln!(
                out,
                "#EXTM3U x-tvg-url=\"{0}/xmltv/large.xml?mb=5\" url-tvg=\"{0}/xmltv/large.xml?mb=5\"",
                self.base
            );
        }
        while self.next < self.channels && out.len() < CHUNK {
            self.push_entry(&mut out, self.next);
            self.next += 1;
        }
        Some(out)
    }
}

// ---------------------------------------------------------------------------
// Large XMLTV (streamed)
// ---------------------------------------------------------------------------

/// Streaming generator for an XMLTV document of at least `target_bytes`
/// bytes: 400 channels, then whole days of programmes for every channel until
/// the target is reached, then `</tv>`. Programmes start the day before
/// `from`'s day, so imported data always covers "now".
pub struct XmltvGen {
    base: String,
    target: usize,
    emitted: usize,
    day_start: i64,
    day: i64,
    channel: usize,
    pending: Vec<Programme>,
    stage: Stage,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Header,
    Programmes,
    Done,
}

impl XmltvGen {
    pub fn new(base: &str, target_bytes: usize, from: i64) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            target: target_bytes,
            emitted: 0,
            day_start: catalog::day_start(from) - 86_400,
            day: 0,
            channel: 0,
            pending: Vec::new(),
            stage: Stage::Header,
        }
    }

    fn fill_pending(&mut self) {
        let start = self.day_start + self.day * 86_400;
        let seed = 10_000 + self.channel as u64;
        let category = ["1", "2", "3"][self.channel % 3];
        let mut list = catalog::schedule(seed, category, start, start + 86_400);
        list.reverse();
        self.pending = list;
        self.channel += 1;
        if self.channel >= LARGE_XMLTV_CHANNELS {
            self.channel = 0;
            self.day += 1;
        }
    }
}

impl Iterator for XmltvGen {
    type Item = String;

    fn next(&mut self) -> Option<String> {
        let mut out = String::with_capacity(CHUNK + 4096);
        match self.stage {
            Stage::Done => return None,
            Stage::Header => {
                out.push_str(XMLTV_HEAD);
                for n in 0..LARGE_XMLTV_CHANNELS {
                    let id = gen_channel_id(n);
                    push_channel(
                        &mut out,
                        &id,
                        &gen_channel_name(n),
                        &logo_url(&self.base, &id),
                    );
                }
                self.stage = Stage::Programmes;
            }
            Stage::Programmes => {
                while out.len() < CHUNK {
                    if self.emitted + out.len() >= self.target {
                        out.push_str("</tv>\n");
                        self.stage = Stage::Done;
                        break;
                    }
                    // One channel-day per step; `fill_pending` advances the cursor.
                    let id = gen_channel_id(self.channel);
                    self.fill_pending();
                    while let Some(p) = self.pending.pop() {
                        let cdata = (p.start / 60) % 7 == 0;
                        push_programme(&mut out, &id, &p, cdata, true);
                    }
                }
            }
        }
        self.emitted += out.len();
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_covers_specials() {
        assert_eq!(
            xml_escape("a & <b> \"c\" 'd'"),
            "a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;"
        );
    }

    #[test]
    fn m3u_gen_counts_entries_and_streams_in_chunks() {
        let chunks: Vec<String> = M3uGen::new("http://x", 5_000, 7).collect();
        assert!(chunks.len() > 1);
        let text = chunks.concat();
        assert!(text.starts_with("#EXTM3U"));
        assert_eq!(text.matches("#EXTINF").count(), 5_000);
        assert!(text.contains("radio=\"true\""));
        assert!(text.contains(".mp4\n"));
        assert!(text.contains("catchup=\"xc\""));
        assert!(text.contains("#EXTVLCOPT:http-user-agent"));
        let groups: std::collections::HashSet<&str> = text
            .lines()
            .filter_map(|l| l.split("group-title=\"").nth(1))
            .filter_map(|r| r.split('"').next())
            .collect();
        assert_eq!(groups.len(), 7);
    }

    #[test]
    fn xmltv_gen_hits_target_and_closes() {
        let target = 3 * MIB;
        let text: String = XmltvGen::new("http://x", target, catalog::EPOCH).collect();
        assert!(text.len() >= target, "{} < {}", text.len(), target);
        assert!(text.len() < target + CHUNK + 64 * 1024);
        assert!(text.ends_with("</tv>\n"));
        assert_eq!(text.matches("<channel ").count(), LARGE_XMLTV_CHANNELS);
        assert!(text.contains("<![CDATA["));
        assert!(text.contains("&amp;"));
        assert_eq!(
            text.matches("<programme ").count(),
            text.matches("</programme>").count()
        );
    }

    #[test]
    fn sample_m3u_shape() {
        let m = sample_m3u(DEFAULT_BASE);
        assert_eq!(m.matches("#EXTINF").count(), 25);
        assert_eq!(m.matches("radio=\"true\"").count(), 1);
        assert!(m.starts_with("#EXTM3U url-tvg=\"http://127.0.0.1:7290/xmltv/sample.xml\""));
        assert!(m.contains("tvg-chno=\"12\""));
    }
}
