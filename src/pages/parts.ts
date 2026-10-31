/** Pieces several pages share: PR status pills, a session row, a time that keeps itself current, a failed source. */
import { html } from "hono/html";
import { since } from "../format.ts";
import type { Result, Snapshot } from "../gather.ts";
import type { Session } from "../sources/claude.ts";
import { type Pr, type PrRef, prKeyOfUrl } from "../sources/ghe.ts";
import { type Child, type Html, Item, newTab, Notice, Pill, type Tab, Tabs } from "../ui/kit.ts";
import type { Quiet } from "../quiet.ts";

/** The AI harness an agent runs in, by name. */
/** Pull requests' two views: the list, and the stacks (PRs built on other PRs). */
/** The PR pages' tabs; none when the forge has no stacks (one tab is no choice). */
export function prTabs(current: "list" | "stacks" | "dependabot", stacks = true, dependabot = true): Html | "" {
  if (!stacks && !dependabot) return "";
  const items: Tab[] = [{ href: "/prs", label: "Open", current: current === "list" }];
  if (stacks) items.push({ href: "/prs/stacks", label: "Stacks", current: current === "stacks" });
  if (dependabot) items.push({ href: "/prs/dependabot", label: "Dependabot", current: current === "dependabot" });
  return Tabs({ label: "Pull requests", items });
}

export const HARNESS_NAME = { claude: "Claude Code", omp: "Copilot · omp", copilot: "Copilot CLI", agy: "Antigravity · agy", codex: "Codex" } as const;

/** Each harness's mark beside its name (#239), so its tag isn't told apart by colour alone. */
export const HARNESS_GLYPH: Record<keyof typeof HARNESS_NAME, string> = { claude: "✳", codex: "◇", omp: "π", copilot: "◎", agy: "▲" };

/** Which harness an agent runs in (and its model, when known): a tag on every agent row, in its own hue. */
export function harnessTag(h: keyof typeof HARNESS_NAME | undefined, model?: string): Html {
  const id = h ?? "claude";
  const m = model ? model.replace(/^github-copilot\//, "") : "";
  return html`<span class="harness ${id}" title="Runs in ${HARNESS_NAME[id]}${m ? `, ${m}` : ""}"><span class="harness-g" aria-hidden="true">${HARNESS_GLYPH[id]}</span>${HARNESS_NAME[id]}${m ? html`<span class="harness-m"> · ${m}</span>` : ""}</span>`;
}

/** On a New work preview: also put what's created on My list (on unless unticked). */
export const MyListBox = html`<label class="check mylist"><input type="checkbox" name="mylist" value="1" checked> Also put it on My list</label>`;

/** What pages call the forge: "GitHub" for github.com, else the host itself ("ghe.example.com"). */
export const forgeName = (host: string | undefined): string => (!host || host.toLowerCase() === "github.com" ? "GitHub" : host);

/** Only http(s) links and this app's own paths reach an href: escaping doesn't stop `javascript:`. */
export function safeUrl(url: string | undefined | null): string {
  if (!url) return "#";
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "#";
  } catch {
    return "#";
  }
}

/** A link: checked by safeUrl, and in a new tab when it leaves the app. */
export const Link = (url: string | undefined | null, children: Child, cls?: string) => {
  const href = safeUrl(url);
  return html`<a href="${href}"${cls ? html` class="${cls}"` : ""}${newTab(href)}>${children}</a>`;
};

/** "12 min", kept current by the page script (data-at). */
export const Ago = (at: number | string | undefined, now = Date.now()) => {
  const ms = typeof at === "string" ? Date.parse(at) : at;
  return ms && Number.isFinite(ms) ? html`<span data-at="${ms}" title="${new Date(ms).toISOString()}">${since(ms, now)}</span>` : "";
};

export const trunc = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ""));

export function checksPill(c: Pr["checks"]): Html | "" {
  if (c === "SUCCESS") return Pill({ tone: "ok", children: "checks ✓" });
  if (c === "FAILURE" || c === "ERROR") return Pill({ tone: "bad", children: "checks ✗" });
  if (c === "PENDING" || c === "EXPECTED") return Pill({ tone: "warn", children: "checks running" });
  return "";
}

export function reviewPill(r: Pr["review"]): Html | "" {
  if (r === "APPROVED") return Pill({ tone: "ok", children: "approved" });
  if (r === "CHANGES_REQUESTED") return Pill({ tone: "bad", children: "changes requested" });
  if (r === "REVIEW_REQUIRED") return Pill({ children: "awaiting review" });
  return "";
}

export const prPills = (p: Pr): Html =>
  html`${p.draft ? Pill({ children: "draft" }) : ""} ${checksPill(p.checks)} ${reviewPill(p.review)} ${p.openThreads ? Pill({ tone: "warn", children: `${p.openThreads} open ${p.openThreads === 1 ? "thread" : "threads"}` }) : ""}`;

export function refPill(ref: PrRef | undefined): Html {
  if (!ref) return Pill({ children: "unknown" });
  if (ref.state === "MERGED") return Pill({ tone: "ok", children: "merged" });
  if (ref.state === "CLOSED") return Pill({ children: "closed" });
  return Pill({ tone: "accent", children: "open" });
}

/** A PR an agent linked: with full status when it's mine and open, otherwise its state. */
export function linkedPr(link: { url: string; repo: string; number: number }, org: string, mine: Map<string, Pr>, refs: Map<string, PrRef>): Html {
  const key = prKeyOfUrl(link.url) ?? "";
  const pr = mine.get(key);
  return html`${Link(link.url, `${(link.repo ?? "").replace(`${org}/`, "")}#${link.number}`)} ${pr ? prPills(pr) : refPill(refs.get(key))}`;
}

/** What to paste in a terminal to pick a session up again, where it ran. */
export const resumeCommand = (s: Session) =>
  s.harness === "omp"
    ? `cd "${s.cwd}"; omp${s.profile && /^[\w.-]+$/.test(s.profile) ? ` --profile ${s.profile}` : ""} --resume ${s.sessionId}`
    : s.harness === "copilot"
      ? `cd "${s.cwd}"; copilot --resume ${s.sessionId}`
      : s.harness === "agy"
        ? `cd "${s.cwd}"; agy --conversation ${s.sessionId}`
        : s.harness === "codex"
          ? `cd "${s.cwd}"; codex resume ${s.sessionId}`
          : `cd "${s.cwd}"; claude --resume ${s.sessionId}`;

/** One agent session as a list row. */
export function sessionItem(s: Session, ctx: { org: string; mine: Map<string, Pr>; refs: Map<string, PrRef>; prs?: number; /** Ways to pick an ended session up again (the "session.resume" slot). */ resume?: (s: Session) => Child; /** Started here: an ended one can be cleared away. */ discard?: (s: Session) => boolean; /** Ran in Dovre's own folder (not a checkout, so nothing resumes it there). */ here?: (s: Session) => boolean }): Html {
  const state = s.live
    ? s.status === "busy"
      ? { tone: "ok" as const, label: "working" }
      : s.status === "waiting"
        ? { tone: "bad" as const, label: s.waitingFor ? `needs you: ${s.waitingFor}` : "needs your OK" }
        : { tone: "warn" as const, label: "waiting for you" }
    : { tone: undefined, label: "ended" };
  const prs = s.prs.slice(-(ctx.prs ?? 4));
  const line: Child[] = [];
  if (s.machine) line.push(html`<span class="t3">${s.machine}</span>`);
  if (s.repo) line.push(line.length ? html` · ${s.repo}` : s.repo);
  if (s.branch) line.push(html` · ${s.branch}`);
  if (s.subagentsRunning) line.push(html` · ${s.subagentsRunning} subagent${s.subagentsRunning === 1 ? "" : "s"} running`);
  return Item({
    id: `s-${s.sessionId}`,
    lead: html`<span class="dot${state.tone ? ` ${state.tone}` : ""}" role="img" aria-label="${state.label}" title="${state.label}"></span>`,
    title: html`<a class="name" href="/agents/s/${s.sessionId}"><strong>${s.title ?? s.name ?? s.sessionId.slice(0, 8)}</strong></a>${s.live ? Pill({ tone: state.tone, children: state.label }) : ""}${harnessTag(s.harness, s.model)}`,
    line,
    more: s.summary || s.lastPrompt || prs.length || (s.cwd && !s.live)
      ? html`${s.summary ? html`<span class="recap">${s.summary}</span>` : ""}${s.lastPrompt ? html`<span class="asked">› ${trunc(s.lastPrompt, 240)}</span>` : ""}${
          prs.length ? html`<span class="links">${prs.map((p) => html`<span>${linkedPr(p, ctx.org, ctx.mine, ctx.refs)}</span>`)}</span>` : ""
        }${s.cwd && !s.live ? html`<span class="resume"><code data-copy="${resumeCommand(s)}">${resumeCommand(s)}</code>${ctx.resume && s.repo && !ctx.here?.(s) ? ctx.resume(s) : ""}</span>` : ""}${
          !s.live && ctx.discard?.(s) ? html`<span class="actions"><form method="post" action="/agents/s/${s.sessionId}/discard"><button type="submit" class="sm ghost" title="Off Dovre's lists; the transcript stays">Clear away</button></form></span>` : ""
        }`
      : undefined,
    trail: html`${Ago(s.live ? s.statusSince : s.lastAt)}${s.cost ? html`<span class="t3">$${s.cost.toFixed(2)}</span>` : ""}`,
    quiet: !s.live,
  });
}

/** A source that failed, said plainly where its data would be. */
export function failed(name: string, r: Result<unknown> | { ok: false; error: string }): Html | "" {
  return r.ok ? "" : Notice({ tone: "bad", children: html`<strong>${name} didn't load.</strong> ${r.error}` });
}


/**
 * Hosted: whether the machines' agents are reachable (PLAN D24, H7). Locally there's no such thing.
 * `name`: the one machine meant ("Mac" is the one from before there were several); `machines`:
 * every paired one, when a page shows them all.
 */
export type MacStatus = { online: boolean; seen?: number; name?: string; machines?: { name: string; online: boolean; seen?: number }[] };

/**
 * A machine offline, said where agents are shown: what's there is from when it was last seen,
 * never "nothing". A live region of its own, so it appears and goes as the machines do.
 */
export function macNotice(mac: MacStatus | undefined, now = Date.now()): Html | "" {
  if (!mac) return "";
  const seenOf = (at: number | undefined) => {
    const ago = at ? since(at, now) : undefined;
    return !ago ? "" : ago === "now" ? ", last seen just now" : `, last seen ${ago} ago`;
  };
  const who = (name: string | undefined) => (!name || name === "Mac" ? "Your Mac" : name);
  const all = mac.machines && mac.machines.length > 1 ? mac.machines : undefined;
  const off = all ? all.filter((m) => !m.online) : mac.online ? [] : [{ name: mac.name ?? "Mac", seen: mac.seen }];
  const say = !off.length
    ? ""
    : !all
      ? html`<strong>${who(off[0]!.name)} is offline${seenOf(off[0]!.seen)}.</strong> What's here is from then. Agents start and answer again when it's back.`
      : off.length === all.length
        ? html`<strong>None of your machines is online.</strong> What's here is from when each was last seen. Agents start and answer again when one is back.`
        : html`${off.map((m, i) => html`${i ? " " : ""}<strong>${who(m.name)} is offline${seenOf(m.seen)}.</strong>`)} Its agents are as it last said.`;
  return html`<div data-live id="mac">${say ? Notice({ tone: "warn", children: say }) : ""}</div>`;
}

/** My open PRs by key (org/repo#n), to say a linked PR's state. */
export const mineByKey = (s: Pick<Snapshot, "prs">) => new Map<string, Pr>((s.prs.ok ? s.prs.value.mine : []).map((p) => [prKeyOfUrl(p.url)!, p]));

/** A status in a Today row: a dot in its tone, and the words. */
export const st = (tone: "ok" | "warn" | "bad" | "acc" | "mute", text: unknown) => html`<span class="st ${tone}"><i></i>${text}</span>`;
/** The chevron on a row that opens in place. */
export const Chev = html`<span class="chev" aria-hidden="true"></span>`;

/** Quiet hours as fields (src/quiet.ts): from, until, and all weekend. Empty hours and no weekend: none. */
export function quietFields(q: Quiet | null, hint: string, prefix = "quiet") {
  const h = (n: number | undefined) => (n === undefined ? "" : String(n));
  const hours = q && q.from !== q.to;
  return html`<div class="fields aligned" id="quiet-hours">
<label class="field"><span class="label">Quiet from</span><input type="number" name="${prefix}From" min="0" max="23" value="${h(hours ? q.from : undefined)}"><span class="hint">hour</span></label>
<label class="field"><span class="label">Quiet until</span><input type="number" name="${prefix}To" min="0" max="23" value="${h(hours ? q.to : undefined)}"><span class="hint">hour. Empty: no quiet hours.</span></label>
</div>
<div class="field"><label class="check"><input type="checkbox" name="${prefix}Weekends" value="on"${q?.weekends ? html` checked` : ""}> And all weekend</label><span class="hint">${hint}</span></div>`;
}
