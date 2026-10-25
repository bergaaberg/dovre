/** GitHub (github.com, GHE.com or Enterprise Server) as a forge: the default, through the Ghe client. */
import { loadChangelog } from "../sources/changelog.ts";
import { type Ghe, loadDeploys, loadMoves, loadNotes, loadPrRefs, loadPrs, loadRedBranches, prKeyOfUrl, viewer } from "../sources/ghe.ts";
import { FORGE_CAN, type Forge } from "./types.ts";

export function githubForge(ghe: Ghe): Forge {
  return {
    id: "github",
    name: "GitHub",
    host: ghe.host,
    can: FORGE_CAN,
    viewer: () => viewer(ghe),
    prs: (login, owners) => loadPrs(ghe, login, owners),
    notes: () => loadNotes(ghe),
    moves: (login, owners) => loadMoves(ghe, login, owners),
    prRefs: (keys) => loadPrRefs(ghe, keys),
    prKeyOfUrl,
    deploys: (repos) => loadDeploys(ghe, repos),
    changelog: (repo, env, head) => loadChangelog(ghe, repo, env, head),
    red: (notes) => loadRedBranches(ghe, notes),
  };
}
