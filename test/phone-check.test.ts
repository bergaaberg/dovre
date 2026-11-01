/** `pnpm phone`: the sidebar's pages, the report, and (where Chromium is installed) a real measurement. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkPages, chromium, pagesOf, report } from "../src/phone-check.ts";
import { STYLE } from "../src/ui/style.ts";

test("pagesOf: the sidebar's own pages, without queries, assets or other sites", () => {
  const page = `<a href="/outside">x</a><nav class="side" id="side"><a href="/">T</a><a href="/autobrawl">A</a><a href="/health?fresh=1">H</a><a href="//evil.example/x">E</a><a href="https://x.example/">X</a><a href="/assets/style.css">S</a><a href="/autobrawl">again</a></nav>`;
  assert.deepEqual(pagesOf(page), ["/", "/autobrawl"]);
  assert.deepEqual(pagesOf("<p>signed out</p>"), []);
});

test("report: fits, too wide, and cut off in a box are told apart; a failing page is only named", () => {
  const base = { status: 200, viewport: 390, page: 390, wide: [], clipped: [] };
  const r = report([
    { ...base, path: "/" },
    { ...base, path: "/wide", page: 600, wide: [{ what: "div.big", right: 600, width: 600 }] },
    { ...base, path: "/cut", clipped: [{ what: "table.t", pack: "autobrawl", right: 500, width: 480 }] },
    { ...base, path: "/gone", status: 404 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.text, ["/: fits", "/wide: 600px wide on a 390px screen", "  sticks out: div.big (600px, to 600px)", "/cut: fits, but cut off in a pack's box", "  cut off: table.t [autobrawl] (480px, to 500px)", "/gone: 404"].join("\n"));
  assert.equal(report([{ ...base, path: "/" }]).ok, true);
});

const bin = chromium();
test("checkPages: a real phone-width measurement in Chromium", { skip: bin ? false : "no Chromium here" }, async () => {
  const shell = (body: string) => `<!doctype html><meta name="viewport" content="width=device-width"><style>${STYLE}</style><body>${body}</body>`;
  const pages: Record<string, string> = {
    "/ok": shell(`<p>fits</p><div class="pack-box" data-pack="p"><div style="width:2000px">clipped</div></div>`),
    "/wide": shell(`<main><div class="big" style="width:700px">too wide</div></main><div style="overflow-x:auto"><div style="width:900px">scrolls</div></div>`),
    "/fixed": shell(`<div class="pack-box" data-pack="p" style="margin-left:100px"><div class="veil" style="position:fixed;left:0;top:0;width:390px">overlay</div></div>`),
  };
  let cookie = "";
  const srv = createServer((req, res) => {
    cookie = req.headers.cookie ?? cookie;
    const body = pages[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "no");
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const fits = await checkPages({ base, paths: ["/ok", "/wide", "/fixed", "/nope"], cookies: ["u_tk=abc"], bin: bin!, settleMs: 50 });
    const [ok, wide, fixed, nope] = fits;
    assert.equal(cookie, "u_tk=abc");
    assert.equal(ok!.page, ok!.viewport);
    assert.equal(ok!.clipped[0]?.pack, "p");
    assert.ok(wide!.page > wide!.viewport);
    assert.deepEqual(wide!.wide.map((s) => s.what), ["main > div.big"]);
    // The pack box frames a fixed overlay: it starts at the box (100px in), not the screen's edge.
    assert.equal(fixed!.page, fixed!.viewport);
    assert.deepEqual(fixed!.clipped.map((s) => [s.what, s.right]), [["div.pack-box > div.veil", 490]]);
    assert.equal(nope!.status, 404);
  } finally {
    srv.close();
  }
});
