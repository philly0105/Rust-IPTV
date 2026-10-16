//! XMLTV parser edge cases: entities, CDATA, missing stop, overlapping
//! programmes, timezone offsets, gzip, BOM, Latin-1, huge single-line files,
//! truncated documents, the ingestion window.

use iptv_core::epg::fetch::open_reader;
use iptv_core::epg::xmltv::{
    parse, parse_xmltv_date, ParseStats, Window, XmltvItem, XmltvProgramme,
};
use std::io::Write;

fn run(xml: &[u8], window: Window) -> (Vec<XmltvItem>, ParseStats) {
    let mut items = Vec::new();
    let stats = parse(xml, window, &mut |i| {
        items.push(i);
        Ok(())
    })
    .expect("parse");
    (items, stats)
}

fn programmes(items: &[XmltvItem]) -> Vec<&XmltvProgramme> {
    items
        .iter()
        .filter_map(|i| match i {
            XmltvItem::Programme(p) => Some(p),
            _ => None,
        })
        .collect()
}

#[test]
fn entities_cdata_and_bare_ampersands() {
    let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <!-- comment with <programme> inside -->
  <channel id="news&amp;more.uk"><display-name>News &amp; More &#8211; HD</display-name></channel>
  <programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="news&amp;more.uk">
    <title>Tom & Jerry &nbsp;&eacute;t&eacute;</title>
    <desc><![CDATA[<p>Raw & unescaped</p>]]> plus &lt;text&gt;</desc>
  </programme>
</tv>"#;
    let (items, stats) = run(xml, Window::unbounded());
    assert_eq!(stats.channels, 1);
    let XmltvItem::Channel(c) = &items[0] else {
        panic!("channel first")
    };
    assert_eq!(c.id, "news&more.uk");
    assert_eq!(c.display_name, "News & More \u{2013} HD");
    let p = programmes(&items)[0];
    assert_eq!(p.channel, "news&more.uk");
    // Whitespace runs (the NBSP included) collapse to one space.
    assert_eq!(p.title, "Tom & Jerry été");
    assert_eq!(
        p.description.as_deref(),
        Some("<p>Raw & unescaped</p> plus <text>")
    );
}

#[test]
fn timezone_offsets_normalize_to_utc() {
    let xml = br#"<tv>
<programme start="20240315200000 +0100" stop="20240315210000 +0100" channel="a"><title>Paris</title></programme>
<programme start="20240315150000 -0400" stop="20240315160000 -04:00" channel="b"><title>NYC</title></programme>
<programme start="20240316001500 +0515" stop="20240316011500 +0515" channel="c"><title>Kathmandu-ish</title></programme>
<programme start="20240315190000" stop="20240315200000" channel="d"><title>No offset</title></programme>
</tv>"#;
    let (items, _) = run(xml, Window::unbounded());
    let utc = parse_xmltv_date("20240315190000 +0000").unwrap();
    for p in programmes(&items) {
        assert_eq!(p.start, utc, "{} start", p.title);
        assert_eq!(p.stop - p.start, 3600, "{} duration", p.title);
    }
}

#[test]
fn missing_stop_overlaps_and_invalid_rows() {
    let xml = br#"<tv>
<programme start="20240101060000 +0000" channel="a"><title>A1</title></programme>
<programme start="20240101070000 +0000" channel="a"><title>A2</title></programme>
<programme start="20240101080000 +0000" stop="20240101090000 +0000" channel="a"><title>A3</title></programme>
<programme start="20240101083000 +0000" stop="20240101093000 +0000" channel="a"><title>A3 overlap</title></programme>
<programme start="bogus" stop="20240101090000 +0000" channel="a"><title>Bad start</title></programme>
<programme start="20240101090000 +0000" stop="20240101080000 +0000" channel="a"><title>Backwards</title></programme>
<programme start="20240101090000 +0000" stop="20240101100000 +0000"><title>No channel</title></programme>
<programme start="20240101090000 +0000" stop="20240101100000 +0000" channel="b"/>
</tv>"#;
    let (items, stats) = run(xml, Window::unbounded());
    let p = programmes(&items);
    let a1 = p.iter().find(|p| p.title == "A1").unwrap();
    assert_eq!(a1.stop - a1.start, 3600, "A1 stop inferred from A2");
    let a2 = p.iter().find(|p| p.title == "A2").unwrap();
    assert_eq!(a2.stop - a2.start, 3600, "A2 stop inferred from A3");
    // Overlaps are kept at ingest; queries clip them.
    assert!(p.iter().any(|p| p.title == "A3 overlap"));
    // Self-closing programme without a title is kept with an empty title.
    assert!(p.iter().any(|p| p.channel == "b" && p.title.is_empty()));
    assert_eq!(stats.skipped_invalid, 3);
    assert_eq!(stats.inferred_stop, 2);
}

#[test]
fn window_skips_old_and_far_future() {
    let now = parse_xmltv_date("20240110000000 +0000").unwrap();
    let xml = br#"<tv>
<programme start="20240107000000 +0000" stop="20240107010000 +0000" channel="a"><title>3 days ago</title></programme>
<programme start="20240108000000 +0000" stop="20240108010000 +0000" channel="a"><title>47 h ago</title></programme>
<programme start="20240123000000 +0000" stop="20240123010000 +0000" channel="a"><title>13 days</title></programme>
<programme start="20240125000000 +0000" stop="20240125010000 +0000" channel="a"><title>15 days</title></programme>
</tv>"#;
    let (items, stats) = run(xml, Window::around(now));
    let titles: Vec<_> = programmes(&items).iter().map(|p| p.title.clone()).collect();
    assert_eq!(titles, vec!["47 h ago", "13 days"]);
    assert_eq!(stats.skipped_window, 2);
}

#[test]
fn first_of_each_regardless_of_language_and_empty_skipped() {
    let xml = br#"<tv><channel id="x"><display-name lang="en">  </display-name><display-name lang="nl">NPO 1</display-name>
<icon src=""/><icon src="http://logo/x.png"/></channel>
<programme start="20240101120000" stop="20240101130000" channel="x">
<title lang="nl">Journaal</title><title lang="en">News</title>
<sub-title>ignored</sub-title><desc lang="en">First desc</desc><desc lang="nl">Tweede</desc>
<category lang="en">news</category><category lang="nl">nieuws</category>
<credits><actor>Someone</actor></credits><icon src="http://p/1.jpg"/>
</programme></tv>"#;
    let (items, _) = run(xml, Window::unbounded());
    let XmltvItem::Channel(c) = &items[0] else {
        panic!()
    };
    assert_eq!(c.display_name, "NPO 1");
    assert_eq!(c.icon.as_deref(), Some("http://logo/x.png"));
    let p = programmes(&items)[0];
    assert_eq!(p.title, "Journaal");
    assert_eq!(p.description.as_deref(), Some("First desc"));
    assert_eq!(p.category.as_deref(), Some("news"));
    assert_eq!(p.icon.as_deref(), Some("http://p/1.jpg"));
}

#[test]
fn huge_single_line_file() {
    // 50k programmes, no newline at all.
    let mut xml = String::from("<?xml version=\"1.0\"?><tv>");
    for c in 0..50 {
        xml.push_str(&format!(
            "<channel id=\"c{c}\"><display-name>Channel {c}</display-name></channel>"
        ));
    }
    let base = parse_xmltv_date("20240101000000").unwrap();
    for i in 0..50_000i64 {
        let start = base + (i / 50) * 600;
        let s = chrono::DateTime::from_timestamp(start, 0)
            .unwrap()
            .format("%Y%m%d%H%M%S +0000");
        let e = chrono::DateTime::from_timestamp(start + 600, 0)
            .unwrap()
            .format("%Y%m%d%H%M%S +0000");
        xml.push_str(&format!(
            "<programme start=\"{s}\" stop=\"{e}\" channel=\"c{}\"><title>Show {i}</title></programme>",
            i % 50
        ));
    }
    xml.push_str("</tv>");
    assert!(!xml.contains('\n'));
    let mut n = 0u64;
    let stats = parse(xml.as_bytes(), Window::unbounded(), &mut |_| {
        n += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(stats.programmes, 50_000);
    assert_eq!(stats.channels, 50);
    assert_eq!(n, 50_050);
}

#[test]
fn truncated_document_is_a_cut_off_download() {
    let xml = br#"<tv><channel id="a"><display-name>A</display-name></channel>
<programme start="20240101120000" stop="20240101130000" channel="a"><title>Complete</title></programme>
<programme start="20240101130000" stop="20240101140000" channel="a"><title>Cut off in the mid"#;
    // L1-core-6: a document that opens `<tv>` but ends before `</tv>` is
    // rejected, so the stored guide is kept instead of its first part.
    let err = parse(&xml[..], Window::unbounded(), &mut |_| Ok(())).unwrap_err();
    assert!(
        matches!(&err, iptv_core::CoreError::Invalid(m) if m == iptv_core::epg::xmltv::CUT_OFF_MESSAGE),
        "{err}"
    );
}

#[test]
fn rejects_non_xmltv_and_empty_feeds() {
    assert!(parse(
        &b"<!DOCTYPE html><html><body>Bad gateway</body></html>"[..],
        Window::unbounded(),
        &mut |_| Ok(())
    )
    .is_err());
    assert!(parse(&b""[..], Window::unbounded(), &mut |_| Ok(())).is_err());
    assert!(parse(
        &b"<?xml version=\"1.0\"?><tv/>"[..],
        Window::unbounded(),
        &mut |_| Ok(())
    )
    .is_err());
}

#[test]
fn gzip_bom_and_latin1_through_open_reader() {
    let dir = tempfile::tempdir().unwrap();

    // gzip, detected by magic bytes even with a .xml name.
    let plain = "<tv><channel id=\"g\"><display-name>Gzipped</display-name></channel>\
<programme start=\"20240101120000\" stop=\"20240101130000\" channel=\"g\"><title>Zipped</title></programme></tv>";
    let gz_path = dir.path().join("guide.xml");
    let mut enc = flate2::write::GzEncoder::new(
        std::fs::File::create(&gz_path).unwrap(),
        flate2::Compression::fast(),
    );
    enc.write_all(plain.as_bytes()).unwrap();
    enc.finish().unwrap();
    let mut n = 0;
    parse(
        open_reader(&gz_path).unwrap(),
        Window::unbounded(),
        &mut |_| {
            n += 1;
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(n, 2);

    // UTF-8 BOM.
    let bom_path = dir.path().join("bom.xml");
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(plain.as_bytes());
    std::fs::write(&bom_path, bytes).unwrap();
    let mut names = Vec::new();
    parse(
        open_reader(&bom_path).unwrap(),
        Window::unbounded(),
        &mut |i| {
            if let XmltvItem::Channel(c) = i {
                names.push(c.display_name);
            }
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(names, vec!["Gzipped"]);

    // ISO-8859-1 declared encoding: byte 0xE9 is 'é'.
    let latin_path = dir.path().join("latin1.xml");
    let mut latin =
        b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><tv><channel id=\"l\"><display-name>T"
            .to_vec();
    latin.push(0xe9);
    latin.extend_from_slice(b"l\xe9</display-name></channel></tv>");
    std::fs::write(&latin_path, latin).unwrap();
    let mut names = Vec::new();
    parse(
        open_reader(&latin_path).unwrap(),
        Window::unbounded(),
        &mut |i| {
            if let XmltvItem::Channel(c) = i {
                names.push(c.display_name);
            }
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(names, vec!["Télé"]);

    // Zip archives are refused with a clear error.
    let zip_path = dir.path().join("guide.zip");
    std::fs::write(&zip_path, b"PK\x03\x04rest").unwrap();
    let err = open_reader(&zip_path).err().unwrap();
    assert!(err.to_string().contains("zip"));
}
