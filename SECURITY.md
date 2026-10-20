# Security policy

## Reporting a vulnerability

Please do not put the details of a vulnerability in a public issue. Open an issue titled "Security contact" that names only the part affected (desktop app, server mode, or the release files), and the maintainer will reply with a private way to send the report.

<!--
Owner: once private vulnerability reporting is on (repository Settings, under
"Advanced Security" or "Code security", or
`gh api -X PUT repos/philly0105/Rust-IPTV/private-vulnerability-reporting`),
replace the paragraph above with:

Report it privately through GitHub: open the repository's Security tab and choose "Report a vulnerability". Only the maintainer sees the report, and the fix is discussed in that private advisory. Please do not open a public issue for a vulnerability.
-->

A useful report says:

- which version, and whether the desktop app or server mode (and how the server is exposed: loopback, LAN, behind a proxy);
- what an attacker needs (a web page the user visits, a device on the same network, a malicious playlist or provider, local access);
- the steps or a proof of concept, and what happens.

Reports about third-party components (mpv, Tauri, WebView2, a Rust crate or npm package) are welcome when Tsrust IPTV's use of them is the problem. Otherwise please report them upstream too.

## Supported versions

Security fixes go into the newest release only. Update to it before reporting, if you can.

| Version | Fixes |
| --- | --- |
| Latest release | Yes |
| Anything older | No |

## Security model in brief

Tsrust IPTV plays streams from sources the user adds. Playlists, guides and provider answers are untrusted input. They are parsed as streams, downloads that stall or trickle are dropped, and player launches reject URLs that start with `-` or use schemes outside a fixed list.

### Server mode (`iptv-server`, the Docker image)

Server mode has no login and no TLS of its own. Its defaults keep it local, and anything beyond that needs a reverse proxy that adds HTTPS and authentication. [deploy/](deploy/README.md) has a ready setup with Caddy.

- It binds 127.0.0.1 unless `--host` says otherwise. The Docker image binds all interfaces inside the container; publish its port on loopback or only to the proxy.
- `/api` answers only when the `Host` header is `localhost`, an IP address, or a name in `IPTV_ALLOWED_HOSTS`. This blocks DNS rebinding.
- State-changing requests and WebSocket upgrades from another origin, and any request the browser marks `Sec-Fetch-Site: cross-site`, get 403. No CORS headers are sent.
- The stream proxy and the server's own fetches refuse loopback, private, link-local (cloud metadata included) and other non-public addresses, except the source's own host and port, unless `--allow-private-targets` is set. The exception covers that exact port only: the same host name on another port is fetched like any other address. Names are checked again when the connection is made, so they cannot rebind to a private address.
- Clients cannot make the server read or write its own files: file sources, `file://` URLs and a custom downloads folder are refused.
- The interface is served with a restrictive Content-Security-Policy, `X-Frame-Options: SAMEORIGIN` and `nosniff`.

Anyone who can reach the API can use every source and setting, so the proxy's password is the access control. Details: [docs/architecture/server.md](docs/architecture/server.md#security).

### Desktop app

- The loopback media proxy listens on 127.0.0.1 under a random per-launch token, and only the app's own webview origin may read its responses. See [docs/architecture/desktop.md](docs/architecture/desktop.md).
- The remote control listens on 127.0.0.1 only. "Allow phones on this network" (off by default) adds the computer's private addresses; a phone must pair with a one-time QR code that expires after 5 minutes, and paired phones can be revoked. See [docs/architecture/remote-control.md](docs/architecture/remote-control.md).
- Provider logins (Xtream passwords, Stalker MACs, playlist URLs with tokens) are stored unencrypted in the app's SQLite database under `%APPDATA%\com.philly.tsrustiptv`. Logs redact them. Backups leave passwords out unless "Include passwords and keys" is ticked.
- The parental PIN is stored as a PBKDF2 hash, with a lockout after wrong entries. It keeps content away from children; it is not protection against someone with access to the computer's files.

### Releases

Installers are built by GitHub Actions from a version tag (`.github/workflows/release.yml`). They are not code-signed yet, and the auto-updater is off, so the app never downloads or installs code by itself. The same workflow pushes the server image to `ghcr.io/philly0105/tsrust-iptv` under its version; the `latest` tag moves to it only when the release is published (`.github/workflows/image-latest.yml`).
