/**
 * The Data tab (src/data/db.ts, src/data/prod.ts): databases through db, read-only. Pick a database,
 * see its tables, look at a table's columns and first rows, or write a query. Test databases open
 * straight away; a production one after db's own question is answered in the bar. What comes back
 * is drawn on this response only: not kept, not in any other page, and never fetched again by a
 * live update (data pages listen to no topic; only the production gate does).
 */
import { html } from "hono/html";
import type { Column, Found, Rows, TableInfo, Target } from "../data/db.ts";
import { db2Name, isDb2, MAX_ROWS, MAX_SQL } from "../data/db.ts";
import { type Frame, shell } from "../html.ts";
import type { ProdState } from "../data/prod.ts";
import { schemaSource } from "../data/schema.ts";
import { type Across, type Job, MAX_PICKS, MAX_QUESTION, type Pick, type Proposal } from "../data/agent.ts";
import { type Child, Empty, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { safeUrl } from "./parts.ts";

const CURRENT = "/data";
const SUB = "Your databases through db, read-only. What you look at stays on the page.";
const PROD_NOTE = "Real customer data. db asks before it opens each database, in the bar at the top; a yes holds until 30 minutes pass without a query, or Close.";

export const dbHref = (t: string, find?: string) => safeUrl(`/data/db?t=${encodeURIComponent(t)}${find ? `&find=${encodeURIComponent(find)}` : ""}`);
export const tableHref = (t: string, table: string) => safeUrl(`/data/table?t=${encodeURIComponent(t)}&n=${encodeURIComponent(table)}`);

/** No live updates by default: one would fetch the page again, and with it run the database's calls again. */
const page = (frame: Frame, title: string, body: Child, topics = "data") => shell({ title: `${title} · Data · Dovre`, frame, current: CURRENT, body: html`${body}`, head: html`<meta name="u-topics" content="${topics}">` });
const prodPill = Pill({ tone: "warn", children: "production" });
const closeProd = html`<form method="post" action="/data/prod/close"><button type="submit" class="ghost" title="Ends db's connection: it asks again next time">Close production</button></form>`;
const sqlHint = (t: string) => (isDb2(t) ? "DB2 SQL" : "T-SQL");
const crumbs = (t?: string) => [{ href: "/data", label: "Data" }, ...(t ? [{ href: dbHref(t), label: t }] : [])];

/** Many short links in columns: databases, tables, names found. `n`: a count or type at the right. */
const tgrid = (items: { href: string; name: Child; n?: string }[]) =>
  html`<ul class="tgrid">${items.map((i) => html`<li><a href="${i.href}"><span>${i.name}</span>${i.n ? html`<span class="n">${i.n}</span>` : ""}</a></li>`)}</ul>`;

/** One value as text: NULL said plainly, objects as JSON. */
function cell(v: unknown): Child {
  if (v === null || v === undefined) return html`<span class="t3">NULL</span>`;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 300 ? html`<span title="${s.slice(0, 4000)}">${s.slice(0, 300)}…</span>` : s;
}

/** Rows as a table that scrolls both ways inside the page. */
export function rowsTable(r: Rows): Child {
  if (!r.rows.length) return Empty({ title: "No rows" });
  return html`<div class="sheet"><table class="data cells"><thead><tr>${r.columns.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead><tbody>${r.rows.map(
    (row) => html`<tr>${r.columns.map((c) => html`<td>${cell(row[c])}</td>`)}</tr>`,
  )}</tbody></table></div>`;
}

const rowsMeta = (r: Rows) => `${r.rows.length}${r.capped ? `+ (the first ${MAX_ROWS})` : ""} ${r.rows.length === 1 ? "row" : "rows"} · ${(r.ms / 1000).toFixed(1)} s`;

/** The query box: the database, the SQL, Run. */
function queryForm(t: string, sql = "", ask?: string): Child {
  const warehouse = isDb2(t);
  return html`<form method="post" action="/data/q" class="query" data-ctrl-enter><input type="hidden" name="t" value="${t}">${ask ? html`<input type="hidden" name="ask" value="${ask}">` : ""}<label class="field"><span class="label">Query</span><textarea name="sql" rows="${Math.min(18, Math.max(5, sql.split("\n").length + 1))}" maxlength="${MAX_SQL}" required spellcheck="false" autocomplete="off" class="mono"${schemaSource(t) ? html` data-schema="/data/schema?t=${encodeURIComponent(t)}"` : ""} placeholder="${warehouse ? "SELECT * FROM DWH.VIEW FETCH FIRST 100 ROWS ONLY" : "SELECT TOP 100 * FROM schema.table"}">${sql}</textarea><span class="hint">${sqlHint(t)}, reads only (db refuses anything else). The first ${MAX_ROWS} rows show. Ctrl+Enter runs it.${schemaSource(t) ? " Tables and columns complete as you type: Tab or Enter takes one, Esc closes." : ""}</span></label><div class="buttons"><button type="submit" class="primary" data-busy="Running">Run</button></div></form>`;
}

export function dataHome(frame: Frame, o: { targets: Target[]; problem?: string; off?: string; /** Production through db mcp, when db is there: what's open now, and what db is asking about. */ prod?: { opened: string[]; asking?: string[] }; /** The query agent is there: why it can't run, or nothing. */ agent?: { why?: string } }): ReturnType<typeof shell> {
  if (o.off) return page(frame, "Data", html`${PageHeader({ title: "Data", sub: SUB })}${Notice({ tone: "warn", children: o.off })}`);
  const at = o.targets.filter((t) => t.kind === "at");
  const local = o.targets.filter((t) => t.kind === "local");
  return page(
    frame,
    "Data",
    html`${PageHeader({ title: "Data", sub: SUB })}
${o.problem ? Notice({ tone: "bad", children: html`<strong>db didn't list the databases.</strong> ${o.problem} <span class="t2">Run <code>db doctor</code> in a terminal: VPN and <code>az login</code> are the usual causes.</span>` }) : ""}
${o.agent && at.length ? askAllBox(o.agent.why, !!o.prod) : ""}
${Panel({ title: "Test (at)", meta: String(at.length), flush: true, children: at.length ? tgrid(at.map((t) => ({ href: dbHref(t.id), name: t.label }))) : Empty({ title: "None listed" }) })}
${Panel({ title: "Local (docker)", meta: String(local.length), flush: true, children: local.length ? tgrid(local.map((t) => ({ href: dbHref(t.id), name: t.label }))) : Empty({ title: "The local SQL Server isn't answering", children: html`<p class="t2">Start its container to look at it here.</p>` }) })}
${o.prod ? prodPanel(at, o.prod.opened, o.prod.asking ?? []) : ""}`,
  );
}

export function dataTarget(frame: Frame, o: { t: string; prod?: boolean; tables?: TableInfo[]; found?: Found[]; find?: string; error?: string; /** The query agent is there: why it can't run, or nothing. */ agent?: { why?: string } }) {
  const bySchema = new Map<string, TableInfo[]>();
  for (const x of o.tables ?? []) bySchema.set(x.schema, [...(bySchema.get(x.schema) ?? []), x]);
  const found = o.found
    ? Panel({
        title: html`Names with “${o.find}”`,
        meta: String(o.found.length),
        flush: true,
        children: o.found.length ? tgrid(o.found.slice(0, 300).map((f) => ({ href: tableHref(o.t, `${f.schema}.${f.table}`), name: html`${f.schema}.${f.table}${f.column ? html` <code>${f.column}</code>` : ""}`, n: f.type }))) : Empty({ title: "Nothing by that name" }),
      })
    : "";
  return page(
    frame,
    o.t,
    html`${PageHeader({ title: o.t, crumbs: crumbs(), sub: html`${o.prod ? html`${prodPill} ` : ""}Tables with their row counts, biggest first. Read-only.`, actions: o.prod ? closeProd : undefined })}
${o.error ? Notice({ tone: "bad", children: html`<strong>db said:</strong> ${o.error}` }) : ""}
${o.agent ? askBox(o.t, o.agent.why) : ""}
${Panel({ title: "Ask it", children: queryForm(o.t) })}
<form method="get" action="/data/db" class="find"><input type="hidden" name="t" value="${o.t}"><label class="field"><span class="label">Find a table or column</span><input type="search" name="find" value="${o.find ?? ""}" maxlength="64" placeholder="Part of a name"></label><div class="buttons"><button type="submit">Find</button></div></form>
${found}
${[...bySchema].map(([schema, list]) =>
  Panel({ title: schema, meta: String(list.length), flush: true, children: tgrid(list.map((x) => ({ href: tableHref(o.t, `${x.schema}.${x.table}`), name: x.table, n: x.rows !== undefined ? x.rows.toLocaleString("nb-NO") : undefined }))) }),
)}
${o.tables && !o.tables.length && !o.error ? Empty({ title: "No tables" }) : ""}`,
  );
}

export function dataTable(frame: Frame, o: { t: string; prod?: boolean; table: string; cols?: Column[]; peek?: Rows; error?: string; agent?: { why?: string } }) {
  const cols = o.cols?.length
    ? html`<div class="sheet"><table class="data"><thead><tr><th scope="col">#</th><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Null</th><th scope="col">Key</th></tr></thead><tbody>${o.cols.map(
        (c) => html`<tr><td class="t3">${c.pos ?? ""}</td><td><strong>${c.column}</strong></td><td><code>${c.type ?? ""}</code></td><td>${c.nullable === "NOT NULL" ? "" : "null"}</td><td>${c.key ?? ""}</td></tr>`,
      )}</tbody></table></div>`
    : Empty({ title: "No columns" });
  return page(
    frame,
    o.table,
    html`${PageHeader({ title: o.table, crumbs: crumbs(o.t), sub: html`${o.prod ? html`${prodPill} ` : ""}${o.t}`, actions: o.prod ? closeProd : undefined })}
${o.error ? Notice({ tone: "bad", children: html`<strong>db said:</strong> ${o.error}` }) : ""}
${o.cols ? Panel({ title: "Columns", meta: String(o.cols.length), flush: true, children: cols }) : ""}
${o.peek ? Panel({ title: "First rows", meta: rowsMeta(o.peek), flush: true, children: rowsTable(o.peek) }) : ""}
${o.agent ? askBox(o.t, o.agent.why) : ""}
${Panel({ title: "Ask it", children: queryForm(o.t, isDb2(o.t) ? `SELECT *\nFROM ${o.table}\nFETCH FIRST 100 ROWS ONLY` : `SELECT TOP 100 *\nFROM ${o.table}`) })}`,
  );
}

export function dataResult(frame: Frame, o: { t: string; prod?: boolean; sql: string; rows?: Rows; error?: string; /** The agent's question this query answers: a Review button. */ ask?: string }) {
  return page(
    frame,
    "Query",
    html`${PageHeader({ title: "Query", crumbs: crumbs(o.t), sub: html`${o.prod ? html`${prodPill} ` : ""}${o.t} · read-only · not kept: run it again to see it again.`, actions: o.prod ? closeProd : undefined })}
${Panel({ children: queryForm(o.t, o.sql, o.ask) })}
${o.error ? Notice({ tone: "bad", children: html`<strong>db said:</strong> ${o.error}` }) : ""}
${o.rows ? Panel({ title: "Result", meta: rowsMeta(o.rows), flush: true, children: rowsTable(o.rows) }) : ""}
${o.ask && (o.rows || o.error) ? reviewForm(o.t, o.sql, o.ask) : ""}`,
  );
}

/** Production: each app's database (named as in at) and the DB2 one (DATA_DB2), the open ones marked; several can be asked for at once. */
function prodPanel(at: Target[], opened: string[], asking: string[]): Child {
  const db2 = db2Name();
  const list = [...at.map((t) => ({ id: `${t.label}:prod`, label: t.label })), ...(db2 ? [{ id: `${db2}:prod`, label: db2 }] : [])];
  const shut = list.filter((t) => !opened.includes(t.id) && !asking.includes(t.id));
  return Panel({
    title: html`Production ${prodPill}`,
    meta: opened.length ? `${opened.length} open` : String(list.length),
    actions: opened.length ? closeProd : undefined,
    children: html`<p class="t2">${PROD_NOTE}</p>${tgrid(list.map((t) => ({ href: dbHref(t.id), name: t.label, n: opened.includes(t.id) ? "open" : asking.includes(t.id) ? "asking" : undefined })))}
${shut.length ? html`<form method="post" action="/data/prod/open" class="field"><fieldset><legend class="label">Ask to open several at once</legend>${shut.map((t) => html`<label class="check"><input type="checkbox" name="t" value="${t.id}"> ${t.label}</label>`)}</fieldset><div class="buttons"><button type="submit" data-busy="Asking">Ask to open the ticked</button><span class="hint">db asks about each in the bar; Allow all answers them together.</span></div></form>` : ""}`,
  });
}

/**
 * A production database that isn't open. Nothing has been asked of db until I press the button;
 * then db's question is in the bar, and this page follows along (the only Data page that does).
 */
export function dataGate(frame: Frame, o: { t: string; asking?: boolean } & ProdState) {
  const ask = html`<form method="post" action="/data/prod/open"><input type="hidden" name="t" value="${o.t}"><button type="submit" class="primary" data-busy="Asking">Ask to open ${o.t}</button></form>`;
  const body =
    o.state === "asking"
      ? Notice({ tone: "warn", children: o.asking ? html`<p><strong>db asks in the bar at the top.</strong> Allow opens ${o.t} until 30 minutes pass without a query; Deny keeps it closed.</p>` : html`<p>Opening ${o.t}…</p>` })
      : o.state === "refused"
        ? Notice({ tone: "bad", children: html`<p><strong>${o.t} stays closed.</strong> ${o.said ?? ""}</p><p class="t2">db keeps a no until its connection ends. Close production to be asked again.</p><div class="buttons">${closeProd}</div>` })
        : html`${o.said ? Notice({ tone: "bad", children: html`<strong>db said:</strong> ${o.said}` }) : ""}${Notice({ tone: "warn", children: html`<p>${PROD_NOTE}</p><div class="buttons">${ask}</div>` })}`;
  return page(
    frame,
    o.t,
    html`${PageHeader({ title: o.t, crumbs: crumbs(), sub: html`${prodPill} Not open` })}<div data-live id="prod-gate"${o.state === "asking" ? html` data-pending` : ""}>${body}</div>`,
    "snapshot prod",
  );
}

// ── The query agent (src/data/agent.ts): a question in plain words, a proposed query, a review ──

export const askHref = (id: string) => `/data/ask/${encodeURIComponent(id)}`;
const AGENT_NOTE = "A Copilot model writes it from the table and column names (from the test copy). It never sees rows unless you ask it to review a result.";

/** Under a result from the agent's query: one click gives that result to the agent to say what it means. */
function reviewForm(t: string, sql: string, ask: string): Child {
  return html`<form method="post" action="${askHref(ask)}/review" class="buttons"><input type="hidden" name="t" value="${t}"><input type="hidden" name="sql" value="${sql}"><button type="submit" data-busy="Asking">Review this result</button><span class="hint">Runs the query again and gives the rows to the Copilot model, to say what they mean. Kept nowhere.</span></form>`;
}

/** The box to ask in plain words, on a database's pages; why not, when the agent can't run. */
export function askBox(t: string, why?: string): Child {
  if (!schemaSource(t)) return "";
  return Panel({
    title: "Ask in plain words",
    children: why
      ? html`<p class="notes">${why}</p>`
      : html`<form method="post" action="/data/ask" class="query" data-ctrl-enter><input type="hidden" name="t" value="${t}"><label class="field"><span class="label">Question</span><textarea name="question" rows="2" maxlength="${MAX_QUESTION}" required placeholder="How many policies were sold per product last month?"></textarea><span class="hint">${AGENT_NOTE}</span></label><div class="buttons"><button type="submit" class="primary" data-busy="Asking">Write the query</button></div></form>`,
  });
}

/** One question: thinking, then the query as a card to run (or the agent's question back), and its review of a result. */
export function askPage(frame: Frame, j: Job, o: { prod?: boolean; model?: string } = {}) {
  const proposal = (p: Proposal, title: string) => Panel({ title, children: html`${p.says ? html`<p>${p.says}</p>` : ""}${queryForm(j.t, p.sql, j.id)}` });
  const body =
    j.state === "thinking"
      ? html`<p class="notes" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Writing the query…</p>`
      : j.state === "failed"
        ? Notice({ tone: "bad", children: j.error ?? "The agent didn't answer." })
        : j.state === "asks"
          ? html`${Notice({ children: html`<strong>The agent asks:</strong> ${j.back}` })}<form method="post" action="/data/ask" class="query" data-ctrl-enter><input type="hidden" name="t" value="${j.t}"><input type="hidden" name="question" value="${j.question}"><label class="field"><span class="label">Your answer</span><textarea name="more" rows="2" maxlength="${MAX_QUESTION}" required></textarea></label><div class="buttons"><button type="submit" class="primary" data-busy="Asking">Ask again</button></div></form>`
          : proposal(j.proposal!, "The query");
  const review = j.review
    ? j.review.state === "thinking"
      ? html`<p class="notes" aria-live="polite" id="review"><span class="spinner" aria-hidden="true"></span> Looking at the result…</p>`
      : j.review.state === "failed"
        ? Notice({ tone: "bad", children: html`<strong>No review:</strong> ${j.review.error}` })
        : html`${Panel({ title: "What the result says", children: html`<div id="review" class="ask-review">${j.review.text}</div>` })}${j.review.proposal ? proposal(j.review.proposal, "A better query") : ""}`
    : "";
  return page(
    frame,
    "Ask",
    html`${PageHeader({ title: j.question.split("\n")[0]!.slice(0, 120), crumbs: crumbs(j.t), sub: html`${o.prod ? html`${prodPill} ` : ""}${j.t} · written by ${o.model || "a Copilot model"} · kept only until Dovre restarts` })}
<div data-live id="ask-${j.id}"${j.state === "thinking" || j.review?.state === "thinking" ? html` data-pending` : ""}>${body}${review}</div>`,
    `data-ask:${j.id}`,
  );
}

// ── One question across databases (WP-A21) ──

export const acrossHref = (id: string) => `/data/across/${encodeURIComponent(id)}`;

/** The box on /data: one question, and the agent picks where to ask it. */
export function askAllBox(why: string | undefined, prod: boolean): Child {
  return Panel({
    title: "Ask across databases",
    children: why
      ? html`<p class="notes">${why}</p>`
      : html`<form method="post" action="/data/across" class="query" data-ctrl-enter><label class="field"><span class="label">Question</span><textarea name="question" rows="2" maxlength="${MAX_QUESTION}" required placeholder="Where do we keep a customer's consents, and how many have one?"></textarea><span class="hint">A Copilot model picks up to ${MAX_PICKS} databases from each app's table names${prod ? ", in test or production" : ""}, and writes a query for each. You run each one yourself${prod ? "; production still asks first" : ""}. It never sees rows unless you ask it to review a result.</span></label><div class="buttons"><button type="submit" class="primary" data-busy="Asking">Find where to ask</button></div></form>`,
  });
}

/** One card per database the agent picked, each filling in as its query is written. */
function pickCard(p: Pick, j: Job | undefined): Child {
  const prod = p.t.endsWith(":prod");
  const body = !j
    ? Notice({ tone: "bad", children: "This card is gone (Dovre keeps the last 30)." })
    : j.state === "thinking"
      ? html`<p class="notes"><span class="spinner" aria-hidden="true"></span> Writing the query…</p>`
      : j.state === "failed"
        ? Notice({ tone: "bad", children: j.error ?? "The agent didn't answer." })
        : j.state === "asks"
          ? html`${Notice({ children: html`<strong>The agent asks:</strong> ${j.back}` })}<p><a href="${askHref(j.id)}">Answer it</a></p>`
          : html`${j.proposal!.says ? html`<p>${j.proposal!.says}</p>` : ""}${queryForm(p.t, j.proposal!.sql, j.id)}`;
  return Panel({
    title: html`<a href="${dbHref(p.t)}">${p.t}</a>${prod ? html` ${prodPill}` : ""}`,
    meta: j ? html`<a href="${askHref(j.id)}">Open</a>` : undefined,
    children: html`${p.why ? html`<p class="t2">${p.why}</p>` : ""}${body}`,
  });
}

export function acrossPage(frame: Frame, a: Across, jobs: (id: string) => Job | undefined, o: { model?: string } = {}) {
  const pending = a.state === "picking" || a.picks.some((p) => jobs(p.job)?.state === "thinking");
  const unread = a.unread?.length ? Notice({ tone: "warn", children: html`Couldn't read the tables of ${a.unread.join(", ")}: the agent didn't see ${a.unread.length === 1 ? "it" : "them"}.` }) : "";
  const body =
    a.state === "picking"
      ? html`<p class="notes" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Reading each app's tables and picking where to ask…</p>`
      : a.state === "failed"
        ? Notice({ tone: "bad", children: a.error ?? "The agent didn't answer." })
        : a.state === "asks"
          ? html`${Notice({ children: html`<strong>The agent asks:</strong> ${a.back}` })}<form method="post" action="/data/across" class="query" data-ctrl-enter><input type="hidden" name="question" value="${a.question}"><label class="field"><span class="label">Your answer</span><textarea name="more" rows="2" maxlength="${MAX_QUESTION}" required></textarea></label><div class="buttons"><button type="submit" class="primary" data-busy="Asking">Ask again</button></div></form>`
          : a.picks.map((p) => pickCard(p, jobs(p.job)));
  return page(
    frame,
    "Ask across",
    html`${PageHeader({ title: a.question.split("\n")[0]!.slice(0, 120), crumbs: crumbs(), sub: html`Across databases · picked and written by ${o.model || "a Copilot model"} · kept only until Dovre restarts` })}
<div data-live id="across-${a.id}"${pending ? html` data-pending` : ""}>${unread}${body}</div>`,
    `data-ask:${a.id}`,
  );
}
