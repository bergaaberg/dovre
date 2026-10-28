/** GitHub (github.com, GHE.com or Enterprise Server) as a forge: the default, through the Ghe client. */
import { loadChangelog } from "../sources/changelog.ts";
import { type Ghe, loadDeploys, loadMoves, loadNotes, loadPrRefs, loadPrs, loadRedBranches, prKeyOfUrl, viewer } from "../sources/ghe.ts";
import { actOnIssue, loadIssue, loadIssues } from "../sources/issues.ts";
import { loadFile, loadRepos } from "../sources/files.ts";
import { proposeFile } from "../actions/propose.ts";
import { loadMerged, loadWork } from "../sources/work.ts";
import { FORGE_CAN, type Forge } from "./types.ts";

export function githubForge(ghe: Ghe): Forge {
  /** The notes came from search (the token can't read notifications): red CI is read from runs instead. */
  let searched = false;
  return {
    id: "github",
    name: "GitHub",
    host: ghe.host,
    can: FORGE_CAN,
    viewer: () => viewer(ghe),
    prs: (login, owners) => loadPrs(ghe, login, owners),
    notes: () => loadNotes(ghe, { searched: (yes) => (searched = yes) }),
    moves: (login, owners) => loadMoves(ghe, login, owners),
    prRefs: (keys) => loadPrRefs(ghe, keys),
    prKeyOfUrl,
    deploys: (repos) => loadDeploys(ghe, repos),
    changelog: (repo, env, head) => loadChangelog(ghe, repo, env, head),
    red: (notes, repos) => loadRedBranches(ghe, notes, searched ? repos : []),
    issues: (login, owners, opts) => loadIssues(ghe, login, owners, opts),
    issue: (repo, n) => loadIssue(ghe, repo, n),
    issueAct: (a) => actOnIssue(ghe, a),
    work: (login, owners, since) => loadWork(ghe, login, owners, since),
    merged: (login, owners, since) => loadMerged(ghe, login, owners, since),
    repos: (owners) => loadRepos(ghe, owners),
    file: (repo, path) => loadFile(ghe, repo, path),
    propose: (p) => proposeFile(ghe, p),
  };
}
