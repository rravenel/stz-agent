// Test helper for repl.test.ts: restore a REPL snapshot in a brand-new
// process, resolve its pending fetch, and print what happened as JSON.
// Usage: node repl.child.ts <snapshot-file> <workspace-dir>
import { readFileSync } from "node:fs";
import { Repl, type FetchRequest } from "./repl.ts";

const [file, workspaceDir] = process.argv.slice(2);
const fetches: FetchRequest[] = [];
const repl = await Repl.restore(readFileSync(file!), { workspaceDir: workspaceDir!, onFetch: (r) => fetches.push(r) });
const before = { pendingRequests: repl.pendingRequests(), pendingEvals: repl.pendingEvals() };
repl.resolvePending("r1", { status: 200, body: "world" });
const e1 = repl.take("e1");
const e2 = repl.eval("e2", `fetch("https://example.com/next"); return [greet("again"), globalThis.counter]`);
console.log(JSON.stringify({ before, e1, e2, fetches }));
