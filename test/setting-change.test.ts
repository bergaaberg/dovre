/** One setting changed by itself (#185): every row that may be, through its own route; the never list; what's logged. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsOf } from "../src/actions/deploys.ts";
import { DEFAULT_KEYS } from "../src/keys.ts";
import { DEFAULT_POLICY, type Policy } from "../src/notify.ts";
import { changeTo, choicesOf, settingRows } from "../src/pages/settings.ts";
import { settingsOf } from "../src/routes/settings.ts";
import { WRITES } from "../src/writes.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { signedIn, snapshot } from "./helpers.ts";

/** A pack with a tab and a feed: What's happening has a source to turn off. */
const shop: Pack = {
  manifest: { api: PACK_API, id: "shop", name: "Shop", description: "", domain: "personal" },
  nav: () => [{ href: "/shop", title: "Shop", icon: "inbox", tab: true }],
  feed: () => [{ key: "1", at: Date.now(), tone: "ok", what: "sold", title: "a kettle" }],
};

/** A notifier that keeps the policy, as the entries' does. */
const notifier = () => {
  let policy: Policy = { ...DEFAULT_POLICY, quiet: { from: 22, to: 7, weekends: true } };
  return { policy: () => policy, setPolicy: async (p: Policy) => void (policy = p), log: () => [], test() {} };
};

/** The request a card is pressed in: its cookie and origin go with the post to the setting's route. */
const pressed = () => new Request("http://localhost/bino/c/x/act/0/0", { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost" } });

test("every setting that can be changed by itself goes through its own route to each of its values, and back", async () => {
  const notify = notifier();
  const { app } = signedIn(snapshot(), {}, { notify, packs: [shop] });
  const api = settingsOf(app)!;
  const rows = await api.rows();
  for (const id of ["layout.statsRange", "layout.feed.shop", "notify.quiet", "notify.quietWeekends"]) assert.ok(rows.find((r) => r.id === id)?.change, id);
  const changedAtFirst = rows.filter((r) => r.changed).map((r) => r.id);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "every row has an id of its own");
  const able = rows.filter((r) => r.change);
  for (const area of ["look", "layout", "notifications", "writes", "keys"]) assert.ok(able.some((r) => r.area === area), area);
  for (const r of able) {
    const c = r.change!;
    const values = c.kind === "number" ? [String(c.min), String(c.max)] : c.kind === "hours" ? ["", "9-17", "23-6"] : choicesOf(c).map((x) => x.value);
    assert.ok(values.length > 1, r.id);
    for (const v of [...values.filter((x) => x !== c.value), c.value]) {
      const got = await api.change(pressed(), r.id, v, "a test", { twice: true });
      assert.ok(got.ok, `${r.id} to “${v}”: ${got.ok ? "" : got.why}`);
      assert.equal((await api.rows()).find((x) => x.id === r.id)?.change?.value, v, `${r.id} is “${v}” now`);
    }
  }
  assert.deepEqual((await api.rows()).filter((r) => r.changed).map((r) => r.id), changedAtFirst, "everything is as it was again");
  assert.deepEqual(notify.policy().quiet, { from: 22, to: 7, weekends: true }, "the quiet hours went along with each post, untouched");
});

test("the range or a feed's source changed by itself leaves the phone's tabs, Today's cards and Stats' panels as they were", async () => {
  const { app } = signedIn(snapshot(), {}, { packs: [shop] });
  const api = settingsOf(app)!;
  const placed = await api.arrange(pressed(), { tabs: ["/shop"] }, "a test");
  assert.ok(placed.ok);
  const before = await api.arrangement();
  assert.ok((await api.change(pressed(), "layout.feed.shop", "off", "Bino")).ok);
  assert.ok((await api.change(pressed(), "layout.statsRange", "4 weeks", "Bino")).ok);
  assert.deepEqual(await api.arrangement(), before);
  const rows = await api.rows();
  assert.equal(rows.find((r) => r.id === "layout.feed")?.now, "1 left out");
  assert.equal(rows.find((r) => r.id === "layout.statsRange")?.now, "4 weeks");
  assert.equal(rows.find((r) => r.id === "pack.shop")?.now, "On", "the pack itself stays on");
});

test("quiet hours by themselves: the span leaves weekends be, and weekends the span", async () => {
  const notify = notifier();
  const api = settingsOf(signedIn(snapshot(), {}, { notify }).app)!;
  const got = await api.change(pressed(), "notify.quiet", "18:00–08:00", "Bino");
  assert.ok(got.ok && got.text === "Quiet hours: 22:00–07:00 → 18:00–08:00" && got.was === "22-7");
  assert.deepEqual(notify.policy().quiet, { from: 18, to: 8, weekends: true });
  assert.ok((await api.change(pressed(), "notify.quiet", "none", "Bino")).ok);
  assert.deepEqual(notify.policy().quiet, { from: 0, to: 0, weekends: true }, "weekends alone");
  assert.ok((await api.change(pressed(), "notify.quietWeekends", "off", "Bino")).ok);
  assert.equal(notify.policy().quiet, null);
  assert.ok((await api.change(pressed(), "notify.quiet", "22-7", "Bino")).ok);
  assert.deepEqual(notify.policy().quiet, { from: 22, to: 7 });
});

test("with no notifier here, what rings is only shown", async () => {
  const rows = await settingsOf(signedIn(snapshot()).app)!.rows();
  for (const r of rows.filter((x) => x.id.startsWith("notify.") || x.id === "agents.longTurn")) assert.equal(r.change, undefined, r.id);
});

test("the never list: who gets in, what leaves the machine, what agents may do and Restart have no change", async () => {
  const { app } = signedIn(snapshot());
  const api = settingsOf(app)!;
  const rows = await api.rows();
  assert.ok(rows.some((r) => r.id === "packs.assistant.ASSISTANT_VIA"), "a pack's choice of where it sends things is a row");
  for (const r of rows.filter((x) => ["work", "about", "packs"].includes(x.area) || x.id.startsWith("agents.tools."))) assert.equal(r.change, undefined, r.id);
  for (const id of ["layout.feed", "layout.tabs", "about.version"]) {
    const got = await api.change(pressed(), id, "1", "a test");
    assert.ok(!got.ok && got.href, `${id} only points at its page`);
  }
  const none = await api.change(pressed(), "look.nope", "1", "a test");
  assert.ok(!none.ok && !none.href);
  const bad = await api.change(pressed(), "look.theme", "<script>", "a test");
  assert.ok(!bad.ok && bad.why.includes("value"));
});

test("a value by its label, a switch by on and off, a number only whole and within its bounds", () => {
  const rows = settingRows({ layout: {}, policy: DEFAULT_POLICY, notifier: true, rings: [], writes: { chosen: new Map(), kinds: WRITES }, keys: DEFAULT_KEYS, packs: [] });
  const of = (id: string) => rows.find((r) => r.id === id)!.change!;
  assert.equal(changeTo(of("look.theme"), ""), "", "the default's value is empty");
  assert.equal(changeTo(of("look.theme"), "as the system"), "");
  assert.equal(changeTo(of("look.theme"), "Ember"), "ember", "the label without what it's like");
  assert.equal(changeTo(of("look.theme"), "nope"), null);
  assert.equal(changeTo(of("keys.hints"), "off"), "0");
  assert.equal(changeTo(of("keys.hints"), "On"), "1");
  assert.equal(changeTo(of("keys.hints"), "yes"), null);
  assert.equal(changeTo(of("notify.bundle"), " 60 "), "60");
  for (const v of ["601", "-1", "1.5", "", "ten"]) assert.equal(changeTo(of("notify.bundle"), v), null, v);
  // Quiet hours: from one hour to another, or none.
  assert.equal(changeTo(of("notify.quiet"), "22-7"), "22-7");
  assert.equal(changeTo(of("notify.quiet"), "22:00–07:00"), "22-7");
  assert.equal(changeTo(of("notify.quiet"), "9 to 17"), "9-17");
  assert.equal(changeTo(of("notify.quiet"), "none"), "");
  assert.equal(changeTo(of("notify.quiet"), ""), "");
  for (const v of ["22-", "-7", "7-7", "24-6", "22-7-9", "<b>"]) assert.equal(changeTo(of("notify.quiet"), v), null, v);
});

test("a write to one click is asked again; Writes and a pack's switch are logged whoever makes them, Look only when proposed", async () => {
  const { app, post, db } = signedIn(snapshot());
  const api = settingsOf(app)!;
  const log = async () => (await actionsOf(db.DB, "settings.change")).map((a) => `${a.target}: ${a.detail}`).reverse();
  const kind = WRITES[0]!.kind;

  assert.ok((await api.change(pressed(), `writes.${kind}`, "twice", "Bino")).ok, "stricter: one press");
  const loose = await api.change(pressed(), `writes.${kind}`, "once", "Bino");
  assert.ok(!loose.ok && loose.ask, "looser: asked again");
  assert.equal((await api.rows()).find((r) => r.id === `writes.${kind}`)?.change?.value, "twice", "nothing changed yet");
  assert.ok((await api.change(pressed(), `writes.${kind}`, "once", "Bino", { twice: true })).ok);

  const theme = await api.change(pressed(), "look.theme", "Ember", "Bino");
  assert.ok(theme.ok && theme.text === "Theme: As the system → Ember (warm dark)" && theme.was === "" && theme.now === "ember");
  await post("/settings/layout", { part: "look", theme: "" });
  await post("/settings/writes", { twice: kind });
  await post("/packs/todo/switch", { on: "0" });
  assert.deepEqual(await log(), [
    `writes.${kind}: One click → Asks twice · proposed by Bino`,
    `writes.${kind}: Asks twice → One click · proposed by Bino`,
    "look.theme: As the system → Ember (warm dark) · proposed by Bino",
    `writes.${kind}: One click → Asks twice`,
    "pack.todo: On → Off",
  ]);
});
