/** Review findings (#555): reading one, and telling when two report the same problem. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type FindingStatus, foldFound, type Found, gates, raisedAgain, sameProblem, severityCounts, titlesAlike } from "../src/reviews/finding.ts";

const f = (o: Partial<Found> = {}): Found => ({ severity: "high", tags: ["correctness"], path: "src/a.ts", line: 10, side: "RIGHT", title: "Token is not checked before use", body: "It reads the token unchecked.", fix: "Check it.", ...o });

test("gates: open critical and high hold a PR back, and whatever the owner said to fix; never what they said to ignore, nor what's fixed or folded away", () => {
  const held = (severity: Found["severity"], status: FindingStatus) => gates({ severity, status });
  assert.deepEqual([held("critical", "open"), held("high", "open"), held("medium", "open"), held("low", "open")], [true, true, false, false]);
  assert.deepEqual([held("low", "force-fix"), held("critical", "force-ignore"), held("critical", "fixed"), held("high", "merged")], [true, false, false, false]);
  assert.equal(severityCounts([f(), f({ severity: "low" }), f()]), "2 high, 1 low");
});

test("titlesAlike: the words two titles share over the words either has, small words aside", () => {
  assert.equal(titlesAlike("Token is not checked", "The token is not checked"), 1);
  assert.equal(titlesAlike("Token unchecked", "Password logged in the clear"), 0);
  assert.equal(titlesAlike("", "Token"), 0);
  assert.ok(titlesAlike("Token unchecked before use", "Token still unchecked") >= 0.25);
});

test("sameProblem: the same file and nearby lines with a similar title or a shared tag; across commits a clearly similar title is enough", () => {
  assert.equal(sameProblem(f(), f({ line: 13, title: "Something else entirely" })), true, "a shared tag, three lines off");
  assert.equal(sameProblem(f(), f({ line: 12, tags: ["security"] })), true, "a similar title");
  assert.equal(sameProblem(f(), f({ line: 12, tags: ["security"], title: "Slow loop over users" })), false);
  assert.equal(sameProblem(f(), f({ line: 14 })), false, "four lines off");
  assert.equal(sameProblem(f({ startLine: 4 }), f({ line: 3 })), true, "a range reaches it");
  assert.equal(sameProblem(f(), f({ path: "src/b.ts" })), false);
  assert.equal(sameProblem(f(), f({ side: "LEFT" })), false, "removed lines count apart");
  assert.equal(sameProblem(f(), f({ line: 80 }), { moved: true }), true, "the code moved, the title didn't");
  assert.equal(sameProblem(f(), f({ line: 80, title: "Token handling could be clearer" }), { moved: true }), false);
  assert.equal(sameProblem(f(), f({ title: "Something else entirely" }), { titled: true }), false, "a tag alone isn't enough");
});

test("foldFound: reviewers reporting the same problem become one finding, in the most severe one's words with every tag and the widest lines; one reviewer's own stay apart", () => {
  const quality = [f({ severity: "medium", line: 11, startLine: 9, title: "Token not checked" }), f({ severity: "low", line: 12, title: "Vague name" })];
  const security = [f({ severity: "critical", tags: ["security"], title: "Token is not checked before use", line: 10 }), f({ path: "src/b.ts", severity: "low", tags: ["security"] })];
  const out = foldFound([quality, security]);
  assert.deepEqual(
    out.map((x) => [x.severity, x.path, x.startLine, x.line, x.tags.join(), x.title]),
    [
      ["critical", "src/a.ts", 9, 11, "security,correctness", "Token is not checked before use"],
      ["low", "src/a.ts", undefined, 12, "correctness", "Vague name"],
      ["low", "src/b.ts", undefined, 10, "security", "Token is not checked before use"],
    ],
  );
  assert.match(out[0]!.body, /^It reads the token unchecked\.\n\nAlso reported as: "Token not checked"\.$/);
  assert.deepEqual(foldFound([[f(), f()]]), [f(), f()], "one reviewer listing two meant two");
  assert.deepEqual(foldFound([]), []);
});

test("raisedAgain: each earlier finding still standing takes one raised again, one the owner decided on first; a fixed one takes none, and an ignored one needs the title", () => {
  const earlier = [
    { ...f(), id: "open", status: "open" as const },
    { ...f({ line: 11 }), id: "ignored", status: "force-ignore" as const },
    { ...f({ line: 40, title: "Slow loop over users", tags: ["performance"] }), id: "fixed", status: "fixed" as const },
  ];
  const again = raisedAgain([f({ line: 12 }), f({ line: 11 }), f(), f({ line: 40, title: "Slow loop over users", tags: ["performance"] })], earlier);
  assert.deepEqual([...again].map(([i, e]) => [i, e.id]), [[0, "ignored"], [1, "open"]]);
  assert.equal(raisedAgain([f({ line: 11, title: "Something else entirely" })], [earlier[1]!]).size, 0);
});
