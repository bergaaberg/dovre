/**
 * Auto runs on the forge (#207): finding issues an owner labelled `dovre:auto`, checking them,
 * starting each as a sandbox run through the desk (hosted: on a machine over the bridge), and
 * when it ends, its draft PR, a comment on the issue and the label swapped for
 * `dovre:auto-done` or `dovre:auto-stuck` (stuck: only after a few tries). `autoTick` is the whole loop, one pass; the agents
 * pack calls it on its own slow schedule (not the gatherer's), since each new issue costs a
 * GraphQL call to see who labelled it.
 *
 * Trust: the label is the owner's say-so. It counts only when the label event's actor is an
 * owner (my login, or a login in REPO_OWNERS), and the text the agent reads must be what the
 * owner saw: an issue whose body was edited, or title renamed, after the label by someone else
 * is refused. It's checked again right before the run starts.
 *
 * Writes: the comment and labels are logged (`auto.done`, `auto.stuck`) and go only to repos in
 * REPO_OWNERS. The draft PR opens on its own only when Settings → Writes has `auto.pr` at one
 * click and the diff leaves CI config alone; else it waits for me on the run's page, with a need.
 */
import type { D1 } from "../db.ts";
import type { Desk } from "../agents/desk.ts";
import type { Run } from "../agents/runner.ts";
import { AUTO_LABEL, type AutoOptions, type AutoRow, type AutoSettings, type AutoStore, BUSY, DONE_LABEL, STUCK_LABEL, autoKey, autoOptionsOf, autoPrompt, autoStore, capsFor, isQuiet, loadAutoSettings, localHour, MAX_TRIES, repoOn } from "../agents/auto.ts";
import { ownerQuery, ownersOf } from "../owners.ts";
import type { Ghe } from "../sources/ghe.ts";
import { ownedRepo } from "../sources/files.ts";
import type { Clicks } from "../writes.ts";
import { logAction } from "./deploys.ts";
import { openSandboxPr } from "./sandbox.ts";

type Forge = Pick<Ghe, "rest" | "graphql">;

/** An issue as the search found it. */
export type Found = { repo: string; number: number; title: string; updated: string };

/** Open issues with the label in the owners' repos: one search, at most 50. */
export async function findAuto(ghe: Forge, owners: string): Promise<Found[]> {
  if (!ownersOf(owners).length) return [];
  const q = `is:issue is:open label:"${AUTO_LABEL}" ${ownerQuery(owners)}`;
  const r = await ghe.rest<{ items?: { number: number; title: string; updated_at: string; repository_url: string; pull_request?: unknown }[] }>(`/search/issues?q=${encodeURIComponent(q)}&sort=created&order=asc&per_page=50`);
  const out: Found[] = [];
  for (const i of r.items ?? []) {
    const m = /\/repos\/([\w.-]+)\/([\w.-]+)$/.exec(i.repository_url ?? "");
    const repo = m ? ownedRepo(owners, `${m[1]}/${m[2]}`) : undefined;
    if (repo && !i.pull_request && Number.isInteger(i.number)) out.push({ repo, number: i.number, title: String(i.title ?? ""), updated: String(i.updated_at ?? "") });
  }
  return out;
}

/** What's needed to trust an issue: its text, who labelled it and when, who changed its text after. */
export type IssueCheck = {
  open: boolean;
  labelled: boolean;
  title: string;
  body: string;
  updated: string;
  author?: string;
  editedAt?: string;
  editor?: string;
  /** The newest `dovre:auto` label event. */
  label?: { by?: string; at: string };
  renames: { by?: string; at: string }[];
};

/** The issue, in one GraphQL call (the label events from its timeline). Throws when the forge does. */
export async function checkIssue(ghe: Forge, repo: string, number: number): Promise<IssueCheck> {
  const [owner, name] = repo.split("/") as [string, string];
  const q = `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issue(number:${Math.trunc(number)}){state title body updatedAt lastEditedAt author{login} editor{login} labels(first:50){nodes{name}} timelineItems(last:100,itemTypes:[LABELED_EVENT,RENAMED_TITLE_EVENT]){nodes{__typename ... on LabeledEvent{createdAt actor{login} label{name}} ... on RenamedTitleEvent{createdAt actor{login}}}}}}}`;
  type Node = { __typename: string; createdAt: string; actor?: { login: string } | null; label?: { name: string } };
  const r = await ghe.graphql<{ repository: { issue: { state: string; title: string; body: string; updatedAt: string; lastEditedAt: string | null; author: { login: string } | null; editor: { login: string } | null; labels: { nodes: { name: string }[] }; timelineItems: { nodes: Node[] } } | null } | null }>(q);
  const i = r.repository?.issue;
  if (!i) throw new Error(`${repo}#${number} isn't there.`);
  const nodes = i.timelineItems?.nodes ?? [];
  const labels = nodes.filter((n) => n.__typename === "LabeledEvent" && n.label?.name === AUTO_LABEL);
  const last = labels[labels.length - 1];
  return {
    open: i.state === "OPEN",
    labelled: (i.labels?.nodes ?? []).some((l) => l.name === AUTO_LABEL),
    title: String(i.title ?? ""),
    body: String(i.body ?? ""),
    updated: String(i.updatedAt ?? ""),
    author: i.author?.login,
    editedAt: i.lastEditedAt ?? undefined,
    editor: i.editor?.login,
    label: last ? { by: last.actor?.login, at: last.createdAt } : undefined,
    renames: nodes.filter((n) => n.__typename === "RenamedTitleEvent").map((n) => ({ by: n.actor?.login, at: n.createdAt })),
  };
}

/** Why an issue can't run unattended, or null when it can. `isOwner`: a login that counts as an owner. */
export function untrusted(c: IssueCheck, isOwner: (login: string | undefined) => boolean): string | null {
  if (!c.open) return "It's closed.";
  if (!c.labelled || !c.label) return `It isn't labelled ${AUTO_LABEL} any more.`;
  if (!isOwner(c.label.by)) return `${c.label.by ?? "Someone"} labelled it, and only an owner's label counts.`;
  const after = (at: string | undefined) => !!at && Date.parse(at) > Date.parse(c.label!.at);
  if (after(c.editedAt) && !isOwner(c.editor ?? c.author)) return `${c.editor ?? "Someone"} edited it after it was labelled: label it again once you've read it.`;
  const renamed = c.renames.find((r) => after(r.at) && !isOwner(r.by));
  if (renamed) return `${renamed.by ?? "Someone"} renamed it after it was labelled: label it again once you've read it.`;
  return null;
}

const quiet = (s: string, max: number) => s.replace(/@(?=[\w-])/g, "@​").slice(0, max);

/** The comment, then the label swapped. Each step logged; a failed one doesn't stop the rest. */
export async function closeOut(o: { db: D1; ghe: Forge; owners: string; row: Pick<AutoRow, "repo" | "number">; done: boolean; text: string }): Promise<void> {
  const repo = ownedRepo(o.owners, o.row.repo);
  const kind = o.done ? "auto.done" : "auto.stuck";
  const target = `${o.row.repo}#${o.row.number}`;
  if (!repo) return void (await logAction(o.db, { kind, target, ok: false, error: "Not in your repos." }).catch(() => {}));
  const base = `/repos/${repo}/issues/${o.row.number}`;
  const steps: [string, () => Promise<unknown>][] = [
    ["comment", () => o.ghe.rest(`${base}/comments`, { method: "POST", body: { body: o.text } })],
    ["label off", () => o.ghe.rest(`${base}/labels/${encodeURIComponent(AUTO_LABEL)}`, { method: "DELETE" })],
    ["label on", () => o.ghe.rest(`${base}/labels`, { method: "POST", body: { labels: [o.done ? DONE_LABEL : STUCK_LABEL] } })],
  ];
  const failed: string[] = [];
  for (const [what, go] of steps) await go().catch((e) => failed.push(`${what}: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
  await logAction(o.db, { kind, target, ok: !failed.length, ...(failed.length ? { error: failed.join("; ") } : {}) }).catch(() => {});
}

/**
 * A stuck auto run, again (#209): what the stuck comment tells me to do by hand. The row is
 * checked (still stuck, in my repos), the issue too (still open), then it's labelled
 * `dovre:auto` again (`-stuck` off) and queued; the next pass starts it within the limits.
 */
export async function runAgain(o: { db: D1; ghe: Forge; owners: string; key: string; store?: AutoStore }): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = o.store ?? autoStore(o.db);
  const row = await store.get(o.key);
  if (!row || row.state !== "stuck") return { ok: false, error: "That auto run isn't stuck any more." };
  const target = `${row.repo}#${row.number}`;
  const fail = async (error: string) => (await logAction(o.db, { kind: "auto.again", target, ok: false, error }).catch(() => {}), { ok: false as const, error });
  const repo = ownedRepo(o.owners, row.repo);
  if (!repo) return fail("Not in your repos.");
  const base = `/repos/${repo}/issues/${row.number}`;
  try {
    const issue = await o.ghe.rest<{ state: string }>(base);
    if (issue.state !== "open") return fail(`${target} is closed.`);
    await o.ghe.rest(`${base}/labels`, { method: "POST", body: { labels: [AUTO_LABEL] } });
  } catch (e) {
    return fail(`Couldn't label it: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  await o.ghe.rest(`${base}/labels/${encodeURIComponent(STUCK_LABEL)}`, { method: "DELETE" }).catch(() => {});
  if (!(await store.move(o.key, "stuck", "queued", { why: null, tries: 0 }))) return fail("Another pass moved it first.");
  await logAction(o.db, { kind: "auto.again", target, ok: true }).catch(() => {});
  return { ok: true };
}

/**
 * Run in sandbox (#243): an issue picked on /agents/new handed to auto runs, by labelling it
 * `dovre:auto` as me; the next pass checks it as any labelled issue and starts it within the
 * limits. Checked first: my repos, auto runs on for that repo, an open issue (not a PR).
 */
export async function labelForAuto(o: { db: D1; ghe: Forge; owners: string; settings: AutoSettings; repo: unknown; number: unknown }): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const repo = ownedRepo(o.owners, o.repo);
  const number = Number(o.number);
  if (!repo || !Number.isInteger(number) || number < 1) return { ok: false, error: "Not an issue in your repos." };
  const target = `${repo}#${number}`;
  const fail = async (error: string) => (await logAction(o.db, { kind: "auto.label", target, ok: false, error }).catch(() => {}), { ok: false as const, error });
  if (!repoOn(o.settings, repo)) return fail(`Auto runs are off for ${repo}.`);
  const base = `/repos/${repo}/issues/${number}`;
  try {
    const issue = await o.ghe.rest<{ state: string; pull_request?: unknown; labels?: { name?: string }[] }>(base);
    if (issue.pull_request) return fail(`${target} is a pull request.`);
    if (issue.state !== "open") return fail(`${target} is closed.`);
    if ((issue.labels ?? []).some((l) => l.name === AUTO_LABEL)) return fail(`${target} is labelled ${AUTO_LABEL} already.`);
    await o.ghe.rest(`${base}/labels`, { method: "POST", body: { labels: [AUTO_LABEL] } });
  } catch (e) {
    return fail(`Couldn't label it: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  await logAction(o.db, { kind: "auto.label", target, ok: true }).catch(() => {});
  return { ok: true, key: autoKey(repo, number) };
}

/** The agent's last word, for the comment. */
const lastWord = (run: Run | undefined) => {
  const r = run ? [...run.events].reverse().find((e) => e.t === "result" || e.t === "error") : undefined;
  return r && "text" in r && r.text.trim() ? quiet(r.text.trim(), 1500) : "";
};

/** Why an ended run made nothing to open a PR with. */
function stuckWhy(run: Run): string {
  const why = stuckReason(run);
  // Hosts the sandbox refused (#208): often why it got nowhere. Checked names only (src/agents/egress.ts).
  const b = (run.blocked ?? []).filter((h) => /^[a-z0-9.-]{1,253}$/.test(h)).slice(0, 5);
  return b.length ? `${why} Its sandbox refused ${b.map((h) => `\`${h}\``).join(", ")}; a repo allows hosts in \`.dovre/sandbox.json\`.` : why;
}

function stuckReason(run: Run): string {
  const err = [...run.events].reverse().find((e) => e.t === "error");
  if (run.status === "stopped") return err?.t === "error" ? err.text : "It was stopped.";
  if (run.budget && run.cost >= run.budget * 0.95) return `It hit its $${run.budget.toFixed(2)} cost cap.`;
  if (run.status === "failed") return err?.t === "error" ? `It failed: ${err.text.slice(0, 300)}` : "It failed.";
  if (run.out?.state === "failed") return `Its commits couldn't be brought home: ${run.out.why.slice(0, 300)}`;
  return "It ended without committing anything.";
}

export type AutoDeps = {
  db: D1;
  ghe: Forge;
  owners: string;
  desk: Desk;
  /** Settings → Writes: whether `auto.pr` is one click. */
  clicks: () => Promise<Map<string, Clicks>>;
  /** The instance's timezone, for quiet hours. */
  tz?: string;
  now?: () => number;
  store?: AutoStore;
};

/** One pass's outcome, for needs and the Settings panel. `paused`: why nothing new starts now. */
export type AutoPass = { rows: AutoRow[]; paused?: string };

const MIN = 60_000;

/** Who the token is, asked once an hour (#253: every pass asked, every 2 minutes). A failed ask isn't kept. */
const logins = new WeakMap<Forge, { login: string; at: number }>();
async function myLogin(ghe: Forge, at: number): Promise<string | undefined> {
  const kept = logins.get(ghe);
  if (kept && at - kept.at < 60 * MIN) return kept.login;
  try {
    const login = (await ghe.rest<{ login: string }>("/user")).login;
    if (login) logins.set(ghe, { login, at });
    return login;
  } catch {
    return kept?.login;
  }
}

/**
 * One pass: follow what's running or waiting, find newly labelled issues, start what fits the
 * limits. Every step re-reads the forge or the machine; a row moves only from the state it was
 * seen in, so two passes at once (hosted, two isolates) don't both start one issue.
 */
export async function autoTick(d: AutoDeps): Promise<AutoPass> {
  const now = d.now ?? Date.now;
  const store = d.store ?? autoStore(d.db, now);
  const s = await loadAutoSettings(d.db);
  let rows = await store.all();
  // Off, and nothing in flight: no forge calls at all.
  if (!s.on && !rows.some((r) => r.state === "starting" || r.state === "running" || r.state === "waiting")) return { rows };
  await d.desk.refresh?.();
  const me = await myLogin(d.ghe, now());
  const owners = ownersOf(d.owners).map((o) => o.toLowerCase());
  const isOwner = (login: string | undefined) => !!login && (login.toLowerCase() === me?.toLowerCase() || owners.includes(login.toLowerCase()));

  await follow(d, store, rows, now);

  if (s.on) {
    let found: Found[] = [];
    try {
      found = await findAuto(d.ghe, d.owners);
    } catch {}
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const f of found.slice(0, 20)) {
      const row = byKey.get(autoKey(f.repo, f.number));
      // New, labelled again after it ended, or refused and changed since.
      if (row && !(row.state === "done" || row.state === "stuck" || (row.state === "refused" && row.seen !== f.updated))) continue;
      try {
        const c = await checkIssue(d.ghe, f.repo, f.number);
        // Ended: only a label put on after that counts. A pass that saw it while another was still
        // closing it out (the comment posted, the label not yet off) would run it twice.
        if (row && row.state !== "refused" && !(c.label && Date.parse(c.label.at) > row.updated)) continue;
        const why = untrusted(c, isOwner);
        await store.put({ repo: f.repo, number: f.number, title: c.title, state: why ? "refused" : "queued", why: why ?? undefined, seen: c.updated, options: autoOptionsOf(c.body) });
      } catch {}
    }
  }

  rows = await store.all();
  const paused = await start(d, s, store, rows, isOwner, now);
  return { rows: await store.all(), ...(paused ? { paused } : {}) };
}

/** Runs going or waiting: their cost kept, and once ended, their PR (or a need), the comment and label. */
async function follow(d: AutoDeps, store: AutoStore, rows: AutoRow[], now: () => number) {
  const view = d.desk.view();
  const online = view.online;
  const listed = new Set(view.runs.map((r) => r.id));
  for (const row of rows) {
    // Claimed, then the pass that claimed it died: back in the queue.
    if (row.state === "starting" && now() - row.updated > 5 * MIN) await store.move(row.key, "starting", "queued", { why: "It didn't start; trying again." });
    if ((row.state !== "running" && row.state !== "waiting") || !row.run) continue;
    const run = await d.desk.run(row.run).catch(() => undefined);
    if (!run) {
      // Offline, just started, or the machine too busy to answer (pushing for a PR): ask again later.
      // Cleared away only when an online machine no longer lists it either.
      if (online && !listed.has(row.run) && now() - row.updated > 5 * MIN) await stuck(d, store, row, "Its run was cleared away before a PR was opened.", undefined);
      continue;
    }
    if (run.cost !== row.cost) await store.setCost(row.key, run.cost);
    if (run.status === "running") continue;
    const out = run.out;
    if (!out || out.state === "collecting") {
      if (now() - (run.endedAt ?? now()) > 15 * MIN) await stuck(d, store, row, "Its commits never came home from the sandbox.", run);
      continue;
    }
    if (out.state === "ready" && out.pr) {
      if (await store.move(row.key, row.state, "done", { pr: out.pr.url, cost: run.cost }))
        await closeOut({ db: d.db, ghe: d.ghe, owners: d.owners, row, done: true, text: `Dovre worked on this unattended in a sandbox and opened a draft PR: ${out.pr.url}\n\n${lastWord(run)}`.trim() });
      continue;
    }
    if (out.state !== "ready" || !out.commits.length) {
      await stuck(d, store, row, stuckWhy(run), run);
      continue;
    }
    if (out.repo?.toLowerCase() !== row.repo.toLowerCase()) {
      await stuck(d, store, row, `Its checkout's origin is ${out.repo ?? "not on the forge"}, not ${row.repo}.`, run, true);
      continue;
    }
    if (row.state === "waiting") continue;
    // Not set to ask twice on Settings → Writes, and no CI config touched: the PR opens now. Else it waits for me.
    if (!out.ci && (await d.clicks()).get("auto.pr") !== "twice") {
      const r = await openSandboxPr({ db: d.db, ghe: d.ghe, owners: d.owners, run, push: () => d.desk.pushSandbox(run.id) });
      if (r.ok) {
        await d.desk.landed(run.id, { number: r.number, url: r.url });
        if (await store.move(row.key, "running", "done", { pr: r.url, cost: run.cost }))
          await closeOut({ db: d.db, ghe: d.ghe, owners: d.owners, row, done: true, text: `Dovre worked on this unattended in a sandbox and opened a draft PR: ${r.url}\n\n${lastWord(run)}`.trim() });
        continue;
      }
      await store.move(row.key, "running", "waiting", { cost: run.cost, why: `The PR didn't open on its own: ${r.error}` });
      continue;
    }
    await store.move(row.key, "running", "waiting", { cost: run.cost, why: out.ci ? "It changes CI config, so its PR waits for you." : "Its draft PR waits for your OK." });
  }
}

/**
 * Stuck (#254): back in the queue on its own, label kept and nothing said on the issue, until it
 * has got stuck MAX_TRIES times since my label; then the comment, and dovre:auto swapped for
 * -stuck. `final`: trying again can't help (no checkout, the wrong origin), so it closes out now.
 */
async function stuck(d: AutoDeps, store: AutoStore, row: AutoRow, why: string, run: Run | undefined, final = false) {
  const tries = (row.tries ?? 0) + 1;
  const cost = run ? { cost: run.cost } : {};
  if (!final && tries < MAX_TRIES) {
    await store.move(row.key, row.state, "queued", { why: `Stuck ${tries} of ${MAX_TRIES} times; trying again. ${why}`.slice(0, 600), tries, ...cost });
    return;
  }
  if (!(await store.move(row.key, row.state, "stuck", { why, tries, ...cost }))) return;
  const said = lastWord(run);
  const times = tries > 1 ? ` ${tries} times; the last time:` : ".";
  await closeOut({ db: d.db, ghe: d.ghe, owners: d.owners, row, done: false, text: `Dovre's unattended run on this got stuck${times} ${why}${said && !why.includes(said) ? `\n\nIts last word:\n\n${said.replace(/^/gm, "> ")}` : ""}\n\nLabel it \`${AUTO_LABEL}\` again to try once more.` });
}

/** Starts what's queued while there's room. Returns why nothing new starts now, when that's so. */
async function start(d: AutoDeps, s: AutoSettings, store: AutoStore, rows: AutoRow[], isOwner: (l: string | undefined) => boolean, now: () => number): Promise<string | undefined> {
  const queued = rows.filter((r) => r.state === "queued" && repoOn(s, r.repo)).sort((a, b) => a.at - b.at);
  if (!s.on || !queued.length) return undefined;
  if (isQuiet(s, localHour(now(), d.tz))) return "Quiet hours: queued issues start after them.";
  if ((await store.spent(now() - 24 * 60 * MIN)) >= s.dayUsd) return `Auto runs have spent $${s.dayUsd.toFixed(2)} in the last 24 hours, the day's cap.`;
  let busy = rows.filter((r) => BUSY.includes(r.state)).length;
  for (const row of queued) {
    if (busy >= s.atOnce) break;
    if (!(await store.move(row.key, "queued", "starting", { why: null }))) continue;
    busy++;
    try {
      const c = await checkIssue(d.ghe, row.repo, row.number);
      const why = untrusted(c, isOwner);
      if (why) {
        await store.move(row.key, "starting", "refused", { why });
        busy--;
        continue;
      }
      const name = row.repo.split("/")[1]!.toLowerCase();
      const options: AutoOptions = autoOptionsOf(c.body);
      const caps = capsFor(s, options);
      const info = await d.ghe.rest<{ default_branch: string }>(`/repos/${row.repo}`);
      // Hosted with several machines: the first online that has the checkout.
      const machines = d.desk.view().machines?.filter((m) => m.online) ?? [];
      let machine: string | undefined;
      let checkout: string | undefined;
      for (const m of machines.length ? machines : [undefined]) {
        checkout = (await d.desk.repos(m?.id)).find((r) => r.toLowerCase() === name);
        if (checkout) {
          machine = m?.id;
          break;
        }
      }
      if (!checkout) {
        await stuck(d, store, { ...row, state: "starting" }, `There's no checkout named ${name} in the code folder${machines.length ? " on a machine online" : ""}.`, undefined, true);
        busy--;
        continue;
      }
      const r = await d.desk.start({
        repo: checkout,
        prompt: autoPrompt({ repo: row.repo, number: row.number, title: c.title, body: c.body }),
        harness: "claude",
        mode: "default",
        model: caps.model,
        sandbox: true,
        ...(machine ? { machine } : {}),
        caps: { base: `origin/${options.base ?? info.default_branch}`, maxMs: caps.maxMs, budget: caps.budget, ...(caps.effort ? { effort: caps.effort } : {}) },
      });
      const run = "run" in r ? r.run : undefined;
      if ("error" in r || !run) {
        // The machine or the sandbox isn't ready: it stays queued, and says why.
        await store.move(row.key, "starting", "queued", { why: "error" in r ? `Couldn't start: ${r.error.slice(0, 300)}` : "The machine didn't say which run it started." });
        return undefined;
      }
      await store.move(row.key, "starting", "running", { run, why: null });
    } catch (e) {
      await store.move(row.key, "starting", "queued", { why: `Couldn't start: ${String((e as Error)?.message ?? e).slice(0, 300)}` });
      return undefined;
    }
  }
  return undefined;
}
