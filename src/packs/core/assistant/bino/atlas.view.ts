/**
 * Repo Atlas's views: its page (/atlas), a catalog of local repositories, range.yaml component
 * boundaries, rules, docs, and direct agent launching; and what it puts in core pages' slots
 * (the component picker on /agents/new, a PR's tier and docs, New work's Projects) and Bino's lines.
 */
import { html } from "hono/html";
import { type Child, type Html, Item, List, PageHeader, Panel, Pill, Tabs, type Tone } from "../../../../ui/kit.ts";
import { Link, safeUrl } from "../../../../pages/parts.ts";
import type { Range } from "./range.ts";
import type { AtlasEntry } from "./scan.ts";

function tierTone(tier?: string): Tone {
  if (!tier) return "neutral";
  const t = tier.toLowerCase();
  if (t === "active" || t === "production") return "ok";
  if (t === "core" || t === "platform") return "accent";
  if (t === "utility" || t === "tool") return "neutral";
  if (t === "deprecated" || t === "archive") return "warn";
  return "neutral";
}

function repoLinks(entry: AtlasEntry): Html {
  const parts: Html[] = [];
  if (entry.range.url) {
    const label = (() => {
      try {
        return `${new URL(entry.range.url).host} ↗`;
      } catch {
        return "Site ↗";
      }
    })();
    parts.push(html`<a class="t2" href="${safeUrl(entry.range.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  }
  parts.push(html`<a class="t2" href="/code/${encodeURIComponent(entry.repo)}">Code →</a>`);
  parts.push(html`<a class="t2" href="/agents/new?repo=${encodeURIComponent(entry.repo)}">Agent →</a>`);
  if (entry.range.health?.workers?.length || entry.range.health?.links?.length) {
    parts.push(html`<a class="t2" href="/ops#${encodeURIComponent(entry.repo)}">Health →</a>`);
  }
  return html`<div class="buttons">${parts}</div>`;
}

function repoPanel(entry: AtlasEntry): Html {
  const rows: Child[] = [];

  // Components
  if (entry.range.components?.length) {
    rows.push(
      Item({
        title: html`<span class="sub-h">Components (${entry.range.components.length})</span>`,
        quiet: true,
      }),
    );
    for (const c of entry.range.components) {
      const prompt = focusPrompt(entry.range, c);
      rows.push(
        Item({
          title: html`<strong>${c.name}</strong>${c.rules ? html`<span class="mono sm t3 rule-note">rules: ${c.rules}</span>` : ""}`,
          line: html`<span class="mono sm">owns: ${c.owns.join(", ")}</span>`,
          trail: html`<a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(entry.repo)}&prompt=${encodeURIComponent(prompt)}">Focus agent</a>`,
        }),
      );
    }
  }

  // Docs
  const docEntries = Object.entries(entry.range.docs ?? {}).filter(([, p]) => typeof p === "string" && p.trim().length > 0);
  if (docEntries.length) {
    rows.push(
      Item({
        title: html`<span class="sub-h">Docs (${docEntries.length})</span>`,
        quiet: true,
      }),
    );
    for (const [key, docPath] of docEntries) {
      rows.push(
        Item({
          title: html`<strong>${key}</strong> <span class="mono sm t3">${docPath}</span>`,
          trail: html`<a class="btn sm ghost" href="/code/${encodeURIComponent(entry.repo)}?path=${encodeURIComponent(docPath as string)}">Read →</a>`,
        }),
      );
    }
  }

  return Panel({
    id: entry.repo,
    title: html`${entry.range.name} ${entry.range.tier ? Pill({ tone: tierTone(entry.range.tier), children: entry.range.tier }) : ""}`,
    actions: repoLinks(entry),
    flush: true,
    children: html`
      ${entry.range.description ? html`<p class="panel-note">${entry.range.description}</p>` : ""}
      ${rows.length ? List(rows) : ""}
    `,
  });
}

function bareItem(repo: string): Html {
  return Item({
    title: html`<strong>${repo}</strong>`,
    line: html`<span class="t3">No range.yaml manifest found</span>`,
    trail: html`
      <div class="buttons">
        <a class="btn sm ghost" href="/code/${encodeURIComponent(repo)}">Code</a>
        <a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(repo)}">Agent</a>
      </div>
    `,
  });
}

/** The page's body; the pack's route puts it in Dovre's shell. */
export function atlasPage(
  opts: {
    entries: AtlasEntry[];
    bare?: string[];
    filter?: string;
  },
): Html {
  const { entries, bare = [], filter } = opts;
  const filtered = filter ? entries.filter((e) => (e.range.tier ?? "").toLowerCase() === filter.toLowerCase()) : entries;

  const tiers = Array.from(new Set(entries.map((e) => (e.range.tier ?? "").toLowerCase()).filter(Boolean))) as string[];
  const tabs =
    tiers.length > 0
      ? Tabs({
          label: "Atlas Tiers",
          items: [
            { href: "/atlas", label: "All", n: entries.length, current: !filter },
            ...tiers.map((t) => ({
              href: `/atlas?tier=${encodeURIComponent(t)}`,
              label: t[0].toUpperCase() + t.slice(1),
              n: entries.filter((e) => (e.range.tier ?? "").toLowerCase() === t).length,
              current: (filter ?? "").toLowerCase() === t,
            })),
          ],
        })
      : undefined;

  const sub = `${entries.length} cataloged ${entries.length === 1 ? "project" : "projects"}${bare.length ? ` · ${bare.length} uncataloged` : ""}. What each repo is, what owns what, and what to read.`;

  const body = html`
    ${PageHeader({
      title: "Repo Atlas",
      sub,
      tabs,
      actions: html`
        <a class="btn" href="/atlas?refresh=1">Rescan</a>
        <a class="btn primary" href="/agents/new">New agent session</a>
      `,
    })}
    <div data-live id="atlas">
      ${filtered.map(repoPanel)}
      ${!filter && bare.length > 0 ? Panel({ title: "Uncataloged Checkouts", meta: String(bare.length), flush: true, children: List(bare.map(bareItem)) }) : ""}
    </div>
  `;

  return body;
}

/** The prompt that focuses an agent on one component. */
const focusPrompt = (range: Range, c: Range["components"][number]) =>
  `Focus on component "${c.name}" (${c.owns.join(", ")}) in ${range.name}${c.rules ? `, following rules in ${c.rules}` : ""}: `;

/** /agents/new's "agents.new" slot: a checkout's components, each a link that sets the prompt. */
export function componentField(repo: string, range: Range | undefined): Html | "" {
  if (!range?.components?.length) return "";
  return html`<div class="field"><span class="label">Component</span><div class="buttons">${range.components.map(
    (c) => html`<a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(repo)}&prompt=${encodeURIComponent(focusPrompt(range, c))}" title="Owns: ${c.owns.join(", ")}">${c.name}</a>`,
  )}</div><span class="hint">Clicking a component sets boundaries and loads component rules.</span></div>`;
}

/** A PR row's "pr.lead" slot: its repo's tier. */
export function prLead(range: Range | undefined): Html | "" {
  return range ? html` ${Pill({ tone: "neutral", children: range.tier })}` : "";
}

/** A PR's "pr.facts" slot: its repo's tier, site and docs (links into /code). */
export function prFacts(repo: string, range: Range | undefined): [string, Html][] {
  if (!range) return [];
  const short = repo.replace(/^.*\//, "");
  const docs = Object.entries(range.docs);
  return [
    [
      "Atlas",
      html`${Pill({ tone: "ok", children: `tier: ${range.tier}` })}${range.url ? html` ${Link(range.url, range.name)}` : html` <strong>${range.name}</strong>`}${
        docs.length ? html` · docs: ${docs.map(([k, path], i) => html`${i ? ", " : ""}${Link(`/code/${short}?path=${encodeURIComponent(path)}`, k)}`)}` : ""
      }`,
    ],
  ];
}

/** New work's "work.new" slot: the cataloged projects, each with its docs and an agent. */
export function projectsPanel(entries: AtlasEntry[]): Html | "" {
  if (!entries.length) return "";
  const items = entries.map((e) =>
    Item({
      href: `/code/${e.repo}`,
      title: html`<strong>${e.range.name}</strong> ${Pill({ tone: "ok", children: `tier: ${e.range.tier}` })}`,
      line: e.range.description ?? "",
      more: html`${e.range.url ? Link(e.range.url, "Live site ↗") : ""}${Object.entries(e.range.docs).map(([k, p]) => html` · ${Link(`/code/${e.repo}?path=${encodeURIComponent(p)}`, k)}`)}`,
      trail: html`<a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(e.repo)}">Start agent</a>`,
    }),
  );
  return Panel({ title: "Projects", flush: true, children: List(items) });
}

/** What Bino is told: a line per cataloged repo, kept within what a pack may say (APP_CHARS). */
export function binoLines(entries: AtlasEntry[], max = 1400): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, { repo, range }] of entries.entries()) {
    const comps = range.components?.length ? ` Components: ${range.components.slice(0, 6).map((c) => `${c.name} (${c.owns.join(", ")})`).join("; ")}${range.components.length > 6 ? ` (and ${range.components.length - 6} more)` : ""}.` : "";
    const docs = Object.entries(range.docs ?? {}).slice(0, 6).map(([k, p]) => `${k}: ${p}`).join(", ");
    const l = `- ${repo}${range.tier ? ` [${range.tier}]` : ""}: ${(range.description ?? range.name).replace(/\s+/g, " ").slice(0, 100)}.${comps}${docs ? ` Docs: ${docs}.` : ""}`.slice(0, 400);
    if (used + l.length > max) {
      out.push(`- (and ${entries.length - i} more cataloged repositories)`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}
