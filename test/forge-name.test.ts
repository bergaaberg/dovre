/** Pages name the forge by its host: GitHub for github.com, the Enterprise host otherwise. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeName } from "../src/pages/parts.ts";

test("forgeName: GitHub for github.com, else the host", () => {
  assert.equal(forgeName("github.com"), "GitHub");
  assert.equal(forgeName("GitHub.com"), "GitHub");
  assert.equal(forgeName(undefined), "GitHub");
  assert.equal(forgeName("acme.ghe.com"), "acme.ghe.com");
});

import { setupPage } from "../src/setup.ts";

test("setup page names github.com as GitHub and an Enterprise host by itself", () => {
  for (const kind of ["login", "unreachable"] as const) {
    const gh = String(setupPage({ kind, host: "github.com" }, {}));
    assert.doesNotMatch(gh, /GHE\b(?!_)/);
    assert.match(gh, kind === "login" ? /Sign in to GitHub first/ : /Can't reach GitHub/);
    const ent = String(setupPage({ kind, host: "acme.ghe.com" }, {}));
    assert.doesNotMatch(ent, /GHE\b(?!_)/);
    assert.match(ent, kind === "login" ? /Sign in to acme\.ghe\.com first/ : /Can't reach acme\.ghe\.com/);
  }
  assert.match(String(setupPage({ kind: "unreachable", host: "acme.ghe.com" }, { ready: true })), /acme\.ghe\.com answers now/);
});

import { setupLines, type SetupFacts } from "../src/pages/settings.ts";

test("Settings' forge row shows the host once", () => {
  const row = (host: string) => setupLines({ ghe: { host, org: "acme", login: "me" } } as SetupFacts)[0]!;
  assert.deepEqual([row("github.com").name, row("github.com").what], ["GitHub", "github.com, org acme, signed in as me"]);
  assert.deepEqual([row("acme.ghe.com").name, row("acme.ghe.com").what], ["acme.ghe.com", "org acme, signed in as me"]);
});
