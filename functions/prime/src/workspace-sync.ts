// Mirror /tmp/workspace to S3 workspace/ at checkpoint, and back at restore
// (spec §4, §5.4). Regular files only: symlinks and other special files are
// never uploaded or followed, and a restore only ever creates plain files and
// directories (#0012 review).

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { WORKSPACE_PREFIX, workspaceKey } from "../../shared/src/s3-keys.ts";
import type { ObjectStore } from "./store.ts";

/** path relative to the workspace root → SHA-256 of what S3 holds for it. */
export type Manifest = Map<string, string>;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface SyncUpResult {
  uploaded: string[];
  deleted: string[];
  /** Symlinks and other non-regular files that were left out. */
  skipped: string[];
}

/** Walk dir without following links. */
function walk(root: string): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p).split(sep).join("/");
      if (st.isDirectory()) visit(p);
      else if (st.isFile()) files.push(rel);
      else skipped.push(rel);
    }
  };
  visit(root);
  return { files, skipped };
}

/**
 * Upload files that changed since `manifest` (what S3 already holds), delete
 * keys whose file is gone, and update `manifest` to match.
 */
export async function syncUp(store: ObjectStore, dir: string, manifest: Manifest): Promise<SyncUpResult> {
  mkdirSync(dir, { recursive: true });
  const { files, skipped } = walk(dir);
  const uploaded: string[] = [];
  const deleted: string[] = [];
  const present = new Set(files);
  for (const rel of files) {
    const body = readFileSync(join(dir, ...rel.split("/")));
    const h = sha(body);
    if (manifest.get(rel) === h) continue;
    await store.put(workspaceKey(rel), body);
    manifest.set(rel, h);
    uploaded.push(rel);
  }
  for (const rel of [...manifest.keys()]) {
    if (present.has(rel)) continue;
    await store.delete(workspaceKey(rel));
    manifest.delete(rel);
    deleted.push(rel);
  }
  return { uploaded, deleted, skipped };
}

export interface SyncDownResult {
  manifest: Manifest;
  /** Keys that couldn't be restored (malformed, or clashing with a directory), with why. */
  skipped: { key: string; reason: string }[];
}

/**
 * Replace dir's contents with S3 workspace/. Emptying it first means a warm
 * container can't carry a stale file or link from an earlier run. A bad key
 * is skipped and reported, never fatal: one odd object must not stop every
 * Prime start (#0015 review).
 */
export async function syncDown(store: ObjectStore, dir: string): Promise<SyncDownResult> {
  if (!dir || dir === "/" || dir === sep) throw new Error(`refusing to use ${JSON.stringify(dir)} as the workspace`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const manifest: Manifest = new Map();
  const skipped: SyncDownResult["skipped"] = [];
  for (const key of await store.list(WORKSPACE_PREFIX)) {
    const rel = key.slice(WORKSPACE_PREFIX.length);
    try {
      workspaceKey(rel); // throws on "", ".", ".." segments or an absolute path
      const body = await store.get(key);
      if (!body) continue;
      const p = join(dir, ...rel.split("/"));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body, { flag: "wx" }); // fresh dir: never follows or overwrites anything
      manifest.set(rel, sha(body));
    } catch (e) {
      skipped.push({ key, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { manifest, skipped };
}
