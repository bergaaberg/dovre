/** Self-host compose (#102): the host's Docker socket (for the docker pack) stays opt-in. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("self-host compose: the host's Docker socket is never mounted by default, and the opt-in line is there", () => {
  const compose = readFileSync(new URL("../deploy/compose.yaml", import.meta.url), "utf8");
  const live = compose.split("\n").filter((l) => !l.trim().startsWith("#"));
  assert.ok(compose.includes("# - /var/run/docker.sock:/var/run/docker.sock"), "the opt-in line is there to uncomment");
  assert.ok(!live.some((l) => l.includes("docker.sock") || l.includes("group_add")), "the socket is never mounted by default");
});
