# syntax=docker/dockerfile:1.7
#
# Tsrust IPTV server mode: the web UI plus /api in one small image.
#
#   docker build -t tsrust-iptv .
#   docker run --rm -p 127.0.0.1:7180:7180 -v tsrust-iptv-data:/data tsrust-iptv
#
# The API has no login. Publish the port on loopback (as above) or put an
# authenticating reverse proxy in front. See docs/architecture/server.md.

# ---- 1. Web UI (vite build -> /src/dist) -----------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY index.html vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
RUN pnpm build

# ---- 2. Server binary ------------------------------------------------------
# rust-toolchain.toml is not copied: the image's toolchain is used as-is.
FROM rust:1.96-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=tsrust-target,target=/src/target \
    cargo build --release --locked -p iptv-server \
 && install -m 0755 target/release/iptv-server /usr/local/bin/iptv-server

# ---- 3. Runtime ------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 iptv \
 && useradd --system --uid 10001 --gid iptv --home-dir /data --shell /usr/sbin/nologin iptv \
 && mkdir -p /data /app \
 && chown iptv:iptv /data

COPY --from=server /usr/local/bin/iptv-server /usr/local/bin/iptv-server
COPY --from=web /src/dist /app/dist

# Bind all interfaces inside the container; the data dir is the volume.
# IPTV_ALLOWED_HOSTS: extra host names (comma list) the browser may use to
# reach the API, e.g. "tv.example.com" behind a reverse proxy. localhost and
# IP addresses always work; any other Host header gets 403 (DNS-rebinding
# protection). Set IPTV_ALLOW_PRIVATE_TARGETS=true to let the proxy and
# downloads reach LAN hosts other than each source's own host:port.
ENV PORT=7180 \
    IPTV_HOST=0.0.0.0 \
    IPTV_ALLOWED_HOSTS="" \
    IPTV_DATA_DIR=/data \
    IPTV_STATIC_DIR=/app/dist \
    RUST_LOG=info

VOLUME ["/data"]
EXPOSE 7180
USER iptv:iptv
WORKDIR /data

# The runtime image has no curl; the binary probes its own /api/health.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/iptv-server", "--health"]

# tini forwards SIGTERM (docker stop) and reaps children; the server drains
# open requests for up to 10 s before exiting.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/iptv-server"]
