// What Prime would install on every boot (spec §5.2): host functions in a
// fixed order, and the JS-side globals that hold in-flight state *inside* the
// snapshot (__pending resolvers, __evals results). No host-side handles.

import { readFileSync } from "node:fs";
import type { BootOptions, HostFn } from "./quickjs.ts";

export const WASM_PATH = new URL("./vendor/qjs-wasi-reactor.wasm", import.meta.url);
export const loadWasm = () => readFileSync(WASM_PATH);

export interface HostLog {
  fetches: { id: string; url: string }[];
  logs: string[];
}

/** Host functions, always in this order. Restore refuses any other order. */
export function hostFunctions(log: HostLog, extra: Partial<BootOptions> = {}): BootOptions {
  const host: Record<string, HostFn> = {
    __host_fetch: ([id, url]) => {
      log.fetches.push({ id: id!, url: url! });
      return undefined;
    },
    __host_log: (args) => {
      log.logs.push(args.join(" "));
      return undefined;
    },
  };
  return { host, ...extra };
}

/** Run once on a fresh boot (never on restore: it lives in the snapshot). */
export const PRELUDE = `
globalThis.__seq = 0;
globalThis.__pending = {};
globalThis.__evals = {};
globalThis.fetch = (url) => new Promise((resolve, reject) => {
  const id = "r" + (++__seq);
  __pending[id] = { resolve, reject };
  __host_fetch(id, url);
});
globalThis.__runEval = (id, fn) => {
  __evals[id] = { status: "pending" };
  fn().then(
    (value) => { __evals[id] = { status: "done", value }; },
    (e) => { __evals[id] = { status: "error", error: String(e) }; },
  );
};
`;

/** How Prime wraps a repl(code) tool call (spec §5.2). */
export const wrapEval = (id: string, code: string) => `__runEval(${JSON.stringify(id)}, async () => { ${code} });`;
