/**
 * The first-run page (WP-A23): what was found on this machine, where the work is, and which panes
 * to turn on, in place of a hand-written .dev.vars. Today sends here until it's answered or skipped;
 * everything on it can be changed later on Settings.
 */
import { html } from "hono/html";
import { type Choice, GENERAL } from "../config.ts";
import { type Frame, shell } from "../html.ts";
import { MARK, RIDGE_ART } from "../ui/splash.ts";
import { STYLE_PATH } from "../ui/style.ts";
import { Notice, PageHeader, Panel } from "../ui/kit.ts";
import { fieldInput, type PanesView, paneSets, restartingNote, type SetupLine, setupPanel } from "./settings.ts";

/** The first screen: the ridge at night, the name, and Get started (the setup below). A page of its own, without the menu. */
export function splashPage(o: { version: string }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dovre</title>
<link rel="stylesheet" href="${STYLE_PATH}">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0e1922">
</head>
<body class="splash-page">
<main class="splash">
${RIDGE_ART}
<div class="splash-text">
<div class="splash-brand splash-fade">${MARK}<h1>Dovre</h1></div>
<p class="splash-lede splash-fade">The view from the top: your PRs, deploys, agents and chats on one page.</p>
<div class="splash-go splash-fade-2"><a class="btn primary" href="/welcome?go=1">Get started</a><span class="splash-note">About a minute. Settings changes any of it later.</span></div>
</div>
<p class="splash-foot">Version ${o.version} · runs on this machine only</p>
</main>
</body>
</html>`;
}

export function welcomePage(frame: Frame, o: { setup: SetupLine[]; panes: PanesView; teams?: Choice[]; canRestart: boolean; bad?: string[]; started?: number }) {
  if (o.started)
    return shell({ title: "Starting · Dovre", frame, current: "/welcome", body: html`${PageHeader({ title: "Starting Dovre" })}${restartingNote(o.started, "/", "Saved. Dovre is starting again with your choices; Today opens when it's up.")}` });
  const body = html`${PageHeader({ title: "Set up Dovre", sub: "What it found here, and what to turn on. Settings changes any of it later." })}
${o.bad?.length ? Notice({ tone: "bad", children: html`Not saved: ${o.bad.join(", ")} ${o.bad.length > 1 ? "aren't values they take" : "isn't a value it takes"}.` }) : ""}
${setupPanel(o.setup, "Found here")}
<form method="post" action="/welcome" id="welcome">
${Panel({ title: "Your work", children: html`<div class="fields">${GENERAL.map((g) => fieldInput(g, o.panes.values[g.key], o.panes.fixed.has(g.key), g.key === "TEAM" ? o.teams : undefined))}</div>` })}
${Panel({ title: "Panes", children: html`<p class="notes">Turn off what you don't use: it's gone from the menu and does nothing in the background.</p>${paneSets(o.panes)}` })}
<div class="buttons"><button type="submit" class="primary" data-busy="Starting">Start</button></div>
</form>
<form method="post" action="/welcome/skip" class="welcome-skip"><button type="submit" class="ghost">Skip for now</button></form>`;
  return shell({ title: "Set up · Dovre", frame, current: "/welcome", body });
}
