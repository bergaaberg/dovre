/**
 * Wiring a pack into an instance's `packs.ts` (or `crates.ts`), as text: `pnpm packs add` locally
 * (src/packs/cli.ts) and hosted Add's PR (src/actions/addpack.ts). Worker-safe.
 */
const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Finds the exported Crate/Pack identifier in `index.ts` (e.g. `cfHealthPack` or `cfHealthCrate`). */
export function detectExportName(indexTs: string, id: string): string {
  for (const want of [`${camel(id)}Pack`, `${camel(id)}Crate`]) {
    if (new RegExp(`export\\s+const\\s+${want}\\b`).test(indexTs)) return want;
  }
  const m = indexTs.match(/export\s+const\s+([A-Za-z0-9_]+)\s*(?::\s*(?:Crate|Pack))?\s*=/);
  return m?.[1] ?? `${camel(id)}Crate`;
}

/**
 * Adds an import and array entry for `exportName` in an instance's `crates.ts` or `packs.ts`.
 * Idempotent: if already imported, returns the file unchanged.
 */
export function wirePackIntoFile(sourceText: string, relImport: string, exportName: string): string {
  if (sourceText.includes(exportName) || sourceText.includes(relImport)) return sourceText;
  const importLine = `import { ${exportName} } from ${JSON.stringify(relImport)};\n`;
  let next = sourceText;
  // Insert after the last import statement, or at top of file.
  const imports = [...next.matchAll(/^import\s+[^\n]+\n/gm)];
  if (imports.length > 0) {
    const last = imports.at(-1)!;
    const idx = (last.index ?? 0) + last[0].length;
    next = next.slice(0, idx) + importLine + next.slice(idx);
  } else {
    next = importLine + next;
  }

  // Add to `const crates: Crate[] = [...]` or `const packs: Pack[] = [...]` or `export default [...]`
  const listRe = /((?:const\s+(?:crates|packs)\s*(?::[^=]+)?=\s*|export\s+default\s*)\[)([^\]]*)(\])/;
  if (listRe.test(next)) {
    next = next.replace(listRe, (_m, open: string, inner: string, close: string) => {
      const trimmed = inner.trim();
      if (!trimmed) return `${open}${exportName}${close}`;
      const sep = trimmed.endsWith(",") ? " " : ", ";
      return `${open}${trimmed}${sep}${exportName}${close}`;
    });
  }
  return next;
}
