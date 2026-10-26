# Reaching local Dovre from another machine

Local Dovre listens on `127.0.0.1:4848` only and answers nothing else. This page covers how to reach it from a laptop, or a phone, without opening that port to the internet.

## Read this first

Terminals and agent turns run local programs as you. **Anything that can reach Dovre can reach them.** The launch token is a single secret. Treat every path below as a way into your account on this machine: keep an auth layer (SSH keys, a tailnet's identity, an access policy) in front of it, and never expose the port itself.

## What local mode checks

Every request, from anywhere:

1. **Host** must be `localhost`, `127.0.0.1` or `[::1]` (any port), or exactly `PUBLIC_ORIGIN`'s host when that's set. Anything else gets a `404`. This stops DNS rebinding (`src/access.ts`).
2. **Cookie:** the launch-token cookie (`u_tk`). You get it by opening `/login?tk=<token>` once. The token is in `data/launch-token` (or `LAUNCH_TOKEN` in `.dev.vars`).
3. **Origin, on writes:** a form post whose `Origin` names another host gets a `403`. Terminals go further (`src/strict.ts`): every write needs an `Origin` that equals the page's own, and a cross-site request gets a `404`.

So whatever sits in between must leave the browser on a `localhost` address. A proxy that only rewrites `Host` isn't enough: the browser still sends its own `Origin`, and every write is refused.

## SSH port forwarding: works today

The browser opens `http://localhost:<port>` on its own machine, and SSH carries the traffic to the Mac's `127.0.0.1:4848`. Host and Origin are both `localhost`, so all three checks pass unchanged, terminals included.

```bash
# On the machine you're browsing from (any free local port works):
ssh -N -L 4848:127.0.0.1:4848 you@your-mac
# Then, once, to get the cookie:
open "http://localhost:4848/login?tk=$(ssh you@your-mac cat ~/src/dovre/data/launch-token)"
```

- **What protects it:** SSH's own authentication (use keys, turn off password login). Nothing new listens on the network.
- **What it doesn't:** anyone with a shell on the browsing machine can use the forwarded port while it's open. Close the tunnel when you're done.
- **Over the internet:** reach the Mac's SSH over a private network rather than a public port. WireGuard or a Tailscale tailnet both work: `ssh -L …` to the Mac's private address. Dovre itself stays on `127.0.0.1`.
- **From a phone:** an SSH client with local port forwarding (Termius, Blink and others) does the same; then open `http://localhost:4848` in the phone's browser. On iOS the client must stay in the foreground or keep its tunnel alive in the background.

## Tunnels and reverse proxies: with PUBLIC_ORIGIN

Cloudflare Tunnel with Access, Tailscale Serve and reverse proxies all put Dovre at a public name (`https://dovre.example.com`). Local mode refuses that name until you set `PUBLIC_ORIGIN` to exactly that address. Then Dovre answers at it and takes writes from it, still with the launch cookie. The recipes, and what has to sit in front, are in [SELF-HOST.md](SELF-HOST.md#2-put-a-sign-in-in-front); they work the same on a Mac as on a server.

- **ngrok and similar public tunnels** are never acceptable without an auth layer in front, because the URL alone reaches the login page and the terminals.
- **Hosted Dovre** (Cloudflare Workers with Access, see the README) is the other way to use Dovre from anywhere. Local terminals never run there.
