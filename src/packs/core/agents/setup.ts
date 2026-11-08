/**
 * The Agents pack's own setup (#425, epic #386): a sandbox for each of my repos, by language. It
 * finds the languages in the owners' repos (a marker file each), shows the two files a repo of that
 * language gets (`.dovre/sandbox.json`: the hosts the box may reach and its setup line, and
 * `.dovre/sandbox.Containerfile`: its toolchain on top of dovre-sandbox), and opens one PR a repo
 * with both through the forge (`agents.sandbox-pr`, logged under Actions). Nothing merges by itself.
 * What was picked and which PRs opened are kept in Dovre's settings, so a hosted isolate that didn't
 * run the job still shows how it went.
 */
import { html } from "hono/html";
import type { Hono } from "hono";
import type { AppEnv } from "../../../env.ts";
import { safeUrl } from "../../../pages/parts.ts";
import { CheckRows, Confirm, Item, List, Pill } from "../../../ui/kit.ts";
import type { PackContext, PackSetup, SetupStep } from "../../types.ts";

/** src/agents/sandbox.ts's, which is Node-only: the setup runs hosted too. */
const CONFIG = ".dovre/sandbox.json";
const TOOLCHAIN = ".dovre/sandbox.Containerfile";
const KEY = "agents.sandboxes";
/** PRs one press opens, at most. */
export const MAX_PRS = 30;
export const SANDBOX_KIND = "sandbox-pr";

export type Lang = { id: string; label: string; /** The file that says a repo is this language. */ marker: string; allow: string[]; setup: string; containerfile: string };

const HEAD = "# Dovre's sandbox toolchain: built on dovre-sandbox (Node 24, git, curl), cached until this file changes.\nFROM dovre-sandbox\n";
/** In the order a repo is matched: a Rust repo with a package.json for its tooling is a Rust repo. */
export const LANGS: Lang[] = [
  {
    id: "rust",
    label: "Rust",
    marker: "Cargo.toml",
    allow: ["crates.io", "index.crates.io", "static.crates.io", "static.rust-lang.org"],
    setup: "cargo fetch",
    containerfile: `${HEAD}USER root\nRUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config && rm -rf /var/lib/apt/lists/*\nUSER agent\nRUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal\nENV PATH=/home/agent/.cargo/bin:$PATH\n`,
  },
  {
    id: "go",
    label: "Go",
    marker: "go.mod",
    allow: ["proxy.golang.org", "sum.golang.org"],
    setup: "go mod download",
    containerfile: `${HEAD}COPY --from=golang:1.25 /usr/local/go /usr/local/go\nENV PATH=/usr/local/go/bin:/home/agent/go/bin:$PATH\n`,
  },
  {
    id: "python",
    label: "Python · uv",
    marker: "pyproject.toml",
    allow: ["pypi.org", "files.pythonhosted.org"],
    setup: "uv sync",
    containerfile: `${HEAD}RUN curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install\n`,
  },
  {
    id: "pnpm",
    label: "JavaScript · pnpm",
    marker: "pnpm-lock.yaml",
    allow: ["registry.npmjs.org"],
    setup: "pnpm install --frozen-lockfile",
    containerfile: `${HEAD}USER root\nRUN corepack disable pnpm && npm install -g pnpm && pnpm --version\nUSER agent\n`,
  },
  {
    id: "npm",
    label: "JavaScript · npm",
    marker: "package.json",
    allow: ["registry.npmjs.org"],
    setup: "npm install",
    containerfile: `${HEAD}# Node and npm are in the base image already.\n`,
  },
];
const PATHS = [CONFIG, ...LANGS.map((l) => l.marker)];

export const configText = (l: Lang) => `${JSON.stringify({ allow: l.allow, setup: l.setup }, null, 2)}\n`;

/** The owners' repos without a sandbox yet, by language; those that have one, apart. */
export function byLang(repos: { repo: string; files: Record<string, string> }[]): { langs: Map<string, string[]>; have: string[] } {
  const langs = new Map<string, string[]>();
  const have: string[] = [];
  for (const r of repos) {
    if (r.files[CONFIG] !== undefined) {
      have.push(r.repo);
      continue;
    }
    const l = LANGS.find((x) => r.files[x.marker] !== undefined);
    if (l) langs.set(l.id, [...(langs.get(l.id) ?? []), r.repo]);
  }
  return { langs, have };
}

/** What a repo's PR came to. */
type Opened = { number: number; url: string } | { error: string };
/**
 * Kept between steps: the languages picked; from Open on, the repos this round is for; and every
 * repo's PR so far, which stays across rounds, so a repo whose PR is open isn't asked again.
 */
export type Kept = { langs: string[]; repos?: string[]; prs?: Record<string, Opened>; /** When the job started (ms), while it runs. */ running?: number };
/** A job that said it started this long ago and never finished died with its isolate. */
const STALE_MS = 2 * 60_000;
/** How long one press keeps opening PRs: hosted, a Worker keeps a job 30 s past its response. The rest wait for the next press. */
export const BUDGET_MS = 20_000;
const busy = (k: Kept, now = Date.now()) => !!k.running && now - k.running < STALE_MS;

const few = (repos: string[]) => `${repos.slice(0, 3).join(", ")}${repos.length > 3 ? `, and ${repos.length - 3} more` : ""}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function agentsSetup(): { setup: PackSetup; routes: (app: Hono<AppEnv>, ctx: PackContext) => void } {
  /** This isolate's job, while it runs. */
  let job: Promise<void> | undefined;
  const read = async (ctx: PackContext): Promise<Kept> => {
    const row = await ctx.db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>().catch(() => null);
    try {
      const v = row ? (JSON.parse(row.value) as Kept) : undefined;
      if (v && Array.isArray(v.langs)) return { ...v, langs: v.langs.filter((id) => LANGS.some((l) => l.id === id)) };
    } catch {}
    return { langs: [] };
  };
  const keep = (ctx: PackContext, k: Kept) => ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(KEY, JSON.stringify(k), new Date().toISOString()).run();
  const scan = async (ctx: PackContext) => {
    const every = await ctx.forge()?.everyRepo?.(PATHS).catch(() => undefined);
    return every ? byLang(every.repos) : undefined;
  };
  const opened = (k: Kept, repo: string) => !!k.prs?.[repo] && "number" in k.prs[repo]!;
  /** The picked languages' repos with no sandbox and no PR for one yet. */
  const unopened = (k: Kept, langs: Map<string, string[]>) => LANGS.filter((l) => k.langs.includes(l.id)).flatMap((l) => (langs.get(l.id) ?? []).filter((repo) => !opened(k, repo)).map((repo) => ({ repo, lang: l })));

  const noForge: SetupStep = { body: html`<p class="t2">Sandbox PRs go through GitHub, which this instance doesn't reach. Next skips it.</p>` };
  const waiting: SetupStep = { body: html`<p class="t2">Dovre hasn't read your repos yet. Give it a minute, or come back later.</p>`, wait: "Waiting for your repos." };

  const setup: PackSetup = {
    async draw(ctx, step) {
      const forge = ctx.forge();
      if (!forge) return waiting;
      if (!forge.everyRepo || !forge.propose) return noForge;
      const k = await read(ctx);
      const found = await scan(ctx);
      if (!found) return waiting;
      if (step === "repos") {
        const rows = LANGS.filter((l) => found.langs.has(l.id)).map((l) => {
          const repos = found.langs.get(l.id)!;
          return { value: l.id, label: html`${l.label} · ${plural(repos.length, "repo")}`, sub: few(repos), checked: k.repos === undefined && !k.langs.length ? true : k.langs.includes(l.id) };
        });
        const have = found.have.length ? html`<p class="t3">${plural(found.have.length, "repo")} ${found.have.length === 1 ? "has" : "have"} a sandbox already: ${few(found.have)}.</p>` : "";
        return {
          form: true,
          body: html`<p class="t2">Agents run in a container with only your repo and the hosts it allows. Two files in each repo say which, and what to install.</p>${rows.length ? CheckRows({ name: "lang", label: "Languages in your repos", rows }) : html`<p class="t2">No repo here needs one: none is Rust, Go, Python or JavaScript${found.have.length ? ", or each has one" : ""}.</p>`}${have}`,
        };
      }
      if (step === "files") {
        const picked = LANGS.filter((l) => k.langs.includes(l.id) && found.langs.has(l.id));
        if (!picked.length) return { body: html`<p class="t2">No language picked, so nothing goes in. Back to pick one, or Next.</p>` };
        return {
          body: html`${picked.map((l) => html`<div><h3>${l.label}</h3><p class="t3"><code>${CONFIG}</code></p><pre class="code">${configText(l)}</pre><p class="t3"><code>${TOOLCHAIN}</code></p><pre class="code">${l.containerfile}</pre></div>`)}<p class="t3">The same two files go in each repo of a language. Edit them in the PR if a repo is special.</p>`,
        };
      }
      // "open"
      const all = unopened(k, found.langs);
      const want = all.slice(0, MAX_PRS);
      if (!k.repos) {
        if (!want.length) return { body: html`<p class="t2">Nothing to open${k.prs && Object.values(k.prs).some((o) => "number" in o) ? ": the rest have their PRs" : ""}. Next finishes.</p>` };
        const more = all.length - want.length;
        return {
          body: html`<p class="t2">Opens ${plural(want.length, "PR")}, one per repo, each adding <code>${CONFIG}</code> and a Containerfile. Nothing merges by itself.${more > 0 ? ` The other ${more} get theirs when you run this setup again.` : ""}</p>${Confirm({ kind: `agents.${SANDBOX_KIND}`, action: "/agents/setup/open", label: `Open ${plural(want.length, "PR")}`, question: html`Open ${plural(want.length, "PR")} in ${few(want.map((t) => t.repo))}? Each is logged under Actions.` })}`,
          wait: "Open the PRs, or press Later.",
        };
      }
      const prs = k.prs ?? {};
      const failed = k.repos.filter((r) => prs[r] && "error" in prs[r]!);
      const left = k.repos.filter((r) => !prs[r]);
      const rows = k.repos.map((r) => {
        const o = prs[r];
        return Item({
          title: html`<code>${r}</code>`,
          ...(o && "error" in o ? { line: o.error } : {}),
          ...(o && "url" in o ? { href: safeUrl(o.url) } : {}),
          trail: !o ? Pill({ tone: "neutral", children: "opening…" }) : "error" in o ? Pill({ tone: "bad", children: "didn't open" }) : Pill({ tone: "ok", children: `#${o.number} open` }),
        });
      });
      const going = busy(k);
      const redo = [...failed, ...left];
      // Never tried (a press opens what fits in its time) or tried and failed: either way, the button opens them.
      const label = failed.length ? `Try ${plural(redo.length, "repo")} again` : `Open ${plural(redo.length, "more PR", "more PRs")}`;
      const again = redo.length && !going ? Confirm({ kind: `agents.${SANDBOX_KIND}`, action: "/agents/setup/open", label, question: html`Open the PRs still to go, in ${few(redo)}?` }) : "";
      const said = left.length || going ? "" : failed.length ? html`<p class="t3">${plural(k.repos.length - failed.length, "PR")} open. Merge them when they're green.</p>` : html`<p class="t3">All ${plural(k.repos.length, "PR")} open. Merge them when they're green; agents use the sandbox from then on.</p>`;
      return { body: html`${List(rows)}${said}${again}`, ...(going ? { wait: `Opening ${plural(left.length, "PR")}…`, refresh: 5 } : left.length ? { wait: `${plural(left.length, "PR")} to go. Open them below.` } : {}) };
    },
    async save(ctx, _step, form) {
      const langs = ([] as string[]).concat(form.lang ?? []).filter((id) => LANGS.some((l) => l.id === id));
      const k = await read(ctx);
      // A new round once the last is through: the repos whose PRs opened stay on record and aren't asked again.
      const through = !k.repos || (!busy(k) && k.repos.every((r) => k.prs?.[r]));
      await keep(ctx, through ? { langs, ...(k.prs ? { prs: k.prs } : {}) } : { ...k, langs });
      return { ok: true };
    },
  };

  const run = async (ctx: PackContext, list: { repo: string; lang: Lang }[], until = performance.now() + BUDGET_MS) => {
    const propose = ctx.forge()?.propose;
    for (const { repo, lang } of list) {
      if (performance.now() > until) break;
      const r = propose
        ? await propose({
            kind: SANDBOX_KIND,
            repo,
            title: `Add a Dovre sandbox (${lang.label})`,
            body: `Agents started from Dovre run in a container with only this repo. These two files say what it may reach and install:\n\n- \`${CONFIG}\`: the hosts it allows (${lang.allow.join(", ")}) and the setup line (\`${lang.setup}\`).\n- \`${TOOLCHAIN}\`: its toolchain, built on \`dovre-sandbox\`.\n\nEdit them here if this repo needs more.`,
            files: [
              { path: CONFIG, text: configText(lang), expect: null },
              { path: TOOLCHAIN, text: lang.containerfile, expect: null },
            ],
          }).catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
        : { ok: false as const, error: "The forge can't open PRs." };
      const k = await read(ctx);
      await keep(ctx, { ...k, prs: { ...k.prs, [repo]: r.ok ? { number: r.number, url: r.url } : { error: r.error.slice(0, 200) } } });
      ctx.publish(["agents"]);
    }
    const { running: _, ...k } = await read(ctx);
    await keep(ctx, k);
  };

  return {
    setup,
    routes(app, ctx) {
      app.post("/agents/setup/open", async (c) => {
        const back = c.redirect("/setup/agents?at=open", 303);
        // One job at a time: the saved start says so across isolates (a job that never ended goes stale).
        const k = await read(ctx);
        if (busy(k)) return back;
        const found = await scan(ctx);
        if (!found) return back;
        // A round's first press: the picked languages' repos. Again: this round's that didn't open.
        const list = (k.repos ? unopened(k, found.langs).filter((t) => k.repos!.includes(t.repo)) : unopened(k, found.langs)).slice(0, MAX_PRS);
        if (!list.length) return back;
        const prs = { ...k.prs };
        for (const t of list) delete prs[t.repo];
        await keep(ctx, { ...k, repos: k.repos ?? list.map((t) => t.repo), prs, running: Date.now() });
        job = run(ctx, list)
          .catch(async () => {
            const { running: _, ...rest } = await read(ctx);
            await keep(ctx, rest);
          })
          .finally(() => (job = undefined));
        try {
          c.executionCtx.waitUntil(job);
        } catch {}
        return back;
      });
    },
  };
}
