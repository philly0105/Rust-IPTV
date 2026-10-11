//! `stalker::rpc::register` adds exactly the C4 `stalker.*` commands, and
//! `stalker::init` registers the importer (amendment A1).

use iptv_core::events::NoopSink;
use iptv_core::model::SourceKind;
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use std::sync::Arc;

const C4_NAMES: [&str; 11] = [
    "stalker.sync",
    "stalker.movies",
    "stalker.series",
    "stalker.vodDetail",
    "stalker.seriesDetail",
    "stalker.streamUrl",
    "stalker.catchupUrl",
    "stalker.epg",
    "stalker.search",
    "stalker.accountInfo",
    "stalker.test",
];

#[test]
fn register_adds_every_c4_stalker_command() {
    let mut r = RpcRouter::new();
    iptv_core::stalker::rpc::register(&mut r);
    for name in C4_NAMES {
        assert!(r.contains(name), "missing {name}");
    }
    let mut expected: Vec<&str> = C4_NAMES.to_vec();
    expected.sort_unstable();
    assert_eq!(r.names(), expected, "register adds exactly the C4 names");
    let mut listed = iptv_core::stalker::rpc::COMMANDS.to_vec();
    listed.sort_unstable();
    assert_eq!(listed, expected);
}

#[tokio::test]
async fn init_registers_the_stalker_importer() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    assert!(iptv_core::sources::importer(&state, SourceKind::Stalker).is_none());
    iptv_core::stalker::init(state.clone()).await.unwrap();
    let imp =
        iptv_core::sources::importer(&state, SourceKind::Stalker).expect("importer registered");
    assert_eq!(imp.kind(), SourceKind::Stalker);
}
