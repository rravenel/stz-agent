// stz client: node client/src/cli.ts [--url URL] [--token-env NAME]
// The token is read from an env var (default STZ_API_TOKEN), never a flag,
// so it stays out of shell history and `ps`. It is never printed.

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Api } from "./api.ts";
import { runTurn } from "./turn.ts";

/** Page to the end of the log so old history isn't replayed. */
export async function tail(api: Api): Promise<number> {
  let after = -1;
  for (;;) {
    const p = await api.events(after);
    after = p.next_after;
    if (!p.more) return after;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { url: { type: "string" }, "token-env": { type: "string" } } });
  const url = values.url ?? process.env["STZ_API_URL"];
  const tokenEnv = values["token-env"] ?? "STZ_API_TOKEN";
  const token = process.env[tokenEnv];
  if (!url) throw new Error("no API URL: pass --url or set STZ_API_URL");
  if (!token) throw new Error(`no token: set ${tokenEnv}`);
  const api = new Api({ baseUrl: url, token });
  console.log(`stz client → ${url}`);
  const w = await api.wake();
  console.log(`· wake ${JSON.stringify(w.wake)}`);
  let after = await tail(api);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });
  const tty = Boolean(process.stdout.isTTY);
  for (;;) {
    let line: string;
    try {
      line = (await rl.question("> ")).trim();
    } catch {
      break; // stdin closed
    }
    if (line === "/quit") break;
    if (!line) continue;
    try {
      const r = await runTurn(api, line, { print: (l) => console.log(l), after, tty });
      after = r.after;
      if (r.ended !== "end_turn") console.log(`· turn ended: ${r.ended}`);
    } catch (e) {
      console.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  rl.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(`! ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
