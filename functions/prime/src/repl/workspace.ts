// File access for the REPL (spec §5.2): the REPL sees `/workspace`, which maps
// to a host directory (`/tmp/workspace` in Lambda). Paths are confined: no
// `..` escape and no symlink escape. Text (UTF-8) only in v0.

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix, sep } from "node:path";

export const WORKSPACE = "/workspace";
export const DEFAULT_WORKSPACE_DIR = "/tmp/workspace";

export type FsOp = "read" | "write" | "append" | "list" | "mkdir" | "rm" | "exists" | "stat";

export class Workspace {
  /** Real path of the host directory behind /workspace. */
  readonly root: string;

  constructor(dir: string = DEFAULT_WORKSPACE_DIR) {
    mkdirSync(dir, { recursive: true });
    this.root = realpathSync(dir);
  }

  /** Map a REPL path (absolute under /workspace, or relative to it) to a host path inside the root. */
  resolve(p: string): string {
    if (!p) throw new Error("path is required");
    const abs = posix.resolve(WORKSPACE, p);
    if (abs !== WORKSPACE && !abs.startsWith(`${WORKSPACE}/`)) throw new Error(`path is outside ${WORKSPACE}: ${p}`);
    const host = join(this.root, ...abs.slice(WORKSPACE.length).split("/").filter(Boolean));
    // Symlinks: the nearest existing ancestor (or the file itself) must resolve inside the root.
    let probe = host;
    while (!existsSync(probe) && probe !== this.root) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new Error(`path is outside ${WORKSPACE}: ${p}`);
    return host;
  }

  /** One entry point for the `__host_fs` host function. Returns a string; throws on error. */
  call(op: string, path: string, data: string | undefined): string {
    const host = this.resolve(path);
    switch (op as FsOp) {
      case "read": return readFileSync(host, "utf8");
      case "write": mkdirSync(dirname(host), { recursive: true }); writeFileSync(host, data ?? ""); return "";
      case "append": mkdirSync(dirname(host), { recursive: true }); appendFileSync(host, data ?? ""); return "";
      case "list": return JSON.stringify(readdirSync(host).sort());
      case "mkdir": mkdirSync(host, { recursive: true }); return "";
      case "rm":
        if (host === this.root) throw new Error(`refusing to remove ${WORKSPACE} itself`);
        rmSync(host, { recursive: true, force: true }); return "";
      case "exists": return existsSync(host) ? "true" : "false";
      case "stat": {
        const s = statSync(host);
        return JSON.stringify({ size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs });
      }
      default: throw new Error(`unknown fs op: ${op}`);
    }
  }
}
