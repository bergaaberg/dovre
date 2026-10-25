---
name: dovre-pack-builder
description: Scaffold, implement, and test a custom Pluggable Pack for Dovre in 3 files (index.ts manifest & hooks, data.ts in-memory reader, view.ts escaped hono/html templates) with a mandatory hostile-input test.
---

# Dovre Pluggable Pack Builder Skill (`dovre-pack-builder`)

Use this skill when the user wants to integrate a custom app, internal service, or workflow into **Dovre** as a **Pluggable Pack** (under an instance repo).

## 1. Scaffold the Pack

Never write company-specific or personal app code directly into Dovre Core. Always install a pre-built pack or scaffold into the user's instance repo:
```sh
# Install a pre-built pack from bergaaberg/dovre-packs:
pnpm packs add <pack-id> --into ../<instance-repo>

# Or scaffold a new 3-file custom pack:
pnpm packs new <pack-id> --into ../<instance-repo>
```
This creates four files without overwriting existing files:
- `crates/<id>/index.ts` — Manifest (`api: CRATE_API`, `id`, `name`, `execution`, `everyMs`, `crons`, `settings`) and hooks.
- `crates/<id>/data.ts` — Background data reader into memory; zero HTML.
- `crates/<id>/view.ts` — Escaped `hono/html` views (`Card`, `Panel`, `Item`, `safeUrl`).
- `crates/<id>/test/<id>.test.ts` — Unit and hostile-input XSS tests using `testContext()`.

## 2. Enforce Dovre's Three Pack Rules

1. **Memory-First (250ms Budget):**
   - `today()`, `glance()`, `brief()`, `lane()`, `feed()`, `needs()`, `finds()`, `bino()`, and `slots` MUST read synchronously from memory (`data.ts`).
   - Network/DB reads happen only inside `refresh(ctx)` or `scheduled(trigger, ctx)`, which then call `ctx.publish(["<id>"])` to push live SSE swaps.
2. **Strict Escaping & `safeUrl()`:**
   - All views in `view.ts` use `html\`...\`` tagged templates from `hono/html`.
   - Every `href` constructed from external or user data MUST pass through `safeUrl()` from `dovre/pages/parts.ts`.
   - Never use inline `style="..."` attributes; use Dovre kit classes (`src/ui/kit.ts`) or export a `styles` string on the pack.
3. **Hostile-Input Test in the Pack's Own `test/` Folder:**
   - Every pack test suite in `crates/<id>/test/<id>.test.ts` MUST include a hostile payload test (`<script>alert(1)</script>`, `javascript:alert(1)`) verifying that all rendered HTML and links are escaped.

## 3. Available Hooks & UI Slots (`src/crates/types.ts`)

- **Today screen:** `today` (cards), `glance` (up to 2 counts), `brief` (opening sentence bits), `lane` (24h horizon marks), `feed` (live events).
- **Attention:** `needs` (+ manifest `rings`), `ctx.ring`, `banner`, `dock`.
- **Search (`Ctrl+K`):** `pages`, `finds` (`kind: "agents" | "code" | "actions"`).
- **Assistant & Memory:** `bino` (states/counts up to 1,500 chars), `about`, `acts` (proposable action cards).
- **Named UI Slots (`SlotMap`):** `today.hero`, `agents.new`, `pr.lead`, `pr.facts`, `work.new`, `agents.panel`, `worktree.actions`, `session.resume`, `deploy.prod`, `todo.proposals`, `bino.face`, `actions.where`.

## 4. Register & Verify

1. Add the pack to `../<instance-repo>/crates.ts`.
2. Run `pnpm typecheck && pnpm test` in both the instance repo and Dovre Core.
