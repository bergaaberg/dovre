# Self-hosting Dovre

Dovre is open source and runs wherever you put it. There are two ways to host it yourself:

| | **Cloudflare Workers** (the easy path) | **Your own server** (VPS, home server, any cloud) |
|---|---|---|
| What runs | The hosted build on Workers + D1, behind Cloudflare Access | The ordinary Node server and SQLite, behind a sign-in proxy you choose |
| Setup | Scripted: `pnpm instance new` + `pnpm instance provision --deploy` (README, "Run it hosted") | A Docker image or a systemd unit, plus a proxy (this page) |
| Agents and terminals | On your laptop, through `dovre bridge` | On the server itself, in its checkouts |
| Cost | Cloudflare's free tier covers one person | Whatever the box costs |

Pick Cloudflare if you want the least to look after. Pick a server if you want everything on hardware you control, or agents running next to your code around the clock. Nothing in Dovre ties the server path to Cloudflare.

## Your own server

### Read this first

On a server, Dovre runs in local mode: terminals and agent turns run programs as the user Dovre runs as. **Whatever reaches Dovre's address reaches them.** So:

- Dovre listens on `127.0.0.1:4848` only. Never publish that port on a public address.
- A reverse proxy on the same machine is the only way in, and it **must** ask for a sign-in first (oauth2-proxy, Tailscale's identity, Cloudflare Access, …). The launch token is a second lock, not the only one.
- `PUBLIC_ORIGIN` names the one address the proxy serves Dovre at. Dovre then answers at that host and takes writes from that origin, still with its launch cookie. Unset, Dovre refuses every name but `localhost`.

### 1. Run Dovre

**With Docker** (`Dockerfile`, `deploy/compose.yaml`):

```bash
git clone https://github.com/bergaaberg/dovre && cd dovre
cp deploy/dovre.env.example deploy/dovre.env   # PUBLIC_ORIGIN, GITHUB_TOKEN, REPO_OWNERS
DOVRE_CODE=/srv/code docker compose -f deploy/compose.yaml up -d --build
```

The image includes the agent host, so terminals work. Coding agents (`claude`, `codex`, …) aren't in it: build your own image `FROM` this one and install the ones you use.

**Without Docker** (Node 24, pnpm, git): `deploy/dovre.service` is a systemd unit. Its comments have the install steps.

### 2. Put a sign-in in front

Any of these work. Each one serves Dovre at an https address; put that address in `PUBLIC_ORIGIN` and restart Dovre.

**Caddy + oauth2-proxy** (any VPS, sign in with GitHub, Google, …): `deploy/Caddyfile.example`. Run [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) on `127.0.0.1:4180` with `--reverse-proxy --set-xauthrequest` and an email allow-list, then:

```
PUBLIC_ORIGIN=https://dovre.example.com
```

**Tailscale Serve** (only devices on your tailnet; no public address at all):

```bash
tailscale serve --bg 4848
# PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net
```

**Cloudflare Tunnel + Access** (no open ports; Cloudflare in front, Dovre on your box): point a tunnel's ingress at `http://localhost:4848`, and add an Access application with an email policy on the same hostname *before* you start the tunnel.

```
PUBLIC_ORIGIN=https://dovre.example.com
```

Not fine: ngrok or any public tunnel without a sign-in in front. The bare URL reaches the login page and the terminals.

### 3. Sign in once

Get the launch token, then open the login link through the proxy:

```bash
docker compose -f deploy/compose.yaml exec dovre cat data/launch-token   # or: cat /opt/dovre/app/data/launch-token
# then: https://dovre.example.com/login?tk=<token>
```

Settings → Setup shows **Public address** in amber while `PUBLIC_ORIGIN` is set, as a reminder of what it opens.

### What Dovre checks behind the proxy

- **Host** must be `localhost`, `127.0.0.1`, `[::1]`, or exactly `PUBLIC_ORIGIN`'s host and port. Another port, a longer or shorter name: `404`. The proxy may keep the browser's Host (Caddy and cloudflared do) or rewrite it to `localhost`. Both work.
- **Cookie:** the launch cookie, `Secure` when it was set at an https `PUBLIC_ORIGIN`.
- **Origin, on writes:** this app's own origin or exactly `PUBLIC_ORIGIN`. Terminals refuse a write with no Origin, and a request another site started gets a `404`.
- `PUBLIC_ORIGIN` is read from the environment or `.dev.vars` only, never from the Settings page, and a malformed one (a path, a wildcard, a login in the URL) stops Dovre from starting.
