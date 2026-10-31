//! The bundled SQLite is built without SQLITE_ENABLE_MEMORY_MANAGEMENT
//! (`LIBSQLITE3_FLAGS` in `.cargo/config.toml`). With it, every connection's
//! page cache lives in one process-wide LRU behind a global mutex taken on
//! every page fetch, so pooled queries running at the same time wait on
//! each other. A build that misses the config (cargo run from outside the
//! repository, or `LIBSQLITE3_FLAGS` set in the environment) fails here.

#[test]
fn bundled_sqlite_gives_each_connection_its_own_page_cache() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    let mut st = c.prepare("PRAGMA compile_options").unwrap();
    let options: Vec<String> = st
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(options.iter().any(|o| o == "THREADSAFE=1"), "{options:?}");
    assert!(
        !options.iter().any(|o| o == "ENABLE_MEMORY_MANAGEMENT"),
        "SQLite was built with ENABLE_MEMORY_MANAGEMENT; build from the repository so cargo reads .cargo/config.toml: {options:?}"
    );
}
