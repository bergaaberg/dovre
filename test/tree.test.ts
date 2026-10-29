/** A diff's files as a folder tree (dovre#299 phase 2). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileTree } from "../src/viewer/tree.ts";

test("folders before files, each by name; a lone folder chain is one row; each file keeps its place", () => {
  const t = fileTree(["src/viewer/tree.ts", "README.md", "src/viewer/diff.ts", "src/app.ts", "a/b/c/d.ts"]);
  assert.deepEqual(t, [
    { dir: true, name: "a/b/c", kids: [{ dir: false, name: "d.ts", i: 4 }] },
    { dir: true, name: "src", kids: [{ dir: true, name: "viewer", kids: [{ dir: false, name: "diff.ts", i: 2 }, { dir: false, name: "tree.ts", i: 0 }] }, { dir: false, name: "app.ts", i: 3 }] },
    { dir: false, name: "README.md", i: 1 },
  ]);
  assert.deepEqual(fileTree([]), []);
});
