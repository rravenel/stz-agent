// File access for the REPL (spec §5.2): the REPL sees `/workspace`, which maps
// to a host directory (`/tmp/workspace` in Lambda). Paths are confined: no
// `..` escape, and no symlinks at all. Text (UTF-8) only in v0.

import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

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
    const parts = abs.slice(WORKSPACE.length).split("/").filter(Boolean);
    // Refuse symlinks anywhere under the root, including dangling ones: a
    // dangling link pointing outside would otherwise let `write` create the
    // outside file (#0012 review). The workspace never needs links.
    let host = this.root;
    for (const part of parts) {
      host = join(host, part);
      let st;
      try {
        st = lstatSync(host);
      } catch {
        break; // doesn't exist yet: nothing below it exists either
      }
      if (st.isSymbolicLink()) throw new Error(`path is outside ${WORKSPACE} (symlink): ${p}`);
    }
    return join(this.root, ...parts);
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
