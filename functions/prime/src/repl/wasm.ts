// Locate and verify the pinned QuickJS build (quickjs-ng v0.18.0,
// qjs-wasi-reactor.wasm; the build spike S1 tested). The file is vendored in
// functions/prime/vendor/ and checked against its SHA-256 on every load, so a
// swapped or corrupt binary fails loudly instead of running.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const QJS_WASM_FILE = "qjs-wasi-reactor.wasm";
export const QJS_WASM_SHA256 = "8afa5d73287af5573613e15d5e633e91d8e096b40676f424f104087bc1416678";

/** Where to look, in order: $STZ_QJS_WASM, next to the bundle, then the source tree's vendor/. */
export function wasmCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.STZ_QJS_WASM) out.push(env.STZ_QJS_WASM);
  out.push(fileURLToPath(new URL(`./${QJS_WASM_FILE}`, import.meta.url)));
  out.push(fileURLToPath(new URL(`../../vendor/${QJS_WASM_FILE}`, import.meta.url)));
  return out;
}

let cached: Uint8Array | undefined;

/** The verified wasm bytes. Cached per process (Lambda keeps it across warm invocations). */
export function loadWasm(): Uint8Array {
  if (cached) return cached;
  const tried = wasmCandidates();
  const file = tried.find((p) => existsSync(p));
  if (!file) throw new Error(`QuickJS wasm not found; tried: ${tried.join(", ")}`);
  const bytes = readFileSync(file);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== QJS_WASM_SHA256) throw new Error(`QuickJS wasm at ${file} has SHA-256 ${sha}, expected ${QJS_WASM_SHA256}`);
  cached = new Uint8Array(bytes);
  return cached;
}
