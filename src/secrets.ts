/**
 * Secret settings from a secret store (#416). A pack setting's value can be a reference instead of
 * the key: `.dev.vars` keeps the reference, the key lives in memory only, read with the store's own
 * CLI when Dovre starts, again on "Read again", and again when the pack's refresh fails.
 *
 * | Store | Reference | Read with |
 * |---|---|---|
 * | 1Password | `op://vault/item/field` | `op read` |
 * | Azure Key Vault | `https://<vault>.vault.azure.net/secrets/<name>` | `az keyvault secret show` |
 * | AWS Secrets Manager | an ARN, or `aws://<name>` | `aws secretsmanager get-secret-value` |
 * | GCP Secret Manager | `projects/<p>/secrets/<name>[/versions/<v>]` | `gcloud secrets versions access` |
 * | Bitwarden Secrets Manager | `bw://<secret id>` | `bws secret get` |
 * | macOS Keychain | `keychain://<service>/<account>` | `security find-generic-password` |
 *
 * A pasted key goes to the Keychain on a Mac (`keychain://dovre/<KEY>`), so `.dev.vars` never holds it.
 * Hosted reads no references yet: the Worker can't run these CLIs.
 */
import { execFile } from "node:child_process";
import { removeDevVar, upsertDevVar } from "./setup.ts";
import { type Keys, refOf, type Ref, type StoreId, STORES } from "./secretrefs.ts";

export { type Keys, type KeyState, refOf, STORES } from "./secretrefs.ts";

/** A setting's name, as manifests give it: safe inside `security -i`'s line as it is. */
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Runs a store's CLI: what it printed, or why not. */
export type Cli = (cmd: string, args: string[], input?: string) => Promise<{ ok: true; out: string } | { ok: false; why: string }>;

/** 1Password may wait on Touch ID: half a minute is enough to answer it. */
const CLI_MS = 30_000;

export const runCli: Cli = (cmd, args, input) =>
  new Promise((done) => {
    const child = execFile(cmd, args, { timeout: CLI_MS, maxBuffer: 1 << 20, encoding: "utf8" }, (err, out, errOut) => {
      if (!err) return done({ ok: true, out });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === "ENOENT") return done({ ok: false, why: `${cmd} isn't on PATH` });
      if (e.killed) return done({ ok: false, why: `${cmd} didn't answer in ${CLI_MS / 1000} s` });
      // Its first line of complaint, never what it printed on stdout (that could be the key).
      const line = String(errOut ?? "").split("\n").map((l) => l.trim()).find(Boolean);
      done({ ok: false, why: line ? (line.startsWith(`${cmd}:`) ? line : `${cmd}: ${line}`).slice(0, 200) : `${cmd} failed` });
    });
    if (input !== undefined) child.stdin?.end(input);
  });

/** Reads one reference: the key, or why it can't be read. */
export async function readRef(ref: Ref, cli: Cli = runCli): Promise<{ ok: true; value: string } | { ok: false; why: string }> {
  const r = await cli(ref.cmd, ref.args);
  if (!r.ok) return r;
  let value = r.out.replace(/\r?\n$/, "");
  if (ref.json) {
    try {
      const v = (JSON.parse(value) as { value?: unknown }).value;
      value = typeof v === "string" ? v : "";
    } catch {
      return { ok: false, why: "bws didn't answer JSON" };
    }
  }
  return value.trim() ? { ok: true, value } : { ok: false, why: `it's empty in ${STORES[ref.store]}` };
}


/**
 * The references among `env`, read into it: each read key replaces its reference, and an unread
 * one is taken out of it (so a required setting shows as missing, with why). `varsFile`: where
 * Save keeps references, unset in a pack session (memory only, never the Keychain).
 */
export function createKeys(env: Record<string, string | undefined>, o: { varsFile?: string; cli?: Cli; mac?: boolean; log?: (line: string) => void } = {}): Keys {
  const cli = o.cli ?? runCli;
  const mac = o.mac ?? process.platform === "darwin";
  const refs = new Map<string, string>();
  const why = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (refOf(v)) refs.set(k, v!.trim());
  for (const k of refs.keys()) delete env[k];

  // One read at a time per store (each may ask for Touch ID once); stores in parallel.
  const queues = new Map<StoreId, Promise<unknown>>();
  const readOne = (key: string, raw: string): Promise<boolean> => {
    const ref = refOf(raw)!;
    const p = (queues.get(ref.store) ?? Promise.resolve()).then(async () => {
      const r = await readRef(ref, cli);
      if (refs.get(key) !== raw) return false;
      if (r.ok) {
        why.delete(key);
        const changed = env[key] !== r.value;
        env[key] = r.value;
        return changed;
      }
      why.set(key, r.why);
      o.log?.(`${key}: can't read it from ${STORES[ref.store]}: ${r.why}`);
      const had = key in env;
      delete env[key];
      return had;
    });
    queues.set(ref.store, p.catch(() => {}));
    return p;
  };
  const keychainRef = (key: string) => `keychain://dovre/${key}`;
  const quote = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

  return {
    state(key) {
      const raw = refs.get(key);
      if (!raw) return undefined;
      const w = why.get(key);
      return w ? { unread: w } : { from: refOf(raw)!.store };
    },
    unread: () => Object.fromEntries(why),
    async read(keys) {
      const list = (keys ?? [...refs.keys()]).filter((k) => refs.has(k));
      const changed = await Promise.all(list.map((k) => readOne(k, refs.get(k)!)));
      return changed.some(Boolean);
    },
    async save(key, raw) {
      if (!KEY.test(key)) throw new Error(`${key} isn't a setting's name`);
      if (refOf(raw)) {
        refs.set(key, raw);
        if (o.varsFile) upsertDevVar(o.varsFile, key, raw);
        await readOne(key, raw);
        return;
      }
      if (o.varsFile && mac) {
        // Over stdin, not the command line: `ps` never shows the key.
        const r = await cli("security", ["-i"], `add-generic-password -U -s dovre -a ${key} -w ${quote(raw)}\n`);
        if (r.ok) {
          refs.set(key, keychainRef(key));
          why.delete(key);
          upsertDevVar(o.varsFile, key, keychainRef(key));
          env[key] = raw;
          return;
        }
        o.log?.(`${key}: the Keychain refused it (${r.why}); kept in .dev.vars`);
      }
      refs.delete(key);
      why.delete(key);
      env[key] = raw;
      if (o.varsFile) upsertDevVar(o.varsFile, key, raw);
    },
    async clear(key) {
      if (refs.get(key) === keychainRef(key)) await cli("security", ["delete-generic-password", "-s", "dovre", "-a", key]);
      refs.delete(key);
      why.delete(key);
      delete env[key];
      if (o.varsFile) removeDevVar(o.varsFile, key);
    },
  };
}
