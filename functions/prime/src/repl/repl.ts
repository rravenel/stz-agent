// Prime's `repl(code)` tool (spec §5.2, §5.3): QuickJS in WASM, with
// snapshot/restore so an eval waiting on fetch() survives Prime exiting.
//
// Everything in flight lives in JS globals inside the snapshot, never in host
// objects: `__pending[request_id]` holds fetch resolvers, `__evals[id]` holds
// eval results, `__io` holds console output not yet returned. The host reads
// them after running promise jobs to quiescence.

import { QuickJS, QuickJSError, type HostFn } from "./quickjs.ts";
import { loadWasm } from "./wasm.ts";
import { Workspace, DEFAULT_WORKSPACE_DIR, WORKSPACE } from "./workspace.ts";

/** A fetch() made inside the REPL, handed to Prime's network proxy. */
export interface FetchRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** What the proxy resolves a fetch with (body as text in v0). */
export interface FetchResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: string;
}

/** The tool result (spec §5.2): settled, or still waiting on fetches. */
export type EvalResult =
  | { status: "done"; value?: string; stdout: string; stderr: string; error?: string }
  | { status: "pending" };

export interface ReplOptions {
  /** QuickJS wasm bytes; defaults to the vendored, SHA-checked build. */
  wasm?: Uint8Array;
  /** Host directory behind `/workspace`. Default `/tmp/workspace`. */
  workspaceDir?: string;
  /** CPU time per host→REPL call (an eval, or resolving a fetch). Default 30 s. */
  cpuLimitMs?: number;
  /**
   * Called synchronously from inside the REPL for each fetch(). Must not call
   * back into the Repl; queue the work and return. Throwing rejects the fetch.
   */
  onFetch?: (req: FetchRequest) => void;
  /** Mirror of console output, for Prime's own log. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export const DEFAULT_CPU_LIMIT_MS = 30_000;
/** After the first interrupt, uncatchable-error cleanup gets this long before every further check trips. */
const INTERRUPT_GRACE_MS = 1_000;
/** Per eval, per stream; the rest is dropped with a marker. */
const OUTPUT_LIMIT_CHARS = 64 * 1024;

/**
 * Host functions, in the order they are registered on every boot. Restore
 * refuses a snapshot made with any other order. Append only; never reorder.
 */
const HOST_ORDER = ["__host_fetch", "__host_log", "__host_fs"] as const;

/** Installed once on a fresh boot. On restore it is already in the snapshot. */
const PRELUDE = String.raw`
(() => {
  const g = globalThis;
  const hostFetch = g.__host_fetch, hostLog = g.__host_log, hostFs = g.__host_fs;
  // Model code reaches the host only through fetch, console and fs.
  delete g.__host_fetch; delete g.__host_log; delete g.__host_fs;
  // No timers in v0 (a pending timer would block Prime's exit).
  delete g.setTimeout; delete g.setInterval; delete g.clearTimeout; delete g.clearInterval;

  g.__seq = 0;
  g.__pending = {};
  g.__evals = {};
  g.__io = { stdout: "", stderr: "", cut: false };

  const LIMIT = ${OUTPUT_LIMIT_CHARS};
  const show = (x) => {
    if (typeof x === "string") return x;
    try { const j = JSON.stringify(x); return j === undefined ? String(x) : j; } catch { return String(x); }
  };
  const errText = (e) => {
    if (e instanceof Error) return e.stack ? String(e) + "\n" + e.stack.trimEnd() : String(e);
    return "Uncaught " + show(e);
  };
  const writer = (stream) => (...args) => {
    const s = args.map(show).join(" ") + "\n";
    hostLog(stream, s);
    if (__io[stream].length + s.length <= LIMIT) __io[stream] += s;
    else if (!__io.cut) { __io.cut = true; __io[stream] += "[output truncated]\n"; }
  };
  g.console = {
    log: writer("stdout"), info: writer("stdout"), debug: writer("stdout"),
    warn: writer("stderr"), error: writer("stderr"),
  };

  g.fetch = (url, opts) => new Promise((resolve, reject) => {
    const o = opts || {};
    const id = "r" + (++__seq);
    __pending[id] = { resolve, reject };
    try {
      hostFetch(id, String(url), JSON.stringify({
        method: String(o.method || "GET").toUpperCase(),
        headers: o.headers || {},
        body: o.body == null ? null : String(o.body),
      }));
    } catch (e) {
      delete __pending[id];
      throw e;
    }
  });

  const response = (r, url) => {
    const headers = {};
    for (const k of Object.keys(r.headers || {})) headers[k.toLowerCase()] = String(r.headers[k]);
    return {
      url, status: r.status, statusText: r.statusText || "", ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null, entries: () => Object.entries(headers) },
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    };
  };
  // Host → REPL: settle a fetch. Returns false if the request is unknown.
  g.__settle = (id, ok, payload, url) => {
    const p = __pending[id];
    if (!p) return false;
    delete __pending[id];
    if (ok) p.resolve(response(JSON.parse(payload), url)); else p.reject(new Error(payload));
    return true;
  };

  const finish = (id, r) => {
    // A discarded eval (its conversation was cleared) leaves nothing behind.
    if (__evals[id]?.discarded) { delete __evals[id]; return; }
    r.status = "done";
    r.stdout = __io.stdout; r.stderr = __io.stderr;
    __io.stdout = ""; __io.stderr = ""; __io.cut = false;
    __evals[id] = r;
  };
  g.__runEval = (id, fn) => {
    __evals[id] = { status: "pending" };
    fn().then(
      (v) => finish(id, v === undefined ? {} : { value: show(v) }),
      (e) => finish(id, { error: errText(e) }),
    );
  };
  // Host-side failure recording (e.g. the CPU limit killed the handlers).
  g.__failEval = (id, error) => { if (__evals[id]?.status === "pending") finish(id, { error }); };
  // Host: forget an eval. A pending one is dropped when it settles.
  g.__discardEval = (id) => {
    const e = __evals[id];
    if (!e) return;
    if (e.status === "pending") e.discarded = true; else delete __evals[id];
  };
  g.fs = {
    readFile: (p) => hostFs("read", String(p)),
    writeFile: (p, data) => { hostFs("write", String(p), String(data)); },
    appendFile: (p, data) => { hostFs("append", String(p), String(data)); },
    readdir: (p = "${WORKSPACE}") => JSON.parse(hostFs("list", String(p))),
    mkdir: (p) => { hostFs("mkdir", String(p)); },
    rm: (p) => { hostFs("rm", String(p)); },
    exists: (p) => hostFs("exists", String(p)) === "true",
    stat: (p) => JSON.parse(hostFs("stat", String(p))),
  };
})();
`;

const lit = (s: string) => JSON.stringify(s);

export class Repl {
  private deadline = Infinity;
  private trippedAt = 0;
  /** Set when the interrupt handler aborted something during the current call. */
  private interrupted = false;
  private q!: QuickJS;

  private readonly opts: ReplOptions;

  private constructor(opts: ReplOptions) {
    this.opts = opts;
  }

  /** A fresh REPL. */
  static async create(opts: ReplOptions = {}): Promise<Repl> {
    const r = new Repl(opts);
    r.q = await QuickJS.boot(opts.wasm ?? loadWasm(), r.bootOptions());
    r.q.eval(PRELUDE, "<prelude>");
    return r;
  }

  /** A REPL rebuilt from snapshot() output, in this or any other process. */
  static async restore(snapshot: Uint8Array, opts: ReplOptions = {}): Promise<Repl> {
    const r = new Repl(opts);
    r.q = await QuickJS.restore(opts.wasm ?? loadWasm(), snapshot, r.bootOptions());
    return r;
  }

  private bootOptions() {
    const ws = new Workspace(this.opts.workspaceDir ?? DEFAULT_WORKSPACE_DIR);
    const fns: Record<(typeof HOST_ORDER)[number], HostFn> = {
      __host_fetch: ([requestId, url, opts]) => {
        if (!this.opts.onFetch) throw new Error("fetch is not available");
        const o = JSON.parse(opts!) as Omit<FetchRequest, "requestId" | "url">;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(o.headers ?? {})) headers[k] = String(v);
        this.opts.onFetch({ requestId: requestId!, url: url!, method: o.method, headers, body: o.body });
        return undefined;
      },
      __host_log: ([stream, text]) => {
        this.opts.onOutput?.(stream === "stderr" ? "stderr" : "stdout", text!);
        return undefined;
      },
      __host_fs: ([op, path, data]) => {
        try {
          return ws.call(op!, path!, data);
        } catch (e) {
          // Report REPL paths, not host paths.
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(msg.split(ws.root).join(WORKSPACE));
        }
      },
    };
    const host: Record<string, HostFn> = {};
    for (const n of HOST_ORDER) host[n] = fns[n];
    return { host, shouldInterrupt: () => this.shouldInterrupt() };
  }

  private shouldInterrupt(): boolean {
    const now = Date.now();
    if (now < this.deadline) return false;
    if (this.trippedAt && now < this.trippedAt + INTERRUPT_GRACE_MS) return false;
    if (!this.trippedAt) this.trippedAt = now;
    else this.deadline = -Infinity; // grace used up: every check trips from now on
    this.interrupted = true;
    return true;
  }

  /** Run f with the CPU limit armed, then drain promise jobs under the same limit. */
  private drive(f: () => void): { interrupted: boolean; jobErrors: string[] } {
    if (this.q.busy) throw new Error("Repl is not re-entrant (called from inside onFetch/onOutput?)");
    this.deadline = Date.now() + (this.opts.cpuLimitMs ?? DEFAULT_CPU_LIMIT_MS);
    this.trippedAt = 0;
    this.interrupted = false;
    try {
      f();
      const { errors } = this.q.runJobs();
      return { interrupted: this.interrupted, jobErrors: errors };
    } finally {
      this.deadline = Infinity;
    }
  }

  /**
   * Run `code` as the body of an async function (so `await` and `return`
   * work). Declarations are local to the eval: keep state on `globalThis`.
   * Returns the result, or `pending` if it is waiting on fetch().
   */
  eval(toolCallId: string, code: string): EvalResult {
    let syntaxError: string | undefined;
    const { interrupted, jobErrors } = this.drive(() => {
      try {
        // Code starts on line 1 (so error positions match the model's code); the
        // newline before the closing brace keeps a trailing `//` comment from eating it.
        this.q.eval(`__runEval(${lit(toolCallId)}, async () => {${code}\n});`, `<${toolCallId}>`);
      } catch (e) {
        if (!(e instanceof QuickJSError)) throw e;
        syntaxError = e.message;
      }
    });
    if (syntaxError !== undefined) {
      // The wrapper never ran (a syntax error), or the interrupt hit before it registered the eval.
      const error = interrupted ? cpuError(this.opts.cpuLimitMs) : syntaxError;
      return { status: "done", stdout: "", stderr: "", error };
    }
    if (interrupted || jobErrors.length) {
      this.fail(toolCallId, interrupted ? cpuError(this.opts.cpuLimitMs) : jobErrors.join("\n"));
    }
    return this.take(toolCallId);
  }

  /** Resolve a fetch made by the REPL and run the code waiting on it. */
  resolvePending(requestId: string, response: FetchResponse, url = ""): void {
    this.settle(requestId, true, JSON.stringify(response), url);
  }

  /** Reject a fetch made by the REPL (network error, timeout) and run the code waiting on it. */
  rejectPending(requestId: string, error: string): void {
    this.settle(requestId, false, error, "");
  }

  private settle(requestId: string, ok: boolean, payload: string, url: string) {
    let known = "true";
    const { interrupted, jobErrors } = this.drive(() => {
      known = this.q.eval(`__settle(${lit(requestId)}, ${ok}, ${lit(payload)}, ${lit(url)})`, "<settle>");
    });
    if (interrupted || jobErrors.length) {
      // An uncatchable error (the CPU limit) killed resumed code before its
      // eval could record anything, and a promise job doesn't say which eval
      // it belongs to. Fail every eval still waiting: Prime has one open
      // tool call at a time, and the runaway one is among them.
      const error = interrupted ? cpuError(this.opts.cpuLimitMs) : jobErrors.join("\n");
      for (const id of this.pendingEvals()) this.fail(id, error);
    }
    if (known !== "true") throw new Error(`no pending fetch with id ${requestId}`);
  }

  /**
   * The result of an eval, once. A settled result is removed from the REPL,
   * so ask only when you will log it. `pending` until its fetches resolve.
   */
  take(toolCallId: string): EvalResult {
    const raw = this.q.eval(
      `(() => { const r = __evals[${lit(toolCallId)}]; if (r && r.status !== "pending") delete __evals[${lit(toolCallId)}]; return JSON.stringify(r ?? null); })()`,
      "<take>",
    );
    const r = JSON.parse(raw) as EvalResult | null;
    if (!r) throw new Error(`no eval with id ${toolCallId}`);
    return r;
  }

  /** Request ids of fetches still waiting for a response (they are in the snapshot). */
  pendingRequests(): string[] {
    return JSON.parse(this.q.eval(`JSON.stringify(Object.keys(__pending))`, "<pending>")) as string[];
  }

  /** Ids of evals still waiting on fetches. */
  pendingEvals(): string[] {
    return JSON.parse(
      this.q.eval(`JSON.stringify(Object.keys(__evals).filter((k) => __evals[k].status === "pending" && !__evals[k].discarded))`, "<pending>"),
    ) as string[];
  }

  /**
   * Forget an eval: a settled result is deleted now, a pending one when it
   * settles. Its fetches still complete (the REPL holds their resolvers).
   */
  discard(toolCallId: string): void {
    this.q.eval(`__discardEval(${lit(toolCallId)})`, "<discard>");
  }

  /** Every eval id the REPL still holds, discarded ones included (for tests and leak checks). */
  evalIds(): string[] {
    return JSON.parse(this.q.eval(`JSON.stringify(Object.keys(__evals))`, "<evals>")) as string[];
  }

  /** True while control is inside QuickJS (an eval or a host call). */
  get busy(): boolean {
    return this.q.busy;
  }

  /** The REPL's whole state. Only valid between calls (never from inside onFetch). */
  snapshot(): Uint8Array {
    return this.q.snapshot();
  }

  private fail(toolCallId: string, error: string) {
    this.drive(() => { this.q.eval(`__failEval(${lit(toolCallId)}, ${lit(error)})`, "<fail>"); });
  }
}

const cpuError = (ms = DEFAULT_CPU_LIMIT_MS) => `Error: eval exceeded the CPU time limit (${ms} ms) and was interrupted`;
