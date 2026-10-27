# Dovre's architecture: core, packs, instances

How Dovre is put together after WP-H9a–e (2026-10-25), and how to extend it. PLAN.md holds the
decisions (D15, D22, D23) and their history; README.md's "A pack's shape" describes each hook in
detail. This document sits between them: the parts, how a pack gets from a folder to a page,
what the core promises, and what is still open.

## The three layers

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Instance repo (one per machine / setup)                                  │
 │   my-dovre: hosted Cloudflare Worker      acme-dovre: local workstation  │
 │   packs/<id>/ …   packs.ts   worker.ts + wrangler config   .dev.vars     │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │ imports core as `dovre/…` (pnpm link:), never the other way
 ┌───────────────▼──────────────────────────────────────────────────────────┐
 │ Core's own packs (src/packs/core/): agents, assistant, terminal, docker  │
 │   the same shape and hooks as any pack; only the entry points add them   │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ Core (this repo)                                                         │
 │   shell + kit, hub (live.ts), gather + snapshot, agent runner (desk),    │
 │   search, My list, Bino, notifications, actions log, Settings            │
 │   src/packs/types.ts   the contract (PACK_API = 1)                       │
 │   src/packs/registry.ts the core's side of every hook                    │
 └──────────────────────────────────────────────────────────────────────────┘
```

- **Core** holds what every Dovre needs, whatever apps it works with. It never names, imports or
  defaults to an instance or an instance's pack.
- **Core's own packs** (agents, assistant, terminal, docker) are features of core built as packs, so
  they can be switched off and nothing reaches them except through hooks. A test
  (test/packs.test.ts) fails if anything in core other than the entry points imports them.
- **An instance** is a repo (`../my-dovre`) with one machine's or team's packs and config. Neither instance ever touches another machine's data.

### The two entry points

| | Local (`src/index.ts`) | Hosted (`src/worker.ts`) |
|---|---|---|
| Where the packs come from | `PACKS` in .dev.vars: folders, each one's `packs.ts` imported at start (src/packs/load.ts) | The instance's own worker.ts calls `createWorker({ packs })`; esbuild bundles them |
| Core's packs | agents, assistant (Bino and Atlas), terminal (when terminals run), docker (when its pane is on) | agents (the Mac's sessions, over the bridge), assistant (Bino, no Atlas) |
| Refresh | an interval, checked every 30 s | after a response (`waitUntil`) and on cron |
| Also | `callback` (an OAuth return), `ingest` (apps POST in), `acts` (Bino's proposals) | `scheduled` (cron), `email` (Email Routing) |

Both put core's packs first, then the instance's, and hand the list to `activePacks`.

### The public demo entry (`createDemoWorker`)

The public demo (`demo.dovre.dev`) runs from its own instance repo, through a third, safety-bounded entry point: `createDemoWorker({ packs, settings, answers, fixtures, allowWrite, layout, version })` exported from `dovre/demo/worker.ts`. Core has no demo deploy of its own.

It keeps core's safety boundary intact:
- **No real bindings:** reads zero secrets, no real D1, no Cloudflare Access, and no bridge (`/bridge` returns 404).
- **In-memory empty D1:** every database read returns empty results; every write is dropped.
- **Isolated open door:** bypasses authentication only for the visitor identity (`visitor@demo.dovre.dev`); this bypass cannot be enabled in a real instance by any setting.
- **Strict write boundary:** every non-`GET`/`HEAD` request returns a 403 read-only page except asking the scripted Bino, and what `allowWrite(req)` permits.
- **Pluggable demo packs and fixtures:** the calling demo repo supplies fictional fixtures and packs, while core ensures isolation. A real pack runs on made-up data when the demo gives it a fake `fetch`, made-up values for its required `settings` (never real secrets), and its refresh runs before each page when it's due. `answers` adds scripted Bino answers (say, about that pack's data) ahead of core's own.

## A pack's life

1. **Declared.** A pack is an object: a `manifest` and the hooks it answers. A packs module's
   default export is a list of packs, or a function from the instance's settings to that list.
2. **Loaded.** Local: `loadPacks` imports each folder in `PACKS`. A folder that fails to import
   becomes an "off" row with the error, and the rest still load.
3. **Sorted** (`activePacks`). Each pack is checked in this order, and the first failure keeps it
   off, with the reason shown on the Packs page:
   - its id is lowercase and unique;
   - it was written for this `PACK_API`;
   - `PACK_<ID>` isn't `off`;
   - its `execution` fits (local-only, hosted-only, any);
   - hosted, its `requiredBindings` exist; local, its `requiredBinaries` are on PATH;
   - its required settings are set.
4. **Mounted** (`createApp`). Each pack gets its own `PackContext` (`ctxOf`). A pack whose
   `available` answers no (or throws) is off now, saying so, before anything of it is mounted. Its routes go on a
   sub-app of their own, mounted after the guard and every core route. The mount is refused if a
   route is outside `/<id>` and the manifest's `paths`, if a path is a core path or another
   pack's, or if `routes` throws. The packs' `styles` are served as one hashed stylesheet, and their `script`s as one
   hashed script after the core's (a block each), which hears the core through `dovre:change`
   and `dovre:swap` events on `document`.
5. **Started** (`initAll`). A pack whose `init` throws is taken off.
6. **Refreshed** (`refresher`). On the pack's `everyMs` (default 5 min), one run at a time per
   pack. A run that takes longer than `maxMs` is given up, and the next due one starts again.
   Each run's start, end and error go to the Packs page.
7. **Hidden or off.** Settings → Layout hides a pack. A hidden pack drops out of every hook,
   its routes answer 404, and it isn't refreshed. `PACK_<ID>=off` keeps it from loading at all.

## The contract

`src/packs/types.ts` is the whole contract.

**What a pack gets** (`PackContext`):
- `env`, `bindings`, `hosted`, `db`;
- `publish(topics)` to tell open pages that a region changed;
- `snapshot()` and `gathered()`: what the gather fetched from the forge (GitHub, or a pack's);
- `fill(slot, arg)` to host other packs' slots on its own pages;
- `page()` and `dockPage()` to draw inside Dovre's shell;
- `log()`, and `ring()` for a one-off notification;
- `ask()` to put a question in the bar at the top of every page and wait for my answer (an MCP
  server's, such as a database CLI's before it opens production; local only), and `asking()`.

**What a pack answers**, grouped by where it lands:

| Where | Hooks | Timing |
|---|---|---|
| Its own pages | `routes`, `styles`, `script`, `nav`, `paths` (manifest) | routes on request |
| Today | `today` (cards), `glance`, `brief`, `lane`, `feed` | cards: 250 ms for all; the rest from memory |
| Stats | `stats` (PackStat: a chart over labels with one or two series, or a headline number; `unit`, `empty`), shown, hidden and ordered on Settings → Look and layout with core's own | from memory |
| Search | `pages`, `finds` (with `kind`: agents, code, actions) | from memory |
| Attention | `needs` (+ manifest `rings`), `ctx.ring`, `banner`, `dock` (with a `key` letter) | from memory |
| Bino | `bino`, `about` (not asked for a manifest-`private` pack), `acts` (local only) | from memory; an act's `run` in the background |
| Core pages | `slots` (SlotMap: thirteen places) | from memory |
| Links | `refs` (ticket keys in text), `linked` (PR links for the gather to look up) | from memory |
| Settings | `settings` panel, manifest `settings` keys | from memory |
| Forge | `ctx.forge()`: who I am, the owners, and what the forge answers packs (`work`, `merged`); read-only | on request |
| Starting page | `ctx.startPicture(svg)`: a picture beside the starting page (local) | when it changes |
| Pulse | `pulse` (old name `avatar`): working / asking counts, trouble (storm or fire, why, link), on duty; any pack reads the sum as `ctx.pulse()` | from memory |
| Lifecycle | `available`, `init`, `refresh`, `beforePage`, `dispose` | `beforePage`: 1.5 s for all |
| Outside callers | `callback` (local), `ingest` (token), `scheduled`, `email` (hosted) | as the platform calls |
| The forge | `forge` (`ForgeDecl`, `src/forge/types.ts`): PRs/MRs, CI, notifications, movement and deploys instead of GitHub when `FORGE` is its id | made once at start, before `init` |

**The time rule:** anything drawn on a page answers from memory. A pack reads its app in
`refresh` (or `scheduled`), keeps what it read, and `publish`es when it changes. The only waits
are Today's cards (250 ms for all of them) and `beforePage` (1.5 s for all of them). After that
the page is drawn anyway, and a slow pack is named on it.

## What the core promises

The registry does this for every hook, so a pack can't break a page or another pack:

- **Isolation.** Every call goes through `safely` (sync) or `within` (async, time-boxed). A pack
  that throws adds nothing and gets a line in its log. A failing Today card shows as "Didn't
  answer", never as an empty card.
- **Sanitising.**
  - Text is cut to size and kept to one line where a line is drawn.
  - Every `href` goes through `safeUrl`. A link that isn't a path on this app or http(s) is
    dropped or made harmless.
  - Tones come from fixed lists.
  - Counts are capped:
    - docks: 3; a dock's `key` is one capital letter the page doesn't use already (B is Bino's;
      F, G, H, J, K, L move about), and the first dock to ask for it gets it;
    - acts: 5 per pack, 8 fields each, 12 in all;
    - finds: 500 per pack; linked PRs: 200;
    - glance: 2 numbers; brief: 12 bits; lane: 200 marks;
    - pulse: counts 0–99; 5 troubles, a line of 80 each, links to this app's paths only.
- **Namespaces.**
  - A pack's need keys, ring tags and Bino act kinds are kept under its id.
  - A ring kind the core or another pack already has is refused.
  - A route can't shadow a core path or another pack's.
- **Gates that stay core's.**
  - The guard (launch token locally, Access hosted) runs before every pack route. There are two
    exceptions. `/<id>/callback` is local only and a 404 when the pack is hidden.
    `POST /<id>/ingest/*` (an app sending data in, dovre#109) needs an ingest token made on Settings.
    Only its SHA-256 is kept. Core checks the token, the body cap and the per-token rate before the
    pack sees the body. The pack never gets the token or any other header. Locally it answers on this
    machine's own address only. Hosted, it needs an Access Bypass policy for that path.
  - Only a pack's `/<id>/dock` pages may be framed by Dovre's own pages.
  - A pack's act is checked against its declared fields before the card is drawn. Pressing it
    asks a second time unless the act is `oneClick`.

## Rules for packs

- One pack reaches another's page only through a slot, never an import.
- A pack's writes to its own app re-check the current state first, log to the `actions` table,
  and go through a Confirm (or `oneClick` where I decided so, like Teams' send). Its kinds of write
  are listed in `writes` and passed as `kind: "<id>.<kind>"`: Settings → Writes can set each one
  to one click, unless it has a `twice` floor.
- A pack whose pages show what isn't mine to hand a model (chats, mail, query results) says
  `private` in its manifest: asked from one of its pages, Bino hears only the pack's name.
- What Bino may know (`bino`, `about`) is names, states and counts. Never what someone wrote, an
  address, or a token.
- A pack's tests live with it (`packs/<id>/test/`), with a hostile-input case for each page.
  `testContext()` (`dovre/packs/testing.ts`) gives harmless defaults.
- The shape: `index.ts` holds the manifest and hooks, `data.ts` reads the app, `view.ts` draws.
  `pnpm packs new <id> --into <instance>` starts one in that shape.

## Extending Dovre

**A new app** is a new pack in the instance repo: `pnpm packs new`, then add it to the instance's
`packs.ts`. Nothing in core changes. If it needs config, list the keys in the manifest's
`settings`. If it needs a binding, list it in `requiredBindings` and add it to the wrangler config.

**A new machine** is a new instance repo: `pnpm instance new <folder>` writes packs.ts, worker.ts,
wrangler.jsonc, package.json and a README that walks through deploying.

**A new place on a core page** is a slot. Add an entry to `SlotMap` saying what the page knows
there (`arg`) and what goes in (`out`). The page calls `fill(name, arg)` and draws what comes
back. Most new needs should be slots: they're cheap, typed, and isolated already.

**A new hook** is needed only when no slot fits: something every page draws, a new kind of event,
or a new outside caller. The steps, as H9e did them:
1. Add it to `Pack` in types.ts, saying when it's called and how fast it must answer.
2. Add a `…From` function in registry.ts that calls it isolated, cuts and checks what comes back,
   and logs a failure under the pack's id.
3. Use it in app.ts (or the entry point), only for `shown()` packs.
4. Add its label to `hooksOf` for the Packs page, and a paragraph to README's "A pack's shape".
5. Test it with a fake pack in test/packs.test.ts: a hostile answer, one that throws, and a
   hidden pack.

**Changing the contract.** Adding an optional hook or slot isn't a breaking change: older packs
just don't answer it. Removing or changing a hook, a field's meaning, or a slot's `arg` is
breaking: bump `PACK_API`, and every pack built for the old number shows as off until it's
updated. Every change since H1 has been additive, so the contract is still 1.

## Where it stands, and what's open

**Done here (H9a–e):** agents, atlas, terminal and docker are packs. The hooks the work packs
need exist and are tested with fake packs: dock, callback, acts, settings, and the slots
deploy.prod, todo.proposals and actions.where. In this write-up (WP-X1), "Start an agent" left
core's search actions for the agents pack: `finds` can now put rows in search's "Do" group
(`kind: "actions"`).

**Moved out (H9f):** Teams (with mail and channels) and Data are an instance's packs now
(2026-10-26). For them the contract grew four additive things: a dock's `key` (Teams' T), the
`actions.what` slot (what a pack's log entry was, in words), the manifest's `private`, and
`ctx.ask` / `ctx.asking` (Data's production questions in the bar). test/boundary.test.ts fails if
their code, panes, settings, routes or styles come back to core. DROPS is next (rebuilt).

**Open points:**

1. *Settled (#130, 2026-10-27):* **the avatar is a pack for fun in dovre-packs**, no longer in
   core. Core keeps what any pack can use: the two slots it fills (`today.hero`, `bino.face`),
   the pulse (`pulse`, old name `avatar`, summed as `ctx.pulse()`), pack scripts (`script`),
   reading the forge (`ctx.forge()`), the starting page's picture (`ctx.startPicture()`), and
   the `fun` domain, listed apart on the Packs page. Locally it's on where PACKS lists it;
   dovre-home and dovre-cloud's tenants bundle it (a new tenant starts with it hidden).
2. *Settled (H9f, 2026-10-26):* **a pack's options are its manifest `settings`** (.dev.vars, shown
   and saved on the Packs page). The config store's keys stay a fixed list (src/config.ts `KEYS`)
   for core's own panes, so Teams' options (TEAMS_CRAWL, TEAMS_SINCE_DAYS, OUTLOOK) left it with
   Teams.
3. **Core pages link to the agents pack's routes.** My list, New work, tasks, reviews and the
   desk link to `/agents/new`, and `/agents/s/…` is linked from several places. With
   `PACK_AGENTS=off`, those links answer 404. Acceptable while agents is core's own pack (the
   runner, the desk, is core). If it should ever be optional for real, the links become a slot
   ("start an agent on this").
4. **Hosted Bino proposes nothing.** It runs in the Durable Object, which has no packs. So
   `acts`, and Bino's own proposals, are local only. Hosted Bino does get the packs' `bino` lines
   through the page's context.
