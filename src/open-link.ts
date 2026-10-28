/**
 * Links to other sites in the system's default browser (Settings → Layout, "Links to other sites").
 * Installed from Edge, Dovre's window opens a link in Edge whatever the default browser is; with
 * this on, the page sends the link here instead and the server hands it to the system's own opener,
 * which picks the default browser. Local only: hosted, there's no machine of mine to open it on.
 *
 * Only an http(s) address, as the URL parser writes it out (no spaces, no quotes, no control
 * characters), goes on to the opener, and it goes as one argument, never through a shell.
 */
import { spawn } from "node:child_process";

const MAX = 4096;

/** The address to open, or undefined when it isn't a plain web address. */
export function webUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  const href = u.href;
  return /^[\x21-\x7e]+$/.test(href) && href.length <= MAX ? href : undefined;
}

type SpawnFn = (cmd: string, args: string[], opts: { detached: boolean; windowsHide: boolean; stdio: "ignore" }) => { on(ev: "error", fn: () => void): unknown; unref?(): void };

/** The system's opener for a checked address: on Windows url.dll's handler (no cmd.exe, whose `start` splits at `&`). */
export function systemOpener(platform: NodeJS.Platform = process.platform, spawnFn: SpawnFn = spawn as unknown as SpawnFn) {
  return (href: string) => {
    const [cmd, args] = platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", href]] : platform === "darwin" ? ["open", [href]] : ["xdg-open", [href]];
    const child = spawnFn(cmd, args, { detached: true, windowsHide: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref?.();
  };
}
