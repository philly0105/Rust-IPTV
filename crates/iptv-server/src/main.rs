//! `iptv-server --port 7180 --data-dir <dir> --static <dist>` (SPEC C12).
//!
//! `iptv-server --health` checks a running server on the same port
//! (`GET /api/health`) and exits 0 when it is healthy; the Docker
//! HEALTHCHECK uses it because the runtime image has no curl.

use axum::serve::ListenerExt;
use clap::Parser;
use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::rpc::{build_router, init_all};
use iptv_core::AppState;
use iptv_server::guard::AllowedHosts;
use iptv_server::{Server, ServerOptions, DEFAULT_PORT, EVENT_CAPACITY};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
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
    /// Let /api/proxy, downloads, playlist and EPG fetches reach loopback and
    /// private-network hosts, not only each source's own host:port. The env
    /// value accepts true/false, 1/0, yes/no, on/off.
    #[arg(
        long,
        env = "IPTV_ALLOW_PRIVATE_TARGETS",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    allow_private_targets: bool,
    /// Extra host names the browser may use to reach the API (comma list,
    /// e.g. `tv.example.com,nas.local`; `*` disables the check). localhost
    /// and IP addresses always work; on a non-loopback bind the machine's
    /// host name is added too. Blocks DNS-rebinding attacks.
    #[arg(long = "allowed-hosts", env = "IPTV_ALLOWED_HOSTS", default_value = "")]
    allowed_hosts: String,
    /// Check the server listening on --port (GET /api/health) and exit 0 if
    /// it is healthy, 1 otherwise. Used by the Docker HEALTHCHECK.
    #[arg(long)]
    health: bool,
}

/// `--health`: probes `/api/health` on the configured port.
fn health_check(args: &Args) -> ExitCode {
    let host = match args.host {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let url = format!(
        "http://{}/api/health",
        std::net::SocketAddr::new(host, args.port)
    );
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("iptv-server --health: {e}");
            return ExitCode::FAILURE;
        }
    };
    let ok = rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .ok()?;
        let resp = client.get(&url).send().await.ok()?;
        let v: serde_json::Value = resp.error_for_status().ok()?.json().await.ok()?;
        v.get("ok").and_then(serde_json::Value::as_bool)
    });
    if ok == Some(true) {
        ExitCode::SUCCESS
    } else {
        eprintln!("iptv-server --health: {url} is not healthy");
        ExitCode::FAILURE
    }
}

fn main() -> ExitCode {
    let args = Args::parse();
    if args.health {
        return health_check(&args);
    }
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
    // Before init_all: restored downloads must already use the guarded client.
    iptv_server::install_server_mode(&app, args.allow_private_targets);
    init_all(app.clone()).await?;

    let static_dir = std::path::absolute(&args.static_dir).unwrap_or(args.static_dir.clone());
    if !static_dir.join("index.html").is_file() {
        tracing::warn!(static_dir = %static_dir.display(), "no index.html in the static dir; run `pnpm build` (the API still works)");
    }
    if !args.host.is_loopback() {
        tracing::warn!(host = %args.host, "listening beyond loopback: the API has no login, so keep this port on a trusted network or behind an authenticating reverse proxy");
    }
    if args.allow_private_targets {
        tracing::warn!("--allow-private-targets: the proxy, downloads and playlist/EPG fetches may reach any private-network host");
    }
    let mut allowed_hosts = AllowedHosts::parse(&args.allowed_hosts);
    if !args.host.is_loopback() {
        allowed_hosts.add_machine_hostname();
    }
    if allowed_hosts.allows_any() {
        tracing::warn!(
            "--allowed-hosts '*': any Host header is accepted, so DNS-rebinding protection is off"
        );
    } else {
        tracing::info!(extra = ?allowed_hosts.names(), "API accepts localhost, IP addresses and these host names");
    }

    let server = Server::new(
        app.clone(),
        Arc::new(build_router()),
        tx,
        ServerOptions {
            static_dir: static_dir.clone(),
            allow_private_targets: args.allow_private_targets,
            allowed_hosts,
            allow_cross_site: false,
            proxy_path: iptv_server::proxy::hls::PROXY_PATH.to_owned(),
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
    // TCP_NODELAY on every connection: without it a file body (a cached poster, a recording)
    // that follows its header in a second write waited for the client's delayed ACK, about
    // 40 ms per request on a kept-alive connection.
    let listener = listener.tap_io(|tcp| {
        if let Err(err) = tcp.set_nodelay(true) {
            tracing::trace!(%err, "set_nodelay failed");
        }
    });
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
    // Running recordings close their files and rows ("stopped: shutdown")
    // instead of being left as "recording" for the next start to repair.
    iptv_core::recording::shutdown(&app).await;
    // Lets the next start skip the large-database background check.
    iptv_core::db::note_clean_shutdown(&app.db_path());
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
