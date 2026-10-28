import assert from "node:assert/strict";
import { test } from "node:test";
import { SCRIPT } from "../src/ui/app.js.ts";

test("a page with u-every is looked at again on its own, while shown, never under 5 s", () => {
  assert.match(SCRIPT, /meta\[name="u-every"\]/);
  assert.match(SCRIPT, /n >= 5\) \|\| document\.hidden/);
});
