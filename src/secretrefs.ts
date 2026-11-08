/**
 * Secret references (#416): what counts as one, and the command that reads it. No Node here: the
 * Packs page (hosted too) names a key's store, and the Worker takes references out of its vars.
 * The reading itself is src/secrets.ts, on a machine.
 */
export type StoreId = "op" | "akv" | "aws" | "gcp" | "bw" | "keychain";
export const STORES: Record<StoreId, string> = { op: "1Password", akv: "Azure Key Vault", aws: "AWS Secrets Manager", gcp: "GCP Secret Manager", bw: "Bitwarden", keychain: "the Keychain" };

/** The command that reads it: never a shell, every part checked by the patterns below. */
export type Ref = { store: StoreId; cmd: string; args: string[]; /** `bws` answers JSON: the key is its `value`. */ json?: true };

const OP = /^op:\/\/[^/\s][^/\n]{0,99}(?:\/[^/\n]{1,100}){2,3}$/;
const AKV = /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]{1,127}(?:\/[0-9a-f]{32})?\/?$/;
const ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]{1,30}:\d{12}:secret:[\w/+=.@-]{1,512}$/;
const AWS = /^aws:\/\/([\w/+=.@-]{1,512})$/;
const GCP = /^projects\/([a-z][a-z0-9-]{4,29}|\d{1,20})\/secrets\/([\w-]{1,255})(?:\/versions\/(\d{1,10}|latest))?$/;
const BW = /^bw:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const KEYCHAIN = /^keychain:\/\/([\w.-]{1,100})\/([\w.-]{1,100})$/;

/** A reference, and how to read it; anything else is the key itself. */
export function refOf(raw: string | undefined): Ref | undefined {
  const v = raw?.trim();
  if (!v || v.length > 600) return undefined;
  if (OP.test(v)) return { store: "op", cmd: "op", args: ["read", "--no-newline", v] };
  if (AKV.test(v)) return { store: "akv", cmd: "az", args: ["keyvault", "secret", "show", "--id", v, "--query", "value", "--output", "tsv"] };
  const aws = ARN.test(v) ? v : AWS.exec(v)?.[1];
  if (aws) return { store: "aws", cmd: "aws", args: ["secretsmanager", "get-secret-value", "--secret-id", aws, "--query", "SecretString", "--output", "text"] };
  const g = GCP.exec(v);
  if (g) return { store: "gcp", cmd: "gcloud", args: ["secrets", "versions", "access", g[3] ?? "latest", `--secret=${g[2]}`, `--project=${g[1]}`] };
  const b = BW.exec(v);
  if (b) return { store: "bw", cmd: "bws", args: ["secret", "get", b[1]!, "--output", "json"], json: true };
  const k = KEYCHAIN.exec(v);
  if (k) return { store: "keychain", cmd: "security", args: ["find-generic-password", "-s", k[1]!, "-a", k[2]!, "-w"] };
  return undefined;
}

/** Where a key came from, for its settings row. */
export type KeyState = { from: StoreId } | { unread: string };

export type Keys = {
  /** A key's source or why it can't be read; nothing when it's the key itself (or unset). */
  state(key: string): KeyState | undefined;
  /** Why each unread key can't be read. */
  unread(): Record<string, string>;
  /** Reads these keys' references again (all of them by default); true when one changed. */
  read(keys?: string[]): Promise<boolean>;
  /** Settings' Save: a reference is kept and read; a pasted key goes to the Keychain on a Mac. */
  save(key: string, raw: string): Promise<void>;
  clear(key: string): Promise<void>;
};

/** Hosted: a reference among the Worker's vars can't be read there yet. Takes them out of `env`, with why. */
export function hostedKeys(env: Record<string, string | undefined>): Keys {
  const why: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const ref = refOf(v);
    if (!ref) continue;
    delete env[k];
    why[k] = `a ${STORES[ref.store]} reference, read only on a machine for now. Set the key itself as the Worker's secret`;
  }
  const no = () => Promise.reject(new Error("hosted keys are the Worker's secrets"));
  return { state: (k) => (why[k] ? { unread: why[k] } : undefined), unread: () => ({ ...why }), read: async () => false, save: no, clear: no };
}
