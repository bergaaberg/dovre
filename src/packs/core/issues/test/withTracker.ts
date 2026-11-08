// Test apps get New work as an instance does: through the tracker pack, which mounts /issues/….
import type { Ghe } from "../../../../sources/ghe.ts";
import { fakeGhe } from "../../../../../test/helpers.ts";
import { issuesPack } from "../index.ts";

/** The tracker pack on GitHub's forms, with New work: an empty issue list, `ghe` (default: one that answers nothing) behind New work. */
export const trackerPack = (o: { ghe?: Ghe } = {}) =>
  issuesPack({
    forge: { host: "acme.ghe.com", can: ["issues"], viewer: async () => ({ login: "me", name: null }), issues: async () => ({ assigned: [], mentioned: [], authored: [], triage: [] }) },
    owners: () => "ACME",
    newHref: "/issues/new",
    tasks: true,
    compose: { ghe: o.ghe ?? fakeGhe({}).ghe, org: "ACME" },
  });
