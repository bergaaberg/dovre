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
