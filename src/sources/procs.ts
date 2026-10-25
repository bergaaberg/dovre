/**
 * Running processes of a few named programs, with their command lines: one PowerShell process
 * list on Windows (it takes ~0.5 s to start, so omp and Copilot CLI share one call), `ps` elsewhere.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";

export type ProcRow = { name: string; pid: number; cmd: string };

/** `names` without an extension ("omp", "copilot"); each row's `name` is one of them. */
export function commandLines(names: string[], timeoutMs = 15_000): Promise<ProcRow[]> {
  const wanted = names.filter((n) => /^[\w-]+$/.test(n));
  if (!wanted.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const filter = wanted.map((n) => `Name='${n}.exe'`).join(" OR ");
      const ps = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return reject(err);
        try {
          const j = out.trim() ? JSON.parse(out) : [];
          resolve(
            (Array.isArray(j) ? j : [j])
              .filter((r) => r?.ProcessId && typeof r.CommandLine === "string" && typeof r.Name === "string")
              .map((r) => ({ name: String(r.Name).replace(/\.exe$/i, "").toLowerCase(), pid: Number(r.ProcessId), cmd: r.CommandLine })),
          );
        } catch (e) {
          reject(e);
        }
      });
    } else {
      execFile("ps", ["-eo", "pid=,args="], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return reject(err);
        const rows: ProcRow[] = [];
        for (const l of out.split("\n")) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(l);
          const name = m && basename(m[2].split(/\s/)[0]);
          if (m && name && wanted.includes(name)) rows.push({ name, pid: Number(m[1]), cmd: m[2] });
        }
        resolve(rows);
      });
    }
  });
}

/** A command line split into words, double quotes grouping. */
export const argvOf = (commandLine: string): string[] => [...commandLine.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
