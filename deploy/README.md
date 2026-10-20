# Running the server for phones, TVs and other computers

`iptv-server` serves the Tsrust IPTV interface to browsers. It has no login of its own, and it speaks plain HTTP. That is fine on the machine it runs on (`http://127.0.0.1:7180`), but not for the other devices in your home. This folder runs it behind [Caddy](https://caddyserver.com), which adds HTTPS and a password:

| File | What it does |
| --- | --- |
| `compose.yaml` | Two containers: the app (`ghcr.io/philly0105/tsrust-iptv`) with its data volume, and Caddy, the only one with published ports (80 and 443) |
| `Caddyfile` | HTTPS for your host name, a password prompt (`basic_auth`), and the proxy to the app |
| `.env.example` | The settings you fill in: host name, certificate mode, user name and password hash |

## Why HTTPS

Browsers switch several features off on plain `http://` pages that are not `localhost`. Over `http://192.168.1.20:7180` you lose:

- Installing the app (the PWA install button) and its offline start: the service worker only registers on a secure origin.
- The copy buttons (stream address, remote link, About details): `navigator.clipboard` does not exist there.
- Browser notifications for guide reminders.
- ClearKey-protected M3U channels: the browser's DRM interface (EME) only runs on a secure origin.

With Caddy in front, the browser sees `https://` and all of these work.

## Why a password

Anyone who can open the server can browse and play your sources, see their addresses and logins, change settings, and delete sources. The server checks the `Host` and `Origin` headers, which stops other websites from using it through your browser, but nothing stops another person on the network. The password prompt does.

## Set it up

You need Docker with Compose v2 on a machine that stays on, and a name or address for it that every device can reach.

1. Copy the settings file and open it:

   ```sh
   cp .env.example .env
   ```

2. Set `TSRUST_HOST` to what people will type in the browser, without `https://`: an IP address (`192.168.1.20`), a name your router or DNS resolves (`nas.lan`), or a public domain (`tv.example.com`). Several names work too, separated by commas: `nas.lan, 192.168.1.20`.

3. Make a password hash. The command asks for the password twice and prints the hash:

   ```sh
   docker run --rm -it caddy:2 caddy hash-password
   ```

   Put it in `.env` inside single quotes, because the hash contains `$` signs:

   ```sh
   TSRUST_USER=tv
   TSRUST_PASSWORD_HASH='$2a$14$...'
   ```

4. Choose the certificate mode with `TSRUST_TLS` (next section), then start it:

   ```sh
   docker compose up -d
   ```

5. Open `https://<TSRUST_HOST>` and log in.

Compose passes `TSRUST_HOST` to the app as `IPTV_ALLOWED_HOSTS`, the list of names the API answers to. If you later reach the server under another name, add it to `TSRUST_HOST` and run `docker compose up -d` again; otherwise the app answers "This host name is not allowed".

## Certificates

### On your home network: `TSRUST_TLS=internal`

Caddy makes its own certificate authority and signs a certificate for `TSRUST_HOST`. Browsers do not know that authority yet, so they warn, and Chrome and Edge refuse to install the app until the device trusts it. Copy the root certificate out of the Caddy container once:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Then install `caddy-root.crt` as a trusted root certificate on each device:

- Windows: double-click it, Install Certificate, Local Machine, "Place all certificates in the following store", Trusted Root Certification Authorities.
- macOS: open it in Keychain Access, then set Trust to Always Trust.
- Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate.
- iPhone and iPad: open the file to install the profile, then turn it on under Settings > General > About > Certificate Trust Settings.

The root certificate lives in the `caddy-data` volume, so it survives updates. Caddy renews the site certificate by itself.

### On a public domain: `TSRUST_TLS=you@example.com`

Point the domain's DNS at the machine and forward ports 80 and 443 to it. Caddy then gets a Let's Encrypt certificate for `TSRUST_HOST` and renews it; the e-mail address is for expiry notices from Let's Encrypt. No device needs any setup. Choose a strong password: the login page is now on the internet.

## Day to day

- Update: `docker compose pull && docker compose up -d`. To stay on one version, set `TSRUST_VERSION=0.2.0` (or another tag) in `.env`.
- Data: sources, settings, the image cache, downloads and recordings are in the `tsrust-data` volume, at `/data` inside the app container. Settings > Backup in the app exports your sources and lists as a file. To copy downloads out: `docker compose cp tsrust-iptv:/data/downloads ./downloads`.
- Logs: `docker compose logs -f tsrust-iptv`. The app also writes rotating JSON logs to `/data/logs`.
- Recording works in the container: the image includes mpv for it. Files go to `/data/downloads/recordings`.
- On private addresses, the server only fetches from each source's own host and port. A playlist on your NAS works, but if its streams, guide or logos come from another machine on your network (a tvheadend box, say), add `IPTV_ALLOW_PRIVATE_TARGETS: "true"` under the app's `environment` in `compose.yaml`.

## Other setups

Any reverse proxy that serves HTTPS and asks for a login works the same way: Traefik, nginx, Tailscale Serve, or Caddy with `forward_auth` to a single sign-on service. Two rules hold for all of them:

- Set `IPTV_ALLOWED_HOSTS` to the host name the browser uses. Do not set it to `*`, which turns off the DNS-rebinding check.
- Keep the app's port 7180 off the network. Publish it on loopback only (`-p 127.0.0.1:7180:7180`) or not at all, so the proxy is the only way in.

The browser fetches `/manifest.webmanifest` and the icons under `/icons/` without sending the login, so leave those two paths open if you want the install button. They contain nothing private.

[docs/architecture/server.md](../docs/architecture/server.md) has the server's flags and its security model in detail.
