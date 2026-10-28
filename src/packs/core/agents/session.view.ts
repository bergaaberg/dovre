/** Talking to an agent: its conversation, what it's doing now, permission asks, a reply box. And starting a new one. Pages for ctx.page. */
import { html } from "hono/html";
import { dovreParts, NO, type Question, type Turn } from "../../../agents/conversation.ts";
import type { Copy } from "../../../agents/desk.ts";
import type { Queued } from "../../../agents/queue.ts";
import type { HarnessId, Run } from "../../../agents/runner.ts";
import { WORK, WORK_LABEL } from "../../../agents/workdir.ts";
import type { PageOpts } from "../../types.ts";
import { HARNESS_LABEL, MODE_SHORT, modelSelect, modeSelect } from "../../../pages/models.ts";
import type { Session } from "../../../sources/claude.ts";
import { type Child, Confirm, Empty, Notice, PageHeader, Panel, Pill, icon } from "../../../ui/kit.ts";
import { markdown } from "../../../ui/markdown.ts";
import { Ago, HARNESS_NAME, harnessTag, type MacStatus, macNotice, resumeCommand, safeUrl, trunc } from "../../../pages/parts.ts";
import { sandboxKind } from "../../../actions/sandbox.ts";


/**
 * A question the agent put (AskUserQuestion), with the choices it offered. The newest one, when
 * nothing has happened since, can be answered here: the answer goes to the agent as the next
 * message (in a copy of the session when a terminal still has it open).
 */
function askView(questions: Question[], o: { sid: string; answerable: boolean; mode?: string; model?: string; inTerminal?: boolean }) {
  const qs = questions.map((q, i) => {
    const kind = q.multiSelect ? "checkbox" : "radio";
    const choices = q.options.map((op, j) =>
      o.answerable
        ? html`<label class="ask-o"><input type="${kind}" name="a${i}" value="${j}"><span><strong>${op.label}</strong>${op.description ? html`<span class="ask-d">${op.description}</span>` : ""}</span></label>`
        : html`<div class="ask-o"><span><strong>${op.label}</strong>${op.description ? html`<span class="ask-d">${op.description}</span>` : ""}</span></div>`,
    );
    return html`<fieldset class="ask-q"><legend>${q.header ? html`<span class="ask-h">${q.header}</span>` : ""}${q.question}${q.multiSelect ? html` <span class="t3">(pick any)</span>` : ""}</legend>${choices}${
      o.answerable ? html`<label class="ask-o other"><span class="t2">Something else</span><input type="text" name="o${i}" maxlength="500" placeholder="Your own answer"></label>` : ""
    }</fieldset>`;
  });
  if (!o.answerable) return html`<li class="turn-row ask" data-stop="2"><div class="ask-card"><div class="who">The agent asked</div>${qs}</div></li>`;
  return html`<li class="turn-row ask" data-stop="2"><form method="post" action="/agents/s/${o.sid}/answer" class="ask-card"><div class="who">The agent asks you</div>${qs}<input type="hidden" name="mode" value="${o.mode ?? "default"}"><input type="hidden" name="model" value="${o.model ?? ""}"><div class="buttons"><button type="submit" class="primary" data-busy="Sending">Answer</button>${
    o.inTerminal ? html`<span class="t3">Answering here continues a copy of the session; the terminal still shows the question.</span>` : ""
  }</div></form></li>`;
}

/**
 * One turn of the conversation. Messages read as a chat: mine in a bubble at the right, the agent's
 * as text with its tool calls as one quiet line; "Agent" and the time only where its run starts.
 */
function turnView(t: Turn, ask: { sid: string; answerable: boolean; mode?: string; model?: string; inTerminal?: boolean }, prev?: Turn) {
  if (t.role === "ask") return askView(t.questions, ask);
  if (t.role === "user") {
    // What Dovre wrote for me (started a copy, allowed calls) reads as a line; what I wrote, as a bubble.
    const d = dovreParts(t.text);
    const notes = html`${d.copy ? html`<li class="turn-row meta mine t3"><span>Copy started here${t.at ? html` · ${Ago(t.at)}` : ""}</span></li>` : ""}${
      d.allowed ? html`<li class="turn-row meta mine t3"><span>You allowed ${d.allowed.slice(0, 4).map((a, i) => html`${i ? ", " : ""}<code>${trunc(a, 90)}</code>`)}${d.allowed.length > 4 ? ` and ${d.allowed.length - 4} more` : ""}${t.at ? html` · ${Ago(t.at)}` : ""}</span></li>` : ""
    }`;
    if (!d.rest) return notes;
    return html`${notes}<li class="turn-row user" data-stop="1" data-stop-label="${trunc(d.rest, 120)}"><div class="bubble">${markdown(trunc(d.rest, 8000), { headingOffset: 3 })}</div>${t.at ? html`<div class="who">${Ago(t.at)}</div>` : ""}</li>`;
  }
  const starts = !prev || prev.role === "user" || prev.role === "ask";
  const who = starts ? html`<div class="who">Agent${t.role === "assistant" && t.at ? html` · ${Ago(t.at)}` : ""}</div>` : "";
  if (t.role === "assistant") return html`<li class="turn-row agent${starts ? " first" : ""}" data-stop="2">${who}<div class="bubble">${markdown(t.text, { headingOffset: 3 })}</div></li>`;
  return html`<li class="turn-row tools${starts ? " first" : ""}">${who}<details><summary>${t.calls.length === 1 ? html`<code>${t.calls[0]!.name}</code> <span>${trunc(t.calls[0]!.detail, 90)}</span>` : html`${t.calls.length} tool calls: ${[...new Set(t.calls.map((c) => c.name))].join(", ")}`}</summary><ul class="calls">${t.calls.map(
    (c) => html`<li><code>${c.name}</code> <span class="t2">${c.detail}</span></li>`,
  )}</ul></details></li>`;
}

/**
 * The calls a turn was refused, asked about together: each ticked, one click allows the ticked
 * ones (each exactly as refused, for the next turn only) and the agent goes on. "No" says so.
 */
function permissionCard(all: Extract<Run["events"][number], { t: "denied" }>[], run: Run, sessionId: string) {
  // Refused though this turn had it allowed: Claude Code refuses it whatever Dovre allows, so no Allow for it (#163).
  const again = all.filter((d) => run.allowed.includes(d.spec));
  const denied = all.filter((d) => !run.allowed.includes(d.spec));
  const stuck = again.length
    ? html`<li class="turn-row">${Notice({
        tone: "warn",
        children: html`<p><strong>Allowed, and refused again.</strong> Claude Code refuses some calls whatever Dovre allows, most often a command that touches a folder outside the project (like <code>/tmp</code>). Allowing it again won't help: tell the agent to work inside the repo instead.</p>${again.map((d) => html`<pre class="output">${d.detail || d.spec}</pre>`)}`,
      })}</li>`
    : "";
  if (!denied.length) return stuck;
  const what = denied.length === 1 ? `Wants to run ${denied[0]!.tool}` : `Wants to run ${denied.length} calls`;
  return html`${stuck}<li class="turn-row ask" data-stop="2"><form method="post" action="/agents/s/${sessionId}/allow" class="ask-card perm"><div class="who">${what}</div>${denied.map(
    (d) => html`<label class="ask-o"><input type="checkbox" name="spec" value="${d.spec}" checked><span><strong>${d.tool}</strong><pre class="output">${d.detail}</pre></span></label>`,
  )}<input type="hidden" name="mode" value="${run.mode}"><input type="hidden" name="model" value="${run.model}"><div class="buttons"><button type="submit" class="primary" data-busy="Allowing" data-hotkey="A" title="Each exactly as it was refused, for the next turn only (A)">${denied.length === 1 ? "Allow and go on" : "Allow ticked and go on"}</button><button type="submit" form="deny-${sessionId}" class="ghost">No</button></div></form><form method="post" action="/agents/s/${sessionId}/reply" id="deny-${sessionId}" hidden><input type="hidden" name="prompt" value="${NO}"><input type="hidden" name="mode" value="${run.mode}"><input type="hidden" name="model" value="${run.model}"></form></li>`;
}

/** What the current run in Dovre is doing, after the transcript's turns. */
function liveRun(run: Run, sessionId: string, o: { askShown?: boolean; turnCost?: number; /** The transcript has this run's turns already: don't list its calls twice. */ written?: boolean } = {}) {
  const turnCostOf = o.turnCost ?? run.cost;
  // A run's question shows from the transcript when there is one; otherwise from the run itself.
  const asks = o.askShown ? [] : run.events.filter((e): e is Extract<Run["events"][number], { t: "ask" }> => e.t === "ask");
  const tools = o.written ? [] : run.events.filter((e) => e.t === "tool").slice(-6);
  // The same call refused twice is one ask.
  const denied = [...new Map(run.events.filter((e): e is Extract<Run["events"][number], { t: "denied" }> => e.t === "denied").map((d) => [d.spec, d])).values()];
  const errors = run.events.filter((e) => e.t === "error");
  const result = [...run.events].reverse().find((e) => e.t === "result") as Extract<Run["events"][number], { t: "result" }> | undefined;
  return html`${
    run.status === "running"
      ? html`<li class="turn-row agent live" data-stop="2"><div class="who"><span class="dot ok" aria-hidden="true"></span>Agent is working · ${run.sandbox ? "in a sandbox, without asking" : (MODE_SHORT[run.mode] ?? run.mode)}</div><div class="bubble">${run.partial ? markdown(run.partial, { headingOffset: 3 }) : !tools.length && !o.written ? html`<p class="t3">Thinking…</p>` : ""}${
          tools.length ? html`<ul class="calls" data-grow>${tools.map((e) => (e.t === "tool" ? html`<li><code>${e.name}</code> <span class="t2">${e.detail}</span></li>` : ""))}</ul>` : ""
        }</div></li>`
      : ""
  }${errors.map((e) => (e.t === "error" ? html`<li class="turn-row">${Notice({ tone: "bad", children: html`<pre class="output">${e.text}</pre>` })}</li>` : ""))}${
    result?.error ? html`<li class="turn-row">${Notice({ tone: "bad", children: result.text || "The run ended with an error." })}</li>` : ""
  }${denied.length ? permissionCard(denied, run, sessionId) : ""}${asks.map((a, i) => askView(a.questions, { sid: sessionId, answerable: run.status !== "running" && i === asks.length - 1, mode: run.mode, model: run.model }))}${run.status !== "running" && turnCostOf ? html`<li class="turn-row meta t3">Last turn cost $${turnCostOf.toFixed(3)}</li>` : ""}`;
}

/**
 * What a sandbox run made, once it ended (#206): its commits, brought home as a branch of the
 * checkout, the files they change, the agent's last word, and "Open draft PR" or "Discard".
 */
function sandboxPanel(run: Run) {
  const out = run.out;
  const result = [...run.events].reverse().find((e) => e.t === "result") as Extract<Run["events"][number], { t: "result" }> | undefined;
  const said = result && !result.error && result.text.trim() ? html`<div class="bubble">${markdown(trunc(result.text, 8000), { headingOffset: 3 })}</div>` : "";
  const discard = (what: string) => Confirm({ kind: "sandbox.discard", action: `/agents/r/${run.id}/discard`, label: "Discard", danger: true, question: what });
  const cost = run.cost ? html` · $${run.cost.toFixed(2)}` : "";
  const blocked = run.blocked ?? [];
  const allow = run.sandbox?.allow ?? [];
  // The network (#208): what it was refused, and where the list it may reach lives.
  const net = blocked.length
    ? html`<details><summary>${blocked.length} host${blocked.length === 1 ? "" : "s"} refused</summary><ul class="calls">${blocked.map((h) => html`<li><code>${h}</code></li>`)}</ul><p class="t3">The sandbox reaches the model API${allow.length ? html` and ${allow.map((h, i) => html`${i ? ", " : ""}<code>${h}</code>`)}` : ""} only. To let it reach more, list hosts under <code>allow</code> in the repo's <code>.dovre/sandbox.json</code>.</p></details>`
    : "";
  if (!out || out.state === "collecting") return Panel({ title: "What it made", children: html`<p class="t3">Bringing its commits out of the sandbox…</p>` });
  if (out.state === "none") return Panel({ title: "What it made", meta: html`no commits${cost}`, actions: discard("Discard this run and its sandbox?"), children: html`${said}<p class="t3">It changed nothing.</p>${net}` });
  if (out.state === "failed") return Panel({ title: "What it made", meta: cost, actions: discard("Discard this run and its sandbox? Its commits go with it."), children: html`${said}${Notice({ tone: "bad", children: out.why })}${net}` });
  const add = out.files.reduce((n, f) => n + f.add, 0);
  const del = out.files.reduce((n, f) => n + f.del, 0);
  const n = out.commits.length;
  const actions = out.pr
    ? html`<a class="btn" href="${safeUrl(out.pr.url)}" target="_blank" rel="noopener">Draft PR #${out.pr.number}</a>`
    : html`${Confirm({ kind: sandboxKind(out), action: `/agents/r/${run.id}/pr`, label: "Open draft PR", question: html`Push <code>${out.branch}</code> to ${out.repo ?? "origin"} and open a draft PR from it?${out.ci ? html` It changes CI config, which runs with the repo's secrets once pushed.` : ""}` })}${discard(`Discard ${n} commit${n === 1 ? "" : "s"}? The branch ${out.branch} and the sandbox go.`)}`;
  return Panel({
    title: "What it made",
    meta: html`${n} commit${n === 1 ? "" : "s"} · ${out.files.length} file${out.files.length === 1 ? "" : "s"} +${add} −${del}${cost}`,
    actions,
    children: html`${out.ci && !out.pr ? Notice({ tone: "warn", children: html`<strong>It changed CI config.</strong> A push runs the repo's workflows with its secrets: read the diff before you open the PR.` }) : ""}${said}
<p class="t3">On branch <code>${out.branch}</code> of the checkout${out.repo ? html` (${out.repo})` : ""}${out.pr ? ", pushed" : ", not pushed"}.</p>
<ul class="calls">${out.commits.map((c) => html`<li><code>${c.sha.slice(0, 7)}</code> <span class="t2">${c.subject}</span></li>`)}</ul>
<details><summary>${out.files.length} file${out.files.length === 1 ? "" : "s"} changed</summary><ul class="calls">${out.files.map((f) => html`<li><code>${f.path}</code> <span class="t2">+${f.add} −${f.del}</span></li>`)}</ul></details>${net}`,
  });
}

export function agentPage(opts: { sessionId: string; session?: Session; turns: Turn[]; run?: Run; flash?: string; /** Started here and ended: it can be cleared away. */ discardable?: boolean; /** What the newest turn cost by itself (src/agents/latest.ts). */ turnCost?: number; /** Written while it worked, waiting for the turn to end (src/agents/queue.ts). */ queued?: Queued[]; /** Hosted: the Mac's agents, online or not. */ mac?: MacStatus; /** What I send goes to a copy: a terminal has the session open. */ replyCopies?: boolean; /** Copies made of it from here. */ copies?: Copy[]; /** The session this one is a copy of. */ copyOf?: string; /** Local, in a checkout: its diff page (dovre#105). */ diff?: string }): PageOpts {
  const { sessionId, session: s, turns, run } = opts;
  const running = run?.status === "running";
  const inTerminal = !!opts.replyCopies;
  // The transcript already has this run's turns (it's written as the agent works).
  const written = !!run && turns.some((t) => t.at && Date.parse(t.at) >= run.startedAt);
  const title = s?.title ?? s?.name ?? `Session ${sessionId.slice(0, 8)}`;
  const status = running
    ? Pill({ tone: "ok", children: "working here" })
    : s?.live
      ? Pill({ tone: s.status === "busy" ? "ok" : "warn", children: s.status === "busy" ? "working in terminal" : s.status === "waiting" ? `waiting${s.waitingFor ? `: ${s.waitingFor}` : ""}` : "idle in terminal" })
      : Pill({ children: "ended" });
  const mode = run?.mode ?? "default";
  // One box: while the agent works, what I write waits for the turn to end (as in the terminal).
  const denied = !!run?.events.some((e) => e.t === "denied");
  // Copilot CLI's sessions are read here; turns in it don't start from Dovre yet.
  const readOnly = s?.harness === "copilot" && !run;
  // Hosted with the Mac offline: nothing to send to (the notice above says so).
  const reply = opts.mac?.online === false
    ? ""
    : run?.sandbox
    ? running
      ? html`<form method="post" action="/agents/s/${sessionId}/stop" class="inline"><button type="submit" class="danger sm" title="Stop the sandbox run (.)" data-hotkey=".">Stop</button></form>${Notice({ children: "A sandbox run takes one prompt, so there's no replying. When it ends, its commits come home as a branch you can open a draft PR from." })}`
      : sandboxPanel(run)
    : readOnly
    ? Notice({ children: html`Copilot CLI sessions are read here, not replied to yet. To carry on in a terminal: <code data-copy="${resumeCommand(s!)}">${resumeCommand(s!)}</code>` })
    : html`${running ? html`<form method="post" action="/agents/s/${sessionId}/stop" id="stop-form" hidden></form>` : ""}${
      inTerminal ? Notice({ tone: "warn", children: html`<strong>Open in a terminal.</strong> What you send here starts a copy of this session. The copy doesn't see what the terminal does next, and the terminal never sees the copy.` }) : ""
    }<form method="post" action="/agents/s/${sessionId}/reply" class="chatbox">
<div class="chatbox-in"><textarea name="prompt" rows="1" required aria-label="${running ? "Message for after this turn" : "Reply"}" placeholder="${running ? "Working… write now, it goes when this turn ends" : inTerminal ? "Reply in a copy…" : "Reply…"}" data-enter-send spellcheck="false"></textarea>${
    running ? html`<button type="submit" form="stop-form" class="danger sm" title="Stop this turn (.)" data-hotkey=".">Stop</button>` : ""
  }<button type="submit" class="primary send" data-busy="…" title="${running ? "Queue (Enter)" : "Send (Enter)"}" aria-label="${running ? "Queue" : inTerminal ? "Send to a copy" : "Send"}">${icon("arrow")}</button></div>
<div class="chatbox-opts"><details class="chat-opts"><summary>${MODE_SHORT[mode] ?? mode} · ${run?.model || "default model"}</summary><div class="fields">${modeSelect(run?.mode)}${modelSelect(run?.model, [run?.harness ?? (s?.harness === "omp" ? "omp" : "claude")])}</div></details><span>Enter ${running ? "queues" : "sends"} · Shift+Enter new line · \`\`\` for code</span></div>
</form>`;
  const waiting = (opts.queued ?? []).map(
    (q) =>
      html`<li class="turn-row user queued"><div class="bubble">${markdown(trunc(q.text, 8000), { headingOffset: 3 })}</div><div class="who">${running ? "Queued: goes when this turn ends" : denied ? "Queued: goes with your answer" : "Queued: goes with your next message"} · <form method="post" action="/agents/s/${sessionId}/queue/${q.id}/remove" class="inline"><button type="submit" class="link">Remove</button></form></div></li>`,
  );
  const body = html`${PageHeader({
    title,
    crumbs: [{ href: "/agents", label: "Agents" }],
    sub: html`${harnessTag(s?.harness ?? run?.harness, s?.model ?? run?.model)} ${s?.repo ?? run?.repo ?? ""}${s?.branch ? html` · ${s.branch}` : ""}${run?.sandbox ? html` · <span class="t3">sandbox</span>` : ""} · ${status}${s?.cost ? html` · <span class="t3">$${s.cost.toFixed(2)} so far</span>` : ""}`,
    actions: html`${opts.diff ? html`<a class="btn ghost" href="${opts.diff}" title="What's changed in its checkout, committed or not">Diff</a>` : ""}${opts.discardable && !run?.sandbox ? html`<form method="post" action="/agents/s/${sessionId}/discard"><button type="submit" class="ghost" title="Off Dovre's lists; the transcript stays, and replying brings it back">Clear away</button></form>` : ""}<a class="btn ghost" href="/agents/new">New session</a>`,
  })}
${opts.flash ? Notice({ tone: "bad", children: opts.flash }) : ""}
${macNotice(opts.mac)}
${opts.copyOf ? Notice({ children: html`A copy of <a href="/agents/s/${opts.copyOf}">a session open in a terminal</a>. They don't see each other: what's said here stays here.` }) : ""}
${opts.copies?.length ? Notice({ children: html`Copies made from here: ${opts.copies.map((c, i) => html`${i ? ", " : ""}${c.sid ? html`<a href="/agents/s/${c.sid}">${c.status === "running" ? "working" : "copy"}</a>` : html`<a href="/agents/r/${c.run}">starting</a>`} · ${Ago(c.startedAt)}`)}. The terminal doesn't see them.` }) : ""}
${s?.summary ? html`<p class="ai"><span class="spark">Recap</span>${s.summary}</p>` : ""}
<div data-live id="chat">
${Panel({
  flush: true,
  children: turns.length || run ? html`<ol class="chat" data-follow>${turns.map((t, i) => turnView(t, { sid: sessionId, answerable: i === turns.length - 1 && !running, mode: run?.mode, model: run?.model, inTerminal: !!inTerminal }, turns[i - 1]))}${run ? liveRun(run, sessionId, { askShown: turns.some((t) => t.role === "ask"), turnCost: opts.turnCost, written }) : ""}${waiting}</ol>` : Empty({ title: "Nothing said yet" }),
})}
</div>
<div data-live id="reply">${reply}</div>`;
  // This session's own ask is on the page already; the bar keeps the others.
  return { title: `${title} · Agents`, current: "/agents", body, head: html`<meta name="u-topics" content="snapshot run:${sessionId}${run && run.sessionId !== sessionId ? ` run:${run.id}` : ""}">` };
}

/** The sandbox option: a fresh clone in a container, where Claude Code runs without asking. */
function sandboxField(st: { ok: boolean; why?: string }, ticked: boolean) {
  return html`<div class="field"><label class="check"><input type="checkbox" name="sandbox" value="on"${ticked && st.ok ? html` checked` : ""}${st.ok ? "" : html` disabled`}> Run in a sandbox</label><span class="hint">${
    st.ok
      ? "Claude Code, in a fresh clone of the checkout inside a container: it runs anything without asking, and reaches nothing else on this machine. One prompt; when it ends, its commits come home as a branch you can open a draft PR from."
      : st.why
  }</span></div>`;
}

export function newAgentPage(opts: { repos: string[]; repo?: string; prompt?: string; error?: string; harnesses?: HarnessId[]; workDir?: string; /** What packs put under "Runs in" for a checkout (the "agents.new" slot: a catalog pack's components). */ fields?: (repo: string) => Child[]; /** Hosted: the machines' agents, online or not. */ mac?: MacStatus; /** Hosted, with several online: the machines to pick from (H7). */ machines?: { id: string; name: string }[]; machine?: string; /** Sandbox runs (src/agents/sandbox.ts): offered when set, ticked off with the reason when they can't start. */ sandbox?: { ok: boolean; why?: string }; sandboxed?: boolean }): PageOpts {
  const harnesses = opts.harnesses ?? (["claude"] as HarnessId[]);
  // Hosted with the Mac offline: no form, nothing would take it.
  if (opts.mac?.online === false)
    return {
      title: "New agent · Dovre",
      current: "/agents",
      body: html`${PageHeader({ title: "New agent session", crumbs: [{ href: "/agents", label: "Agents" }] })}${macNotice(opts.mac)}`,
    };
  if (!harnesses.length)
    return {
      title: "New agent · Dovre",
      current: "/agents",
      body: html`${PageHeader({ title: "New agent session", crumbs: [{ href: "/agents", label: "Agents" }] })}${Notice({
        tone: "warn",
        children: html`No agent CLI found on this machine. Install <strong>Claude Code</strong> (<code>claude</code>) or <strong>omp</strong>, or point <code>CLAUDE_BIN</code> / <code>OMP_BIN</code> in <code>.dev.vars</code> at one, then restart Dovre. Settings → Setup shows what was found.`,
      })}`,
    };
  const repo = opts.repo && opts.repos.includes(opts.repo) ? opts.repo : WORK;
  const componentChips = repo !== WORK && opts.fields ? opts.fields(repo) : "";
  const body = html`${PageHeader({ title: "New agent session", crumbs: [{ href: "/agents", label: "Agents" }], sub: html`Starts ${harnesses.map((h) => HARNESS_LABEL[h]).join(" or ")} headless, in a repo or in Dovre's own folder. You talk to it here; it asks before it acts, as you choose below.` })}
${opts.error ? Notice({ tone: "bad", children: opts.error }) : ""}
${Panel({
  children: html`<form method="post" action="/agents/new">
${opts.machines && opts.machines.length > 1 ? html`<label class="field"><span class="label">On</span><select name="machine" required>${opts.machines.map((m) => html`<option value="${m.id}"${m.id === opts.machine ? html` selected` : ""}>${m.name}</option>`)}</select><span class="hint">The machine it runs on: the checkout must be there.</span></label>` : ""}
<label class="field"><span class="label">Runs in</span><select name="repo" required><option value="${WORK}"${repo === WORK ? html` selected` : ""}>${WORK_LABEL}</option><optgroup label="Checkouts">${opts.repos.map((r) => html`<option value="${r}"${r === repo ? html` selected` : ""}>${r}</option>`)}</optgroup></select><span class="hint">Dovre's own folder${opts.workDir ? html` (<code>${opts.workDir}</code>)` : ""} is for work that isn't in one repo, and keeps it out of your checkouts. Or a git checkout in your code folder, worktrees included.</span></label>
${componentChips}
<label class="field"><span class="label">What should it do?</span><textarea name="prompt" rows="8" required placeholder="Skills work as usual: /some-skill …, or say what to do">${opts.prompt ?? ""}</textarea></label>
${opts.sandbox ? sandboxField(opts.sandbox, !!opts.sandboxed) : ""}
<div class="fields"><label class="field"><span class="label">Agent</span><select name="harness">${harnesses.map((h) => html`<option value="${h}">${HARNESS_LABEL[h]}</option>`)}</select></label>${modeSelect()}${modelSelect("", harnesses)}<div class="field"><button type="submit" class="primary" data-busy="Starting">Start</button></div></div>
${harnesses.includes("omp") ? html`<p class="hint t3">omp's own setting may approve everything; sessions started here always ask first, in the mode you pick.</p>` : ""}
</form>`,
})}`;
  return { title: "New agent · Dovre", current: "/agents", body };
}
