//! B8 round 3 follow-up: EPG ingest registers as a long writer (B9-D64), so
//! a user write made while it holds the write lock waits instead of failing
//! with "database is locked" after the normal 5 s busy timeout.
//!
//! Kept in its own test binary: the long-writer mark is process-wide, and an
//! import in another test of the same process would hide a missing mark.

use iptv_core::epg::ingest::ingest_reader;
use iptv_core::epg::xmltv::Window;
use std::time::{Duration, Instant};

#[test]
fn user_writes_land_while_an_epg_ingest_holds_the_write_lock() {
    let dir = tempfile::tempdir().unwrap();
    let pool = iptv_core::db::open(&dir.path().join("t.db")).unwrap();
    {
        let mut c = pool.get().unwrap();
        iptv_core::db::migrate(&mut c).unwrap();
        c.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
            .unwrap();
    }
    let xml = r#"<tv><channel id="c"><display-name>C</display-name></channel><programme channel="c" start="20261012120000 +0000" stop="20261012130000 +0000"><title>T</title></programme></tv>"#;
    let mut ingest_conn = pool.get().unwrap();
    let mut waited = None;
    let stats = ingest_reader(
        &mut ingest_conn,
        "u",
        std::io::Cursor::new(xml.as_bytes().to_vec()),
        Window::unbounded(),
        None,
        &mut |phase, _| {
            if phase != "saving" || waited.is_some() {
                return;
            }
            // Stand-in for the swap of a huge feed: the write lock is held
            // longer than the normal busy timeout.
            let (tx, rx) = std::sync::mpsc::channel();
            let p = pool.clone();
            let holder = std::thread::spawn(move || {
                let mut c = p.get().unwrap();
                let t = c
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .unwrap();
                t.execute("UPDATE epg_sources SET etag = etag", []).unwrap();
                tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(6500));
                t.commit().unwrap();
            });
            rx.recv().unwrap();
            let user = pool.get().unwrap();
            let t = Instant::now();
            let r = user.execute("UPDATE epg_sources SET enabled = 1 WHERE url = 'u'", []);
            let took = t.elapsed();
            holder.join().unwrap();
            assert!(r.is_ok(), "user write failed after {took:?}: {r:?}");
            waited = Some(took);
        },
    )
    .unwrap();
    assert_eq!(stats.programs, 1);
    let took = waited.expect("the saving phase ran");
    assert!(took > Duration::from_secs(5), "it waited: {took:?}");
}
