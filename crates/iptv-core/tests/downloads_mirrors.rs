//! Mirror discovery, fingerprints, verification and the verdict cache
//! (`downloads::mirrors`) against `dl_panel` panels: the candidates of a
//! movie and of an episode across sources, identical / equivalent /
//! differing / differing-outside-the-samples copies, verdicts reused and
//! expiring,
//! busy sources, junction mismatches, and the lookup's cost on a large
//! catalog.

mod dl_panel;

use dl_panel::{
    add_movie, add_series, add_xtream_source, movie_ref, sample_offsets, series_ref,
    variant_content, Logged, Panel, PanelOptions, Redirect, Validators, Variant, SAMPLE_LEN,
};
use iptv_core::catalog::{self, CategoryRow, ItemRow};
use iptv_core::downloads::manager::{manager, HoldPurpose};
use iptv_core::downloads::mirrors::{self, Mirror};
use iptv_core::downloads::shared::{
    self, mirror_key, read_record, Fingerprint, MirrorRecord, Verdict,
};
use iptv_core::downloads::StartRequest;
use iptv_core::error::CoreError;
use iptv_core::live::matcher::Quality;
use iptv_core::model::{ContentType, CopyRef, ItemRef, SourceKind};
use iptv_core::{AppState, BroadcastSink};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;
/// Big enough for mirrors (`shared::MIN_MIRROR_TOTAL` is 8 MiB).
const SIZE: u64 = 16 * MIB;
const DAY: Duration = Duration::from_secs(24 * 3600);

struct App {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
}

async fn app() -> App {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(1024);
    let state = AppState::new(tmp.path().join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    App { _tmp: tmp, state }
}

fn movie(source: &str, id: u32) -> CopyRef {
    CopyRef::new(movie_ref(source, id), None)
}

fn episode(source: &str, series: u32, ep: u32) -> CopyRef {
    CopyRef::new(series_ref(source, series), Some(ep.to_string()))
}

fn sha(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// The fingerprint samples `variant`'s copy of `file` should give.
fn want_samples(file: u32, variant: Variant, total: u64) -> [String; 3] {
    sample_offsets(total).map(|at| {
        sha(&variant_content(
            file,
            variant,
            total,
            at,
            SAMPLE_LEN as usize,
        ))
    })
}

/// One panel per id, all serving `file` at [`SIZE`] in `variants[i]`, each
/// an Xtream source with movie `file` titled `title`.
async fn movie_panels(
    app: &App,
    ids: &[&str],
    variants: &[Variant],
    file: u32,
    title: &str,
    opts: impl Fn() -> PanelOptions,
) -> Vec<Panel> {
    let mut panels = Vec::new();
    for (id, variant) in ids.iter().zip(variants) {
        let p = Panel::with(opts()).await;
        p.set_reported(1);
        p.file_variant(file, SIZE, 0, *variant);
        add_xtream_source(&app.state, id, &p).await;
        add_movie(&app.state, id, file, title, None, "mp4").await;
        panels.push(p);
    }
    panels
}

async fn fingerprint_of(app: &App, copy: &CopyRef) -> Fingerprint {
    let ep = shared::resolve(&app.state, copy).await.unwrap();
    mirrors::fingerprint(&app.state, &ep).await.unwrap()
}

async fn identical(app: &App, item: &CopyRef, fp: &Fingerprint, exclude: &[&str]) -> Vec<String> {
    let exclude: Vec<String> = exclude.iter().map(|s| s.to_string()).collect();
    let mgr = manager(&app.state);
    mirrors::identical_copies(&app.state, &mgr, item, fp, &exclude)
        .await
        .iter()
        .map(|m: &Mirror| m.endpoint.copy.source_id().to_string())
        .collect()
}

async fn record(app: &App, copy: &CopyRef) -> Option<MirrorRecord> {
    let key = mirror_key(copy);
    app.state
        .db_call(move |c| read_record::<MirrorRecord>(c, &key))
        .await
        .unwrap()
}

async fn verdict(app: &App, owner: &CopyRef, of: &CopyRef) -> Option<Verdict> {
    record(app, owner)
        .await?
        .verdicts
        .iter()
        .find(|e| e.copy == *of)
        .map(|e| e.verdict)
}

async fn cached_identical(app: &App, item: &CopyRef) -> Vec<String> {
    let item = item.clone();
    app.state
        .db_call(move |c| mirrors::cached_identical(c, &item))
        .await
        .unwrap()
        .iter()
        .map(|c| c.source_id().to_string())
        .collect()
}

/// File requests each panel has answered so far.
fn requests(panels: &[Panel]) -> Vec<usize> {
    panels.iter().map(|p| p.log().len()).collect()
}

/// Every request is a 64 KiB Range request.
fn only_samples(log: &[Logged]) -> bool {
    log.iter()
        .all(|l| matches!(l.range, Some((a, Some(b))) if b + 1 - a == SAMPLE_LEN))
}

/// Rows written the way an import writes them, for sources the panel
/// helpers do not cover (M3U) and for a large catalog.
async fn put_rows(app: &App, source: &str, kind: &str, ct: ContentType, rows: Vec<ItemRow>) {
    let (sid, kind) = (source.to_string(), kind.to_string());
    app.state
        .db_write(move |c| {
            c.execute(
                "INSERT OR IGNORE INTO sources (id, kind, name, config_json) VALUES (?1, ?2, ?1, '{}')",
                rusqlite::params![sid, kind],
            )?;
            let categories = [CategoryRow {
                category_id: "dl".into(),
                name: "Downloads".into(),
                position: 0,
            }];
            catalog::replace_catalog(c, &sid, ct, &categories, &mut rows.into_iter())?;
            Ok(())
        })
        .await
        .unwrap();
}

fn row(source: &str, ct: ContentType, id: &str, title: &str, position: i64) -> ItemRow {
    ItemRow {
        source_id: source.into(),
        content_type: ct,
        item_id: id.into(),
        category_id: "dl".into(),
        title: title.into(),
        position,
        ..ItemRow::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn candidates_of_a_movie_across_three_sources() {
    let app = app().await;
    let panels = [
        Panel::spawn(1).await,
        Panel::spawn(2).await,
        Panel::spawn(3).await,
    ];
    for (i, p) in panels.iter().enumerate() {
        p.set_reported(1);
        add_xtream_source(&app.state, &format!("cm{i}"), p).await;
    }
    add_movie(&app.state, "cm0", 1, "Heat (1995)", None, "mp4").await;
    add_movie(&app.state, "cm0", 2, "Ronin (1998)", None, "mp4").await;
    add_movie(
        &app.state,
        "cm1",
        11,
        "EN - Heat (1995) [4K]",
        Some(1995),
        "MKV",
    )
    .await;
    add_movie(&app.state, "cm2", 21, "Heat", Some(1995), "mp4").await;
    // Another film with the same name.
    add_movie(&app.state, "cm2", 22, "Heat (2023)", None, "mp4").await;
    // An M3U copy: its container comes from the link.
    let mut m3u = row("cm3", ContentType::Movie, "m1", "Heat (1995) FHD", 0);
    m3u.url = Some("http://playlist.example/vod/heat.MKV?token=1".into());
    put_rows(&app, "cm3", "m3u", ContentType::Movie, vec![m3u]).await;

    let item = movie("cm0", 1);
    let found = mirrors::candidates(&app.state, &item).await.unwrap();
    let got: Vec<_> = found
        .iter()
        .map(|c| (c.copy.clone(), c.kind, c.container.clone(), c.quality))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                movie("cm1", 11),
                SourceKind::Xtream,
                Some("mkv".into()),
                Some(Quality::Uhd)
            ),
            (
                movie("cm2", 21),
                SourceKind::Xtream,
                Some("mp4".into()),
                None
            ),
            (
                CopyRef::new(ItemRef::new("cm3", ContentType::Movie, "m1"), None),
                SourceKind::M3u,
                Some("mkv".into()),
                Some(Quality::Fhd)
            ),
        ],
        "the 2023 film is another film"
    );
    assert!(found.iter().all(|c| c.copy.episode_id.is_none()));
    assert_eq!(found[0].title, "EN - Heat (1995) [4K]");

    let has = |copy: CopyRef| {
        let state = app.state.clone();
        async move {
            state
                .db_call(move |c| mirrors::has_candidates(c, &copy))
                .await
                .unwrap()
        }
    };
    assert!(has(item.clone()).await);
    assert!(!has(movie("cm0", 2)).await, "a title only one source has");
    assert!(!has(movie("cm0", 999)).await, "not in the catalog");
    let live = CopyRef::new(
        ItemRef::new("cm0", ContentType::Live, "1"),
        Some("catchup:1:2".into()),
    );
    assert!(!has(live.clone()).await, "catch-up never has mirrors");
    assert!(mirrors::candidates(&app.state, &live)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn candidates_of_an_episode_match_season_and_number() {
    let app = app().await;
    let panels = [
        Panel::spawn(1).await,
        Panel::spawn(2).await,
        Panel::spawn(3).await,
    ];
    for (i, p) in panels.iter().enumerate() {
        p.set_reported(1);
        add_xtream_source(&app.state, &format!("ce{i}"), p).await;
    }
    // ce1 has the same files; ce2 numbers the same episodes with its own
    // ids (files), and lacks season 2.
    panels[0].series(70, &[(1, 1, 101), (1, 2, 102), (2, 1, 201)]);
    panels[1].series(80, &[(1, 1, 101), (1, 2, 102), (2, 1, 201)]);
    panels[2].series(90, &[(1, 1, 301), (1, 2, 302)]);
    for (p, f) in panels
        .iter()
        .zip([[101, 102, 201], [101, 102, 201], [301, 302, 0]])
    {
        for f in f.into_iter().filter(|f| *f > 0) {
            p.file(f, SIZE, 0);
        }
    }
    add_series(&app.state, "ce0", 70, "Breaking Bad").await;
    add_series(&app.state, "ce1", 80, "breaking bad").await;
    add_series(&app.state, "ce2", 90, "EN - Breaking Bad [4K]").await;
    add_series(&app.state, "ce2", 91, "Better Call Saul").await;

    let item = episode("ce0", 70, 102);
    let found = mirrors::candidates(&app.state, &item).await.unwrap();
    let got: Vec<_> = found
        .iter()
        .map(|c| (c.copy.clone(), c.container.clone(), c.quality))
        .collect();
    assert_eq!(
        got,
        vec![
            (episode("ce1", 80, 102), Some("mp4".into()), None),
            (
                episode("ce2", 90, 302),
                Some("mp4".into()),
                Some(Quality::Uhd)
            ),
        ]
    );
    // Season 2 exists on ce1 only.
    let s2 = mirrors::candidates(&app.state, &episode("ce0", 70, 201))
        .await
        .unwrap();
    assert_eq!(
        s2.iter().map(|c| c.copy.clone()).collect::<Vec<_>>(),
        vec![episode("ce1", 80, 201)]
    );
    // An episode its own series no longer lists has none.
    assert!(mirrors::candidates(&app.state, &episode("ce0", 70, 999))
        .await
        .unwrap()
        .is_empty());
    // A series without an episode is no file.
    let whole = CopyRef::new(series_ref("ce0", 70), None);
    assert!(mirrors::candidates(&app.state, &whole)
        .await
        .unwrap()
        .is_empty());
    let has = |copy: CopyRef| {
        let state = app.state.clone();
        async move {
            state
                .db_call(move |c| mirrors::has_candidates(c, &copy))
                .await
                .unwrap()
        }
    };
    assert!(has(item.clone()).await);
    assert!(!has(whole).await);

    // Verification: ce1 serves the same file, ce2 another one.
    let fp = fingerprint_of(&app, &item).await;
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["ce1"]);
    assert_eq!(
        verdict(&app, &item, &episode("ce2", 90, 302)).await,
        Some(Verdict::Differs)
    );
    assert_eq!(
        cached_identical(&app, &episode("ce1", 80, 102)).await,
        vec!["ce0"]
    );
    // Seasons were read once per series (series info is cached).
    for p in &panels {
        assert!(p.counts().get("seriesInfo").copied().unwrap_or(0) <= 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fingerprints_read_three_windows_on_one_redirect() {
    let app = app().await;
    let panels = movie_panels(&app, &["fa"], &[Variant::Same], 1, "Heat (1995)", || {
        PanelOptions {
            redirect: Some(Redirect::EdgeHost {
                token_ttl: Duration::from_secs(60),
            }),
            ..PanelOptions::default()
        }
    })
    .await;
    let fp = fingerprint_of(&app, &movie("fa", 1)).await;
    assert_eq!(fp.total, SIZE as i64);
    assert_eq!(fp.samples, want_samples(1, Variant::Same, SIZE));
    assert_eq!(
        fp.validator.as_deref(),
        Some(format!("\"panel-1-{SIZE:x}\"").as_str())
    );
    assert!(chrono::DateTime::parse_from_rfc3339(&fp.checked_at).is_ok());
    let log = panels[0].log();
    // One redirect, then the edge for all three windows.
    assert_eq!(panels[0].redirects(), 1, "{log:?}");
    let edge: Vec<_> = log.iter().filter(|l| l.route == "edge").collect();
    assert_eq!(edge.len(), 3, "{log:?}");
    let starts: Vec<u64> = edge.iter().map(|l| l.range.unwrap().0).collect();
    assert_eq!(starts, sample_offsets(SIZE).to_vec());
    assert!(edge.iter().all(|l| l.status == 206));
    // Nothing is stored by fingerprint itself.
    assert!(record(&app, &movie("fa", 1)).await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fingerprints_need_ranges_a_size_and_a_big_enough_file() {
    let app = app().await;
    // A server that ignores Range.
    let router = axum::Router::new().route(
        "/movie/{u}/{p}/{file}",
        axum::routing::get(|| async { vec![7u8; 1024] }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let ep = |url: String| shared::Endpoint {
        copy: movie("nr", 1),
        kind: SourceKind::Xtream,
        url,
        headers: Default::default(),
    };
    let err = mirrors::fingerprint(&app.state, &ep(format!("{base}/movie/u/p/1.mp4")))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Unsupported(m) if m == "no ranges"),
        "{err:?}"
    );
    server.abort();

    // A small file, and a missing one.
    let p = Panel::spawn(4).await;
    p.file(5, 2 * MIB, 0);
    let err = mirrors::fingerprint(&app.state, &ep(p.movie_url(5)))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Unsupported(_)), "{err:?}");
    assert_eq!(p.log().len(), 1, "one request tells the size");
    let err = mirrors::fingerprint(&app.state, &ep(p.movie_url(6)))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identical_differs_and_outside_samples_verdicts() {
    let app = app().await;
    let ids = ["va", "vb", "vc", "vd", "ve"];
    let panels = movie_panels(
        &app,
        &ids,
        &[
            Variant::Same,
            Variant::Same,
            Variant::Differs,
            Variant::DiffersOutsideSamples,
            Variant::Same,
        ],
        1,
        "Heat (1995)",
        PanelOptions::default,
    )
    .await;
    // ve's copy is another size.
    panels[4].file(1, SIZE + SAMPLE_LEN, 0);
    let item = movie("va", 1);
    let fp = fingerprint_of(&app, &item).await;
    assert_eq!(fp.samples, want_samples(1, Variant::Same, SIZE));
    let before = requests(&panels);

    // vd differs only outside the windows: it passes, by design (the
    // engine's overlap checks are what catch it). vc and ve have other bytes
    // but the same title, container and a size within 15%: equivalent, and
    // never returned.
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["vb", "vd"]);
    use Verdict::*;
    assert_eq!(verdict(&app, &item, &movie("vb", 1)).await, Some(Identical));
    assert_eq!(
        verdict(&app, &item, &movie("vc", 1)).await,
        Some(Equivalent)
    );
    assert_eq!(verdict(&app, &item, &movie("vd", 1)).await, Some(Identical));
    assert_eq!(
        verdict(&app, &item, &movie("ve", 1)).await,
        Some(Equivalent)
    );
    // Identical and Equivalent are written under both copies' keys.
    assert_eq!(verdict(&app, &movie("vb", 1), &item).await, Some(Identical));
    assert_eq!(
        verdict(&app, &movie("vc", 1), &item).await,
        Some(Equivalent)
    );
    assert_eq!(cached_identical(&app, &item).await, vec!["vb", "vd"]);
    assert_eq!(cached_identical(&app, &movie("vb", 1)).await, vec!["va"]);

    // The differing copy saw only sample requests; the other size, one.
    let log = panels[2].log();
    assert!(log.len() <= 3 && only_samples(&log), "{log:?}");
    assert_eq!(
        panels[4].log().len(),
        1,
        "a size mismatch needs one request"
    );
    assert!(only_samples(&panels[1].log()));
    // The authority itself was not asked again.
    assert_eq!(panels[0].log().len(), before[0]);
    // Each mirror carries its own fingerprint.
    let mgr = manager(&app.state);
    let found = mirrors::identical_copies(&app.state, &mgr, &item, &fp, &[]).await;
    assert_eq!(found[0].fingerprint.samples, fp.samples);
    assert_eq!(found[0].fingerprint.total, fp.total);
    assert_eq!(found[0].endpoint.url, panels[1].movie_url(1));
    let vd = record(&app, &movie("vd", 1))
        .await
        .unwrap()
        .fingerprint
        .unwrap();
    assert_eq!(
        vd.validator.as_deref(),
        Some(format!("\"panel-1-{SIZE:x}-o\"").as_str())
    );

    // Excluded sources are left out.
    assert_eq!(identical(&app, &item, &fp, &["vb"]).await, vec!["vd"]);
    // Mirrors off: none.
    app.state.settings.write().download_use_mirrors = false;
    assert!(identical(&app, &item, &fp, &[]).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn equivalent_copies_are_recorded_but_never_mirrors() {
    let app = app().await;
    // (source, title, container, size, variant)
    let copies: [(&str, &str, &str, u64, Variant); 5] = [
        ("eq0", "Heat (1995) [4K]", "mp4", SIZE, Variant::Same),
        // Same quality and container, 1 MiB larger (about 6%).
        (
            "eq1",
            "EN - Heat (1995) [4K]",
            "MP4",
            SIZE + MIB,
            Variant::Differs,
        ),
        // Same quality and container, twice the size.
        ("eq2", "Heat (1995) [4K]", "mp4", 2 * SIZE, Variant::Differs),
        // Same quality and size, another container.
        ("eq3", "Heat (1995) [4K]", "mkv", SIZE, Variant::Differs),
        // Same container and size, another quality.
        ("eq4", "Heat (1995) FHD", "mp4", SIZE, Variant::Differs),
    ];
    let mut panels = Vec::new();
    for (id, title, ext, size, variant) in copies {
        let p = Panel::with(PanelOptions::default()).await;
        p.set_reported(1);
        p.file_variant(1, size, 0, variant);
        add_xtream_source(&app.state, id, &p).await;
        add_movie(&app.state, id, 1, title, None, ext).await;
        panels.push(p);
    }
    let item = movie("eq0", 1);
    let fp = fingerprint_of(&app, &item).await;

    assert!(
        identical(&app, &item, &fp, &[]).await.is_empty(),
        "equivalent copies never join a segment plan"
    );
    use Verdict::*;
    assert_eq!(
        verdict(&app, &item, &movie("eq1", 1)).await,
        Some(Equivalent)
    );
    assert_eq!(verdict(&app, &item, &movie("eq2", 1)).await, Some(Differs));
    assert_eq!(verdict(&app, &item, &movie("eq3", 1)).await, Some(Differs));
    assert_eq!(verdict(&app, &item, &movie("eq4", 1)).await, Some(Differs));
    // The entry carries the candidate's total; the reverse entry the item's.
    let entry =
        |rec: MirrorRecord, of: CopyRef| rec.verdicts.into_iter().find(|e| e.copy == of).unwrap();
    let e = entry(record(&app, &item).await.unwrap(), movie("eq1", 1));
    assert_eq!(e.total, Some((SIZE + MIB) as i64));
    let back = entry(record(&app, &movie("eq1", 1)).await.unwrap(), item.clone());
    assert_eq!((back.verdict, back.total), (Equivalent, Some(SIZE as i64)));
    assert_eq!(verdict(&app, &movie("eq2", 1), &item).await, None);
    assert!(cached_identical(&app, &item).await.is_empty());

    // The verdicts stand: a second call asks no panel again.
    let before = requests(&panels);
    assert!(identical(&app, &item, &fp, &[]).await.is_empty());
    assert_eq!(requests(&panels), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn verdicts_are_reused_then_expire() {
    let app = app().await;
    // Without validators, fingerprints last 7 days and verdicts 30.
    let panels = movie_panels(
        &app,
        &["ra", "rb", "rc"],
        &[Variant::Same, Variant::Same, Variant::Differs],
        1,
        "Ronin (1998)",
        || PanelOptions {
            validators: Validators::None,
            ..PanelOptions::default()
        },
    )
    .await;
    let item = movie("ra", 1);
    let fp = fingerprint_of(&app, &item).await;
    assert_eq!(fp.validator, None);
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["rb"]);
    let first = requests(&panels);
    let api: Vec<_> = panels.iter().map(|p| p.counts()).collect();

    // The second call asks no panel anything.
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["rb"]);
    assert_eq!(requests(&panels), first);
    assert_eq!(panels.iter().map(|p| p.counts()).collect::<Vec<_>>(), api);

    // 8 days on: the fingerprints have lapsed, the verdicts stand.
    mirrors::age_records(&app.state, 8 * DAY).await.unwrap();
    let rb = movie("rb", 1);
    let lapsed = app
        .state
        .db_call(move |c| mirrors::cached_fingerprint(c, &rb))
        .await
        .unwrap();
    assert_eq!(lapsed, None);
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["rb"]);
    assert_eq!(requests(&panels), first);

    // 31 days on: both copies are sampled again.
    mirrors::age_records(&app.state, 23 * DAY).await.unwrap();
    assert!(cached_identical(&app, &item).await.is_empty());
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["rb"]);
    let again = requests(&panels);
    assert_eq!(again[1], first[1] + 3, "rb sampled again");
    assert!(again[2] > first[2], "rc sampled again");
    assert_eq!(
        again[0], first[0],
        "the authority's fingerprint is the caller's"
    );
    assert_eq!(cached_identical(&app, &item).await, vec!["rb"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_validator_fingerprint_renews_a_lapsed_verdict_without_asking() {
    let app = app().await;
    let panels = movie_panels(
        &app,
        &["ta", "tb"],
        &[Variant::Same, Variant::Same],
        1,
        "Ronin (1998)",
        PanelOptions::default,
    )
    .await;
    let item = movie("ta", 1);
    let fp = fingerprint_of(&app, &item).await;
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["tb"]);
    let first = requests(&panels);
    mirrors::age_records(&app.state, 31 * DAY).await.unwrap();
    assert!(cached_identical(&app, &item).await.is_empty());
    // tb's fingerprint has an ETag: it stands until tb answers with
    // another, so the verdict is renewed from it.
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["tb"]);
    assert_eq!(requests(&panels), first);
    assert_eq!(cached_identical(&app, &item).await, vec!["tb"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn busy_or_failing_sources_are_unavailable_for_an_hour() {
    let app = app().await;
    let mut panels = movie_panels(
        &app,
        &["ua", "ub"],
        &[Variant::Same, Variant::Same],
        1,
        "Ronin (1998)",
        PanelOptions::default,
    )
    .await;
    // uc lists the movie, but its panel does not serve the file (404).
    let uc = Panel::spawn(9).await;
    uc.set_reported(1);
    add_xtream_source(&app.state, "uc", &uc).await;
    add_movie(&app.state, "uc", 1, "Ronin (1998)", None, "mp4").await;
    panels.push(uc);
    let item = movie("ua", 1);
    let fp = fingerprint_of(&app, &item).await;
    let before = requests(&panels);
    let local = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    let uc_before = panels[2].requests_on(local);
    {
        // ub has no spare connection (the manager's try_hold refuses).
        let _busy = mirrors::refuse_holds(&app.state, "ub");
        assert!(identical(&app, &item, &fp, &[]).await.is_empty());
    }
    assert_eq!(
        verdict(&app, &item, &movie("ub", 1)).await,
        Some(Verdict::Unavailable)
    );
    assert_eq!(
        verdict(&app, &item, &movie("uc", 1)).await,
        Some(Verdict::Unavailable)
    );
    let after = requests(&panels);
    assert_eq!(after[1], before[1], "a busy source is not asked");
    // The panel does not log requests for files it lacks; count them all.
    assert_eq!(
        panels[2].requests_on(local),
        uc_before + 1,
        "one request found the file missing"
    );
    assert!(cached_identical(&app, &item).await.is_empty());

    // Within the hour neither is asked again, room or not.
    panels[2].file(1, SIZE, 0);
    assert!(identical(&app, &item, &fp, &[]).await.is_empty());
    assert_eq!(requests(&panels), after);
    // An hour on, both are checked again.
    mirrors::age_records(&app.state, Duration::from_secs(3601))
        .await
        .unwrap();
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["ub", "uc"]);
}

/// Polls `done` for up to 30 s.
async fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_real_manager_orders_mirrors_and_refuses_busy_sources() {
    let app = app().await;
    iptv_core::downloads::init(app.state.clone()).await.unwrap();
    // m1 keeps its reported limit of one (no probe raises it).
    app.state.settings.write().download_probe_disabled = vec!["m1".into()];
    // (source, reported limit): budgets 1, 1, 3, 2 and 2.
    let sources = [("mo", 1), ("m1", 1), ("m2", 4), ("m3", 3), ("m4", 3)];
    let mut panels = Vec::new();
    for (id, limit) in sources {
        let p = Panel::spawn(7).await;
        p.set_reported(limit);
        p.file(1, SIZE, 0);
        add_xtream_source(&app.state, id, &p).await;
        add_movie(&app.state, id, 1, "Heat (1995)", None, "mp4").await;
        panels.push(p);
    }
    let mgr = manager(&app.state);
    for (id, _) in &sources {
        eventually("the source's limit", || {
            mgr.effective_limit(id).1 == iptv_core::model::LimitKind::Reported
        })
        .await;
    }
    let item = movie("mo", 1);
    let fp = fingerprint_of(&app, &item).await;

    // m4 is busy playing: the manager's own try_hold refuses it, so it is
    // never asked and stays unavailable for now.
    iptv_core::downloads::set_playback(&app.state, "tv", vec!["m4".into()]).await;
    assert!(mgr.try_hold("m4", HoldPurpose::Verify).is_none());
    // The rest by spare connections (m2 3, m3 2, m1 1), not catalog order.
    assert_eq!(
        identical(&app, &item, &fp, &[]).await,
        vec!["m2", "m3", "m1"]
    );
    assert_eq!(
        verdict(&app, &item, &movie("m4", 1)).await,
        Some(Verdict::Unavailable)
    );
    assert!(panels[4].log().is_empty(), "{:?}", panels[4].log());

    // A transfer of another film holds m1's one connection; playback takes
    // m3's. Both have none spare; m3 has no holder, so it comes first.
    panels[1].file(2, SIZE, 256);
    add_movie(&app.state, "m1", 2, "Ronin (1998)", None, "mp4").await;
    let d = iptv_core::downloads::start(
        &app.state,
        StartRequest {
            item_ref: Some(movie_ref("m1", 2)),
            title: "Ronin".into(),
            url: panels[1].movie_url(2),
            ..StartRequest::default()
        },
    )
    .await
    .unwrap();
    eventually("the transfer holding m1", || mgr.holders("m1") == 1).await;
    iptv_core::downloads::set_playback(&app.state, "tv", vec!["m4".into(), "m3".into()]).await;
    let ranks: Vec<_> = ["m1", "m2", "m3"]
        .iter()
        .map(|s| (mgr.spare_on("mo", s), mgr.holders(s)))
        .collect();
    assert_eq!(ranks, vec![(0, 1), (3, 0), (0, 0)]);
    // Standing verdicts need no hold, so busy m1 and m3 are still mirrors.
    assert_eq!(
        identical(&app, &item, &fp, &[]).await,
        vec!["m2", "m3", "m1"]
    );
    iptv_core::downloads::cancel(&app.state, d.id)
        .await
        .unwrap();
    iptv_core::downloads::set_playback(&app.state, "tv", Vec::new()).await;
    eventually("the transfer let go", || mgr.holders("m1") == 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_hold_seam_is_per_state_and_ends_with_its_guard() {
    let (a, b) = (app().await, app().await);
    let mut sets = Vec::new();
    for app in [&a, &b] {
        let panels = movie_panels(
            app,
            &["ha", "hb"],
            &[Variant::Same, Variant::Same],
            1,
            "Heat (1995)",
            PanelOptions::default,
        )
        .await;
        let fp = fingerprint_of(app, &movie("ha", 1)).await;
        sets.push((panels, fp));
    }
    let busy = mirrors::refuse_holds(&a.state, "hb");
    // Another state's source of the same id is not affected.
    assert_eq!(
        identical(&b, &movie("ha", 1), &sets[1].1, &[]).await,
        vec!["hb"]
    );
    assert!(identical(&a, &movie("ha", 1), &sets[0].1, &[])
        .await
        .is_empty());
    drop(busy);
    mirrors::age_records(&a.state, Duration::from_secs(3601))
        .await
        .unwrap();
    assert_eq!(
        identical(&a, &movie("ha", 1), &sets[0].1, &[]).await,
        vec!["hb"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn record_mismatch_in_both_modes() {
    let app = app().await;
    let panels = movie_panels(
        &app,
        &["xa", "xb"],
        &[Variant::Same, Variant::DiffersOutsideSamples],
        1,
        "Heat (1995)",
        PanelOptions::default,
    )
    .await;
    let (item, xb) = (movie("xa", 1), movie("xb", 1));
    let fp = fingerprint_of(&app, &item).await;
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["xb"]);
    let first = requests(&panels);

    // Between two non-authority sides: only the pairing goes, and the next
    // use asks xb again (which passes again: the samples agree).
    mirrors::record_mismatch(&app.state, &item, &xb, false).await;
    assert!(cached_identical(&app, &item).await.is_empty());
    assert_eq!(verdict(&app, &item, &xb).await, None);
    assert_eq!(verdict(&app, &xb, &item).await, None);
    let key = xb.clone();
    let gone = app
        .state
        .db_call(move |c| mirrors::cached_fingerprint(c, &key))
        .await
        .unwrap();
    assert_eq!(gone, None, "xb's fingerprint is asked for again");
    assert_eq!(identical(&app, &item, &fp, &[]).await, vec!["xb"]);
    let second = requests(&panels);
    assert_eq!(second[1], first[1] + 3);

    // Against the authority's bytes: Differs, under both keys, and xb is
    // never asked or used again.
    mirrors::record_mismatch(&app.state, &item, &xb, true).await;
    assert_eq!(verdict(&app, &item, &xb).await, Some(Verdict::Differs));
    assert_eq!(verdict(&app, &xb, &item).await, Some(Verdict::Differs));
    assert!(cached_identical(&app, &item).await.is_empty());
    assert!(cached_identical(&app, &xb).await.is_empty());
    assert!(identical(&app, &item, &fp, &[]).await.is_empty());
    assert_eq!(requests(&panels), second);
    // A mismatch on a pair nothing knows about is recorded too.
    let stranger = movie("nobody", 3);
    mirrors::record_mismatch(&app.state, &item, &stranger, true).await;
    assert_eq!(
        verdict(&app, &item, &stranger).await,
        Some(Verdict::Differs)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn has_candidates_is_quick_on_a_large_catalog() {
    const SOURCES: usize = 5;
    const PER_SOURCE: usize = 10_000;
    let app = app().await;
    let start = Instant::now();
    for s in 0..SOURCES {
        let source = format!("big{s}");
        let rows = (0..PER_SOURCE)
            .map(|i| {
                // Every source has every title, except a few of its own.
                let title = if i % 1000 == 0 {
                    format!("Only On {source} {i}")
                } else {
                    format!("Feature Film Number {i} ({})", 1950 + i % 70)
                };
                row(
                    &source,
                    ContentType::Movie,
                    &i.to_string(),
                    &title,
                    i as i64,
                )
            })
            .collect();
        put_rows(&app, &source, "xtream", ContentType::Movie, rows).await;
    }
    println!(
        "catalog: {} movies written in {:.1} s",
        SOURCES * PER_SOURCE,
        start.elapsed().as_secs_f64()
    );
    let lookups: Vec<(CopyRef, bool)> = (0..200)
        .map(|n| {
            let i = (n * 49 + 1) % PER_SOURCE;
            let copy = CopyRef::new(
                ItemRef::new(
                    format!("big{}", n % SOURCES),
                    ContentType::Movie,
                    i.to_string(),
                ),
                None,
            );
            (copy, !i.is_multiple_of(1000))
        })
        .chain([(
            CopyRef::new(ItemRef::new("big0", ContentType::Movie, "1000"), None),
            false,
        )])
        .collect();
    let (worst, mean) = app
        .state
        .db_call(move |c| {
            // Warm the statement cache, as a running app has.
            mirrors::has_candidates(c, &lookups[0].0)?;
            let mut worst = Duration::ZERO;
            let started = Instant::now();
            for (copy, want) in &lookups {
                let t = Instant::now();
                let got = mirrors::has_candidates(c, copy)?;
                worst = worst.max(t.elapsed());
                assert_eq!(got, *want, "{copy:?}");
            }
            Ok((worst, started.elapsed() / lookups.len() as u32))
        })
        .await
        .unwrap();
    println!(
        "has_candidates on {} movies: mean {:.3} ms, worst {:.3} ms",
        SOURCES * PER_SOURCE,
        mean.as_secs_f64() * 1000.0,
        worst.as_secs_f64() * 1000.0
    );
    // The contract is 5 ms; a debug build on a busy machine gets slack.
    assert!(worst < Duration::from_millis(50), "worst {worst:?}");
}
