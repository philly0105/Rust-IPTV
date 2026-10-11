//! `iptv-mock --port 7290`

use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "iptv-mock", about = "Mock IPTV portals for tests")]
struct Args {
    /// Port to listen on (127.0.0.1).
    #[arg(long, env = "MOCK_PORT", default_value_t = 7290)]
    port: u16,
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let args = Args::parse();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await?;
    tracing::info!(port = args.port, "iptv-mock listening");
    axum::serve(
        listener,
        iptv_mock::router_with_base(format!("http://127.0.0.1:{}", args.port)),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
