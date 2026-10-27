import assert from "node:assert/strict";
import { test } from "node:test";
import { frameOrigin } from "../../../../app.ts";
import { autoTitle, booksOf, originOf, parseStories, storyId, storyName, touched, urlOf } from "../model.ts";

test("STORYBOOK: repo and two https templates per entry; anything else is left out", () => {
  const books = booksOf("acme/web https://a.io/web/pr-{pr}/ https://a.io/web/{base}/;\n bad https://a.io/ https://a.io/ ; acme/x http://a.io/ https://a.io/ ; acme/y https://{pr}.a.io/ https://a.io/ ; acme/web https://b.io/ https://b.io/");
  assert.deepEqual(books, [{ repo: "acme/web", head: "https://a.io/web/pr-{pr}/", base: "https://a.io/web/{base}/" }]);
  assert.equal(originOf("https://{pr}.a.io/"), undefined);
  assert.equal(originOf("https://a.io:8443/x"), "https://a.io:8443");
});

test("templates fill in: branches keep their slashes, the rest is encoded, a slash at the end", () => {
  const v = { pr: 7, branch: "feat/a b", base: "main", sha: "abc" };
  assert.equal(urlOf("https://a.io/web/{branch}", v), "https://a.io/web/feat/a%20b/");
  assert.equal(urlOf("https://a.io/pr-{pr}/{sha}/", v), "https://a.io/pr-7/abc/");
});

test("story ids as Storybook makes them", () => {
  assert.equal(storyName("PrimaryLarge"), "Primary Large");
  assert.equal(storyName("withIcon"), "With Icon");
  assert.equal(storyName("Size2XL"), "Size 2 XL");
  assert.equal(storyId("Components/Button", "PrimaryLarge"), "components-button--primary-large");
  assert.equal(autoTitle("src/components/Button/Button.stories.tsx"), "components/Button");
  assert.equal(autoTitle("src/ui/Card.stories.ts"), "ui/Card");
});

test("a stories file: the meta's title (not an arg's), its exports", () => {
  const a = parseStories("src/x/Button.stories.tsx", `// title: "nope"\nconst meta: Meta = { title: 'Forms/Button', component: B };\nexport default meta;\nexport const Primary: Story = { args: { title: "Click" } };\nexport const Big = {};\nexport { Small as Tiny };`);
  assert.deepEqual(a, { title: "Forms/Button", exports: ["Primary", "Big", "Tiny"] });
  const b = parseStories("src/x/Card/Card.stories.tsx", `export default { component: Card };\nexport const Basic = { args: { title: "x" } };`);
  assert.equal(b.title, "x/Card");
});

test("touched: changed stories, and the folders of changed source files (not tests)", () => {
  const t = touched([
    { path: "src/a/A.stories.tsx", status: "modified" },
    { path: "src/b/B.tsx", status: "modified" },
    { path: "src/b/B.test.tsx", status: "modified" },
    { path: "src/c/C.tsx", status: "removed" },
    { path: "README.md", status: "modified" },
  ]);
  assert.deepEqual(t.stories.map((s) => s.path), ["src/a/A.stories.tsx"]);
  assert.deepEqual(t.dirs, ["src/b"]);
});

test("frames: https origins only", () => {
  assert.equal(frameOrigin("https://a.io/x/y"), "https://a.io");
  for (const bad of ["http://a.io", "javascript:alert(1)", "https://u:p@a.io", "*", 3, "https://*.a.io"]) assert.equal(frameOrigin(bad), undefined, String(bad));
});
