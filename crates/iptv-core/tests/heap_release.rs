//! [`iptv_core::memory::release_freed_heap`] returns memory an import freed
//! to the OS on glibc, where a block allocated after the import's rows and
//! still alive (a SQLite page-cache page) keeps the arena from shrinking.

#[cfg(all(target_os = "linux", target_env = "gnu"))]
const MB: usize = 1024 * 1024;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn rss() -> usize {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem)
        .unwrap_or(0)
}

/// On a thread of its own, like the blocking-pool thread an import decodes
/// and writes on (glibc gives it its own arena): about 200 MB of small
/// blocks, like an import's decoded rows, then a block that stays alive,
/// then the rows freed. Returns the RSS with the rows resident, and the
/// live block.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn import_rows_then_free() -> (usize, Vec<u8>) {
    std::thread::spawn(|| {
        let rows: Vec<Vec<u8>> = (0..400_000).map(|i| vec![1 | i as u8; 512]).collect();
        let pin = vec![1u8; 4096];
        let filled = rss();
        drop(rows);
        (filled, pin)
    })
    .join()
    .unwrap()
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn freed_rows_below_a_live_block_go_back_to_the_os() {
    let before = rss();
    let mb = |b: usize| b.saturating_sub(before) / MB;
    let (filled, pin) = import_rows_then_free();
    let freed = rss();
    iptv_core::memory::release_freed_heap();
    let trimmed = rss();
    eprintln!(
        "heap_release: RSS over the start: {} MB filled, {} MB after the free, {} MB after the trim",
        mb(filled),
        mb(freed),
        mb(trimmed)
    );
    assert!(mb(filled) > 150, "the rows were not resident");
    assert!(
        mb(freed) > 100,
        "glibc returned the freed rows by itself; this test no longer covers the trim"
    );
    assert!(mb(trimmed) < 30, "the trim kept {} MB", mb(trimmed));
    drop(pin);

    // A trim queued on a runtime that shuts down before it runs it (a
    // test's runtime ending, the app quitting) is dropped unrun; it must not
    // pass for the trim of the imports that follow.
    let gone = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .handle()
        .clone();
    {
        let _in = gone.enter();
        iptv_core::memory::release_freed_heap_soon();
    }

    // The queued variant the import paths call, twice in a row: the second
    // import's trim must run too, not be taken for the first one's.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .build()
        .unwrap();
    for round in 1..=2 {
        let (_, pin) = import_rows_then_free();
        assert!(mb(rss()) > 100, "round {round}: glibc returned the rows");
        rt.block_on(async { iptv_core::memory::release_freed_heap_soon() });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while mb(rss()) >= 30 {
            assert!(
                std::time::Instant::now() < deadline,
                "round {round}: the queued trim kept {} MB",
                mb(rss())
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(pin);
    }
}
