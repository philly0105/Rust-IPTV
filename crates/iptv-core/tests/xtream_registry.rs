//! `xtream::rpc::register` adds every C4 xtream command; `xtream::init`
//! registers the importer (amendment A1).

use iptv_core::model::SourceKind;
use iptv_core::rpc::RpcRouter;

#[path = "xtream_stub.rs"]
mod stub;

const C4_XTREAM: &[&str] = &[
    "xtream.sync",
    "xtream.vodDetail",
    "xtream.seriesDetail",
    "xtream.streamUrl",
    "xtream.catchupUrl",
    "xtream.shortEpg",
    "xtream.accountInfo",
    "xtream.test",
];

#[test]
fn register_adds_every_c4_xtream_command() {
    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    for name in C4_XTREAM {
        assert!(r.contains(name), "{name} not registered");
    }
    let xtream: Vec<_> = r
        .names()
        .into_iter()
        .filter(|n| n.starts_with("xtream."))
        .collect();
    assert_eq!(
        xtream.len(),
        C4_XTREAM.len(),
        "unexpected extra commands: {xtream:?}"
    );
    assert_eq!(iptv_core::xtream::rpc::COMMANDS.len(), C4_XTREAM.len());
}

#[tokio::test]
async fn init_registers_the_importer() {
    let (_dir, state, _rx) = stub::state().await;
    let imp = iptv_core::sources::importer(&state, SourceKind::Xtream).expect("xtream importer");
    assert_eq!(imp.kind(), SourceKind::Xtream);
}
