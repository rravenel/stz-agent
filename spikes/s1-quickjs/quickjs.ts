// Spike S1 (#0011): QuickJS (quickjs-ng WASI reactor build) driven from Node,
// with snapshot/restore of the whole interpreter via its linear memory.
//
// Why this works: the reactor build's only state outside linear memory is one
// mutable global (the shadow-stack pointer), and host functions live in the
// wasm function table. We snapshot only between host calls, when the wasm
// stack is empty, so the stack pointer equals its initial value; and host
// functions are appended to the table in the same order on every boot, so
// function pointers stored inside QuickJS objects stay valid.
//
// No npm dependencies: plain WebAssembly plus a minimal WASI shim.

import { gunzipSync, gzipSync } from "node:zlib";

/** JSValue is a NaN-boxed i64 in the wasm32 build. Tags live in the high 32 bits. */
const TAG_UNDEFINED = 3n;
const TAG_EXCEPTION = 6n;
const UNDEFINED = TAG_UNDEFINED << 32n;
const tagOf = (v: bigint) => (v >> 32n) & 0xffffffffn;

export type HostFn = (args: string[]) => string | undefined;

interface Exports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  _initialize(): void;
  malloc(n: number): number;
  free(p: number): void;
  JS_NewRuntime(): number;
  JS_NewContext(rt: number): number;
  JS_Eval(ctx: number, input: number, len: number, filename: number, flags: number): bigint;
  JS_ToCStringLen2(ctx: number, plen: number, v: bigint, cesu8: number): number;
  JS_FreeCString(ctx: number, p: number): void;
  JS_FreeValue(ctx: number, v: bigint): void;
  JS_GetGlobalObject(ctx: number): bigint;
  JS_NewCFunction2(ctx: number, fn: number, name: number, length: number, proto: number, magic: number): bigint;
  JS_SetPropertyStr(ctx: number, obj: bigint, name: number, v: bigint): number;
  JS_ExecutePendingJob(rt: number, pctx: number): number;
  JS_GetException(ctx: number): bigint;
  JS_NewStringLen(ctx: number, p: number, len: number): bigint;
  JS_SetInterruptHandler(rt: number, fn: number, opaque: number): void;
}

/** What a snapshot needs besides memory: where the runtime and context live. */
interface SnapshotHeader {
  v: 1;
  rt: number;
  ctx: number;
  hostNames: string[];
  memBytes: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- WASI shim
// Just enough for QuickJS: clocks, stdout/stderr, no files, no env.
const ERRNO_SUCCESS = 0, ERRNO_BADF = 8, ERRNO_NOSYS = 52;

function wasiImports(mem: () => WebAssembly.Memory, out: string[]) {
  const dv = () => new DataView(mem().buffer);
  const nosys = () => ERRNO_NOSYS;
  return {
    environ_sizes_get(pc: number, ps: number) { dv().setUint32(pc, 0, true); dv().setUint32(ps, 0, true); return 0; },
    environ_get() { return ERRNO_SUCCESS; },
    clock_time_get(_id: number, _prec: bigint, out_: number) {
      dv().setBigUint64(out_, BigInt(Date.now()) * 1_000_000n, true); return ERRNO_SUCCESS;
    },
    fd_write(fd: number, iovs: number, n: number, pWritten: number) {
      const d = dv(); let total = 0, s = "";
      for (let i = 0; i < n; i++) {
        const p = d.getUint32(iovs + i * 8, true), l = d.getUint32(iovs + i * 8 + 4, true);
        s += dec.decode(new Uint8Array(mem().buffer, p, l)); total += l;
      }
      if (fd === 1 || fd === 2) out.push(s);
      d.setUint32(pWritten, total, true); return ERRNO_SUCCESS;
    },
    fd_prestat_get() { return ERRNO_BADF; }, // no preopened dirs: ends libc's scan
    fd_prestat_dir_name: () => ERRNO_BADF,
    fd_close: nosys, fd_fdstat_get: nosys, fd_fdstat_set_flags: nosys, fd_read: nosys, fd_readdir: nosys,
    fd_seek: nosys, path_create_directory: nosys, path_filestat_get: nosys, path_filestat_set_times: nosys,
    path_open: nosys, path_remove_directory: nosys, path_rename: nosys, path_unlink_file: nosys,
    poll_oneoff: nosys,
    proc_exit(code: number) { throw new Error(`quickjs called proc_exit(${code})`); },
  };
}

// --------------------------------------------------------- trampoline module
// QuickJS calls C function pointers from its table. A JS function can't go in
// a wasm table, so we build a tiny module whose exported wasm functions call
// one JS import with their slot number. Hand-encoded: no toolchain needed.
//   type 0: host.call(slot, ctx, this, argc, argv) -> i64
//   type 1: JSCFunction(ctx, this, argc, argv) -> i64
//   type 2: host.interrupt(rt, opaque) -> i32 (JSInterruptHandler)

function leb(n: number): number[] {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
function section(id: number, body: number[]): number[] { return [id, ...leb(body.length), ...body]; }
function vec(items: number[][]): number[] { return [...leb(items.length), ...items.flat()]; }
function name(s: string): number[] { const b = [...enc.encode(s)]; return [...leb(b.length), ...b]; }

const I32 = 0x7f, I64 = 0x7e;

function trampolineModule(slots: number): Uint8Array {
  const types = vec([
    [0x60, ...vec([[I32], [I32], [I64], [I32], [I32]]), ...vec([[I64]])],
    [0x60, ...vec([[I32], [I64], [I32], [I32]]), ...vec([[I64]])],
    [0x60, ...vec([[I32], [I32]]), ...vec([[I32]])],
  ]);
  const imports = vec([
    [...name("host"), ...name("call"), 0x00, 0],
    [...name("host"), ...name("interrupt"), 0x00, 2],
  ]);
  const funcs = vec([...Array(slots)].map(() => [1]));
  const exports = vec([
    ...[...Array(slots)].map((_, i) => [...name(`t${i}`), 0x00, ...leb(i + 2)]),
    [...name("interrupt"), 0x00, 1],
  ]);
  const bodies = vec([...Array(slots)].map((_, i) => {
    // i32.const slot; local.get 0..3; call 0
    const code = [0x41, ...sleb(i), 0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x10, 0, 0x0b];
    const body = [0x00, ...code]; // no locals
    return [...leb(body.length), ...body];
  }));
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types), ...section(2, imports), ...section(3, funcs), ...section(7, exports), ...section(10, bodies),
  ]);
}
function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) { out.push(b); return out; } out.push(b | 0x80); }
}

// ------------------------------------------------------------------ QuickJS

export interface BootOptions {
  /** Host functions, registered as globals in this exact order on every boot. */
  host: Record<string, HostFn>;
  /** Interrupt check: return true to abort the running eval (CPU limit). */
  shouldInterrupt?: () => boolean;
}

export class QuickJS {
  readonly stdout: string[] = [];
  private ex!: Exports;
  private rt = 0;
  private ctx = 0;
  private hostNames: string[] = [];
  private hostFns: HostFn[] = [];
  private shouldInterrupt: () => boolean = () => false;

  private constructor() {}

  /** Fresh interpreter with host functions installed as globals. */
  static async boot(wasm: BufferSource, opts: BootOptions): Promise<QuickJS> {
    const q = new QuickJS();
    const slots = await q.instantiate(wasm, opts);
    q.ex._initialize();
    q.rt = q.ex.JS_NewRuntime();
    q.ctx = q.ex.JS_NewContext(q.rt);
    q.ex.JS_SetInterruptHandler(q.rt, slots.interrupt, 0);
    const global = q.ex.JS_GetGlobalObject(q.ctx);
    q.hostNames.forEach((n, i) => {
      const cname = q.cstr(n);
      const fn = q.ex.JS_NewCFunction2(q.ctx, slots.fns[i]!, cname, 0, 0 /* JS_CFUNC_generic */, 0);
      q.ex.JS_SetPropertyStr(q.ctx, global, cname, fn); // takes ownership of fn
      q.ex.free(cname);
    });
    q.ex.JS_FreeValue(q.ctx, global);
    return q;
  }

  /** Rebuild an interpreter from a snapshot, in this or any other process. */
  static async restore(wasm: BufferSource, snapshot: Uint8Array, opts: BootOptions): Promise<QuickJS> {
    const raw = gunzipSync(snapshot);
    const hlen = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
    const header = JSON.parse(dec.decode(raw.subarray(4, 4 + hlen))) as SnapshotHeader;
    const mem = raw.subarray(4 + hlen);
    if (header.v !== 1 || mem.length !== header.memBytes) throw new Error("bad snapshot");
    if (JSON.stringify(Object.keys(opts.host)) !== JSON.stringify(header.hostNames)) {
      throw new Error(`host functions must be registered in the same order: ${header.hostNames}`);
    }
    const q = new QuickJS();
    await q.instantiate(wasm, opts); // same table layout as the boot that made the snapshot
    // Do NOT call _initialize: libc and QuickJS state come from the snapshot.
    const m = q.ex.memory;
    const pages = header.memBytes / 65536 - m.buffer.byteLength / 65536;
    if (pages > 0) m.grow(pages);
    new Uint8Array(m.buffer).set(mem);
    q.rt = header.rt;
    q.ctx = header.ctx;
    return q;
  }

  private async instantiate(wasm: BufferSource, opts: BootOptions) {
    this.hostNames = Object.keys(opts.host);
    this.hostFns = Object.values(opts.host);
    if (opts.shouldInterrupt) this.shouldInterrupt = opts.shouldInterrupt;
    const { instance } = await WebAssembly.instantiate(wasm, {
      wasi_snapshot_preview1: wasiImports(() => this.ex.memory, this.stdout),
    });
    this.ex = instance.exports as unknown as Exports;
    const tramp = await WebAssembly.instantiate(trampolineModule(this.hostFns.length), {
      host: {
        call: (slot: number, ctx: number, _this: bigint, argc: number, argv: number) => this.onHostCall(slot, ctx, argc, argv),
        interrupt: () => (this.shouldInterrupt() ? 1 : 0),
      },
    });
    const t = tramp.instance.exports as Record<string, WebAssembly.ExportValue>;
    // Append to QuickJS's table in a fixed order: indices are identical on
    // every boot and restore, so pointers saved inside the snapshot stay valid.
    const table = this.ex.__indirect_function_table;
    const base = table.grow(this.hostFns.length + 1);
    this.hostFns.forEach((_, i) => table.set(base + i, t[`t${i}`] as Function));
    table.set(base + this.hostFns.length, t["interrupt"] as Function);
    return { fns: this.hostFns.map((_, i) => base + i), interrupt: base + this.hostFns.length };
  }

  private onHostCall(slot: number, ctx: number, argc: number, argv: number): bigint {
    const dv = new DataView(this.ex.memory.buffer);
    const args: string[] = [];
    for (let i = 0; i < argc; i++) args.push(this.toString(ctx, dv.getBigUint64(argv + i * 8, true)));
    const r = this.hostFns[slot]!(args);
    if (r === undefined) return UNDEFINED;
    const p = this.cstr(r);
    const v = this.ex.JS_NewStringLen(ctx, p, enc.encode(r).length);
    this.ex.free(p);
    return v;
  }

  /** Evaluate a global script; returns String(result). Throws on a JS exception. */
  eval(code: string): string {
    const src = this.cstr(code), file = this.cstr("<eval>");
    const v = this.ex.JS_Eval(this.ctx, src, enc.encode(code).length, file, 0 /* JS_EVAL_TYPE_GLOBAL */);
    this.ex.free(src);
    this.ex.free(file);
    if (tagOf(v) === TAG_EXCEPTION) {
      const e = this.ex.JS_GetException(this.ctx);
      const msg = this.toString(this.ctx, e);
      this.ex.JS_FreeValue(this.ctx, e);
      throw new Error(`QuickJS: ${msg}`);
    }
    const s = this.toString(this.ctx, v);
    this.ex.JS_FreeValue(this.ctx, v);
    return s;
  }

  /** Run queued promise jobs until none are left. Returns how many ran. */
  runJobs(): number {
    let n = 0;
    while (this.ex.JS_ExecutePendingJob(this.rt, 0) > 0) n++;
    return n;
  }

  /** Snapshot: header + full linear memory, gzipped. Only call between host calls. */
  snapshot(): Uint8Array {
    const mem = new Uint8Array(this.ex.memory.buffer);
    const header: SnapshotHeader = { v: 1, rt: this.rt, ctx: this.ctx, hostNames: this.hostNames, memBytes: mem.length };
    const h = enc.encode(JSON.stringify(header));
    const out = new Uint8Array(4 + h.length + mem.length);
    new DataView(out.buffer).setUint32(0, h.length, true);
    out.set(h, 4);
    out.set(mem, 4 + h.length);
    return gzipSync(out, { level: 1 });
  }

  memoryBytes(): number {
    return this.ex.memory.buffer.byteLength;
  }

  private toString(ctx: number, v: bigint): string {
    const p = this.ex.JS_ToCStringLen2(ctx, 0, v, 0);
    if (!p) return "<unprintable>";
    const bytes = new Uint8Array(this.ex.memory.buffer, p);
    const s = dec.decode(bytes.subarray(0, bytes.indexOf(0)));
    this.ex.JS_FreeCString(ctx, p);
    return s;
  }

  /** malloc a NUL-terminated UTF-8 copy of s. Caller frees. */
  private cstr(s: string): number {
    const b = enc.encode(s);
    const p = this.ex.malloc(b.length + 1);
    const m = new Uint8Array(this.ex.memory.buffer, p, b.length + 1);
    m.set(b);
    m[b.length] = 0;
    return p;
  }
}
