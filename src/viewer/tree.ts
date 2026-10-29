/**
 * A diff's files as a folder tree (dovre#299 phase 2), for the sticky list beside a PR's files.
 * Folders before files, each by name; a folder with one folder in it and no files is one row
 * ("src/viewer"). `i` is the file's place in the list it came from. Tested in test/tree.test.ts.
 */
export type TreeNode = { dir: true; name: string; kids: TreeNode[] } | { dir: false; name: string; i: number };

type Dir = { dirs: Map<string, Dir>; files: { name: string; i: number }[] };

export function fileTree(paths: string[]): TreeNode[] {
  const root: Dir = { dirs: new Map(), files: [] };
  paths.forEach((p, i) => {
    const parts = p.split("/").filter(Boolean);
    const name = parts.pop() ?? p;
    let d = root;
    for (const part of parts) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      d = next;
    }
    d.files.push({ name, i });
  });
  const by = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const nodes = (d: Dir): TreeNode[] => [
    ...[...d.dirs].map(([name, sub]) => {
      let n = name;
      let s = sub;
      while (!s.files.length && s.dirs.size === 1) {
        const [k, v] = [...s.dirs][0]!;
        n = `${n}/${k}`;
        s = v;
      }
      return { dir: true as const, name: n, kids: nodes(s) };
    }).sort(by),
    ...d.files.map((f) => ({ dir: false as const, name: f.name, i: f.i })).sort(by),
  ];
  return nodes(root);
}
