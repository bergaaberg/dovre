/** Rings on a hosted cockpit (#551): the hub keeps what each stream rang, and the Worker says whom each need is for. */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DovreHub, type HubSocket, type HubState, type RingCall, SEEN_MS } from "../src/hosted/hub.ts";
import { hostedRings, teamOf } from "../src/hosted/rings.ts";
import type { Need } from "../src/home/needs.ts";
import type { Note } from "../src/notify.ts";
import { DEFAULT_POLICY } from "../src/notify.ts";
import { viewingAs } from "../src/viewer.ts";
import { pr, snapshot } from "./helpers.ts";

class FakeSocket implements HubSocket {
  out: string[] = [];
  closed?: { code?: number; reason?: string };
  private att: unknown;
  send(m: string) {
    if (this.closed) throw new Error("closed");
    this.out.push(m);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return structuredClone(this.att);
  }
}

function fakeHub() {
  const db = new DatabaseSync(":memory:");
  const sockets: { ws: FakeSocket; tags: string[] }[] = [];
  const state: HubState = {
    storage: {
      sql: {
        exec(q, ...b) {
          const st = db.prepare(q);
          const rows = /^\s*select/i.test(q) ? (st.all(...(b as never[])) as Record<string, unknown>[]) : (st.run(...(b as never[])), []);
          return { toArray: () => rows };
        },
      },
      setAlarm: () => {},
    },
    acceptWebSocket: (ws, tags = []) => void sockets.push({ ws: ws as FakeSocket, tags }),
    getWebSockets: (tag) => sockets.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws),
  };
  const hub = new DovreHub(state, { DB: undefined as never });
  const page = (who?: string, own?: boolean) => {
    const ws = new FakeSocket();
    assert.equal(hub.acceptPage(ws, { who, own }), true);
    return ws;
  };
  return { hub, page };
}

const notesOf = (ws: FakeSocket) => ws.out.flatMap((l) => ((JSON.parse(l) as { notes?: Note[] }).notes ?? []).map((n) => n.title));
const note = (key: string, title = key): Note & { key: string } => ({ key, title, tag: key, kind: "review" });
const post = (hub: DovreHub, path: string, body: unknown) => hub.fetch(new Request(`https://hub.internal${path}`, { method: "POST", body: JSON.stringify(body) }));

test("hub rings: a stream's first look only learns; after it, what's new rings once to the pages it's for (#551)", async () => {
  const { hub, page } = fakeHub();
  let t = 1_000_000;
  hub.now = () => t;
  const ola = page("ola@x.dev", true);
  const kari = page("kari@x.dev");
  const ring = async (calls: RingCall[]) => (await (await post(hub, "/ring", { calls })).json()) as { rang: number };

  assert.equal((await ring([{ stream: "core", shared: true, keys: ["a"], notes: [note("a")] } as RingCall])).rang, 0, "the first look learns");
  assert.equal((await ring([{ stream: "core", shared: true, keys: ["a", "b"], notes: [note("a"), note("b")] } as RingCall])).rang, 1);
  assert.deepEqual([notesOf(ola), notesOf(kari)], [[], ["b"]], "the instance's needs: not a page drawn from a person's own");
  // A need that left a moment ago (an isolate whose packs read late) doesn't ring again when it's back.
  await ring([{ stream: "core", shared: true, keys: [], notes: [] } as RingCall]);
  t += 60_000;
  await ring([{ stream: "core", shared: true, keys: ["b"], notes: [note("b")] } as RingCall]);
  assert.deepEqual(notesOf(kari), ["b"]);
  // Gone over a day, it's news again.
  await ring([{ stream: "core", shared: true, keys: [], notes: [] } as RingCall]);
  t += SEEN_MS + 1;
  await ring([{ stream: "core", shared: true, keys: ["b"], notes: [note("b")] } as RingCall]);
  assert.deepEqual(notesOf(kari), ["b", "b"]);

  // One person's stream: their pages alone, whichever snapshot they drew.
  await ring([{ stream: "packs:ola@x.dev", for: "ola@x.dev", keys: [], notes: [] } as RingCall]);
  await ring([{ stream: "packs:ola@x.dev", for: "ola@x.dev", keys: ["t"], notes: [note("t", "T-4 is yours")] } as RingCall]);
  assert.deepEqual([notesOf(ola), notesOf(kari)], [["T-4 is yours"], ["b", "b"]]);

  // Named for nobody, it's dropped, never widened.
  await ring([{ stream: "packs:x", for: "  ", keys: [], notes: [] } as RingCall, { stream: "packs:x", for: "  ", keys: ["u"], notes: [note("u")] } as RingCall]);
  assert.deepEqual([notesOf(ola).length, notesOf(kari).length], [1, 2]);
});

test("hub rings: quiet hours hold what's new (logged, not sent), bundling makes one note, and a note's link is a path here or none (#551)", async () => {
  const { hub, page } = fakeHub();
  const kari = page("kari@x.dev");
  const ring = (c: Partial<RingCall>) => post(hub, "/ring", { calls: [{ stream: "packs", keys: [], notes: [], ...c }] });
  await ring({});
  await ring({ keys: ["q"], notes: [note("q", "quiet one")], held: true });
  assert.deepEqual(notesOf(kari), []);
  await ring({ keys: ["q", "x", "y"], notes: [note("x"), note("y")], bundle: true });
  assert.deepEqual(notesOf(kari), ["2 more things need you"]);
  await ring({ keys: ["q", "x", "y", "z"], notes: [{ ...note("z"), url: "https://evil.example/" }] });
  assert.equal((JSON.parse(kari.out.at(-1)!) as { notes: Note[] }).notes[0]!.url, undefined);

  const rung = (await (await hub.fetch(new Request("https://hub.internal/rung"))).json()) as { title: string; held?: string }[];
  assert.deepEqual(rung.map((r) => [r.title, r.held ?? ""]), [["z", ""], ["2 more things need you", ""], ["quiet one", "quiet"]]);

  // A pack's ring or the test: at once, to whom it names.
  assert.equal((await post(hub, "/notes", { notes: [{ title: "Dovre notifications work", tag: "test" }], for: "kari@x.dev" })).status, 200);
  assert.equal(notesOf(kari).at(-1), "Dovre notifications work");
  assert.equal((await post(hub, "/notes", { notes: [{ title: "x", tag: "t" }], for: "" })).status, 400);
  assert.equal((await post(hub, "/notes", { notes: [{ tag: "t" }] })).status, 400, "a note without a title isn't one");
});

test("hosted rings: each need goes to its stream: the instance's to its pages, a pack's to everyone, a named one only to that person of the team (#551)", async () => {
  const sent: RingCall[][] = [];
  const pending: Promise<unknown>[] = [];
  const hub = {
    ring: (c: Promise<RingCall[]>) => void pending.push(c.then((x) => sent.push(x))),
    notes: () => {},
    rung: async () => [],
  };
  let saved: string | undefined;
  const db = { prepare: () => ({ first: async () => (saved ? { value: saved } : null), bind: (v: string) => ({ run: async () => void (saved = v) }) }) };
  const r = hostedRings({ db: db as never, hub, team: teamOf(" Ola@x.dev, kari@x.dev,,nope"), tz: () => "Europe/Oslo", now: () => Date.UTC(2026, 10, 16, 10) }); // a Monday, 11:00 in Oslo
  const packNeed = (key: string, person?: string, ring = "tasks-assigned"): Need => ({ kind: "pack", key, ring, rank: 2, at: 0, title: key, href: "/tasks", tone: "neutral", ...(person ? { person } : {}) });
  const all = [packNeed("tasks:open"), packNeed("tasks:t4", "ola@x.dev"), packNeed("tasks:t5", "per@x.dev")];
  // Read as someone, a pack shows the unnamed and theirs (src/packs/registry.ts needsSeen).
  const { currentViewer } = await import("../src/viewer.ts");
  r.mount({ needs: () => all.filter((n) => !n.person || n.person === currentViewer()), startsOff: new Set(["tasks-assigned"]), pageOn: () => true });

  const s = snapshot({ prs: { ok: true, value: { mine: [], review: [pr({ number: 5, author: "per-hansen" })] } } });
  viewingAs("ola@x.dev", () => r.gathered(s));
  await Promise.all(pending);
  const calls = sent[0]!;
  assert.deepEqual(calls.map((c) => [c.stream, c.for ?? (c.shared ? "shared" : "everyone"), c.keys.join(",")]), [
    ["core", "shared", calls[0]!.keys.join(",")],
    ["packs", "everyone", "tasks:open"],
    ["packs:ola@x.dev", "ola@x.dev", "tasks:t4"],
    ["packs:kari@x.dev", "kari@x.dev", ""],
  ], "read for nobody however the gather was started; per@ isn't on the team, so nobody hears of T-5");
  assert.equal(calls[0]!.keys.length, 1);
  assert.equal(calls[0]!.notes.length, 1, "a review asked rings by default");
  assert.equal(calls[1]!.notes.length, 0, "a ring that starts off doesn't, until it's switched on");

  await r.notify.setPolicy({ ...DEFAULT_POLICY, kinds: { ...DEFAULT_POLICY.kinds, "tasks-assigned": true, review: false }, quiet: { from: 9, to: 17 } });
  r.gathered(s, "ola@x.dev");
  await Promise.all(pending);
  const own = sent[1]!;
  assert.deepEqual(own.map((c) => [c.stream, c.for]), [["own:ola@x.dev", "ola@x.dev"]], "a person's own gather: its core needs, to them");
  assert.equal(own[0]!.notes.length, 0, "the policy saved is read again: reviews off");
  r.gathered(s);
  await Promise.all(pending);
  assert.equal(sent[2]![2]!.notes.length, 1, "switched on, a handover rings");
  assert.equal(sent[2]![2]!.held, true, "in quiet hours it's held");
});
