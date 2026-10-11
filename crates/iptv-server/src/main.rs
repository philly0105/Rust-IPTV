//! `iptv-server --port 7180 --data-dir <dir> --static <dist>` (SPEC C12).

use clap::Parser;
use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::rpc::{build_router, init_all};
use iptv_core::AppState;
use iptv_server::{Server, ServerOptions, DEFAULT_PORT, EVENT_CAPACITY};
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// How long in-flight requests (long media streams) get after a shutdown signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

#[derive(Parser, Debug)]
#[command(
    name = "iptv-server",
    version,
    about = "Tsrust IPTV server mode: the UI plus /api for browsers"
)]
struct Args {
    /// Port to listen on.
    #[arg(long, env = "PORT", default_value_t = DEFAULT_PORT)]
    port: u16,
    /// Interface to bind. Anything other than loopback exposes an API without
    /// login; use 0.0.0.0 only in a container or behind an authenticating proxy.
    #[arg(long, env = "IPTV_HOST", default_value = "127.0.0.1")]
    host: IpAddr,
    /// App data directory (database, logs, downloads).
    #[arg(long = "data-dir", env = "IPTV_DATA_DIR", default_value = "./data")]
    data_dir: PathBuf,
    /// Built UI directory (output of `pnpm build`).
    #[arg(long = "static", env = "IPTV_STATIC_DIR", default_value = "./dist")]
    static_dir: PathBuf,
    /// Let /api/proxy reach loopback and private-network hosts for every
    /// source, not only each source's own host.
    #[arg(long, env = "IPTV_ALLOW_PRIVATE_TARGETS")]
    allow_private_targets: bool,
}

fn main() -> ExitCode {
    let args = Args::parse();
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("iptv-server: cannot start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(run(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %e, "iptv-server failed");
            eprintln!("iptv-server: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let _log_guard = iptv_core::logging::init(&args.data_dir)?;

    let (tx, _) = broadcast::channel::<AppEvent>(EVENT_CAPACITY);
    let app = AppState::new(
        args.data_dir.clone(),
        Arc::new(BroadcastSink(tx.clone())),
        false,
    )
    .await?;
    init_all(app.clone()).await?;

    let static_dir = std::path::absolute(&args.static_dir).unwrap_or(args.static_dir.clone());
    if !static_dir.join("index.html").is_file() {
        tracing::warn!(static_dir = %static_dir.display(), "no index.html in the static dir; run `pnpm build` (the API still works)");
    }
    if !args.host.is_loopback() {
        tracing::warn!(host = %args.host, "listening beyond loopback: the API has no login, so keep this port on a trusted network or behind an authenticating reverse proxy");
    }
    if args.allow_private_targets {
        tracing::warn!("--allow-private-targets: /api/proxy may reach any private-network host");
    }

    let server = Server::new(
        app,
        Arc::new(build_router()),
        tx,
        ServerOptions {
            static_dir: static_dir.clone(),
            allow_private_targets: args.allow_private_targets,
            loopback_host_only: args.host.is_loopback(),
        },
    );

    let listener = tokio::net::TcpListener::bind((args.host, args.port))
        .await
        .map_err(|e| {
            format!(
                "cannot listen on {}:{}: {e}{}",
                args.host,
                args.port,
                if e.kind() == std::io::ErrorKind::AddrInUse {
                    " (another process uses this port; pass --port or set PORT)"
                } else {
                    ""
                }
            )
        })?;
    let addr = listener.local_addr()?;
    tracing::info!(%addr, static_dir = %static_dir.display(), version = AppState::version(), "iptv-server listening on http://{addr}");

    let on_signal = server.clone();
    let serve = axum::serve(listener, iptv_server::router(server.clone())).with_graceful_shutdown(
        async move {
            shutdown_signal().await;
            tracing::info!("shutdown requested; closing event sockets and draining requests");
            on_signal.begin_shutdown();
        },
    );

    tokio::select! {
        r = async { serve.await } => r?,
        _ = async {
            server.shutdown_requested().await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => tracing::warn!(grace_secs = SHUTDOWN_GRACE.as_secs(), "open streams did not finish in time; exiting"),
    }
    tracing::info!("iptv-server stopped");
    Ok(())
}

/// Ctrl-C everywhere; SIGTERM too on Unix (Docker stop).
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "cannot listen for ctrl-c");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}
