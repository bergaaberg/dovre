# What Dovre sends

Dovre doesn't report home on its own. There are no usage stats, no update checks and no error reports. Bino, GitHub and your packs talk to your own services with your own keys, never through Dovre's.

These calls are the only ones that reach Dovre's own services, and you can check each one yourself. See them in **Settings → What Dovre sends**, download the record as JSON there, or run `dovre bridge sent` on a machine.

| Call | Made by | To | Sends | When |
|---|---|---|---|---|
| Token refresh | The bridge on your machine | The server it was paired with (`https://dovre.dev` for Dovre Cloud): `POST /bridge/token` | `grant_type`, `refresh_token` | Before connecting, when the last sign-in token is under a minute from running out |
| Connect | The bridge | Your cockpit's `/bridge` (`<handle>.dovre.dev` on Dovre Cloud, your own host self-hosted) | A sign-in header | On start, and after a dropped connection |
| Frames | The bridge | Your cockpit's `/bridge` | `hello` (version), `state` (agents, runs and sessions: metadata only, never what a turn says), `topics` (which lists changed), `reply` (the answer to a call you made from the cockpit), `ping` | While connected |
| Pair / unpair | `dovre bridge login` / `logout` | The server you pair with: `POST /bridge/device`, `/bridge/token`, `/bridge/revoke` | handle, machine name, the device code, the refresh token to revoke | Only when you run the command |
| Sign-in keys | A hosted cockpit | Your sign-in issuer (Cloudflare Access, or `https://dovre.dev` on Dovre Cloud) | Nothing: a GET of public keys | When the cached keys run out |

## How it's recorded

- **On the machine:** the bridge writes each call to `sent.jsonl` in its data folder (`bridge-data/` under the bridge home). Each line holds when, host, path, purpose, size, the answer's status and the names of the fields sent, never their values. Frames are counted per hour by kind (a reply is counted with the call it answers, e.g. `reply:repos`). The record keeps 30 days.
- **In the cockpit:** the hub counts each frame that arrives, per hour, machine and kind, and keeps 30 days. Keep-alive pings are answered before they reach it, so only the machine's own record has those. The two records should agree.
- **The guarantee:** `test/sent.test.ts` fails if code in `src/bridge/` makes a network call without the recorder (`src/sent.ts`), if code in `src/` outside the few known places (demo links, this catalog, one header) names `dovre.dev`, or if the launcher calls out anywhere but its one recorded function. Add a new kind of call to `CATALOG` in `src/sent.ts` and to this page.
