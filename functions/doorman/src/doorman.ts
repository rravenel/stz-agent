// Doorman routes (spec §7, protocol §7.1). AWS lives behind the Deps ports.

import { classifyInvoke, type InvokeOutcome } from "../../shared/src/aws-ports.ts";
import { CommsCore, type CommsOptions, type QueuePort, type WakePort, type WakeResult } from "../../shared/src/comms-core.ts";
import { listEvents, parseEventsQuery, type LogStore } from "./events.ts";
import { authorized, json, parseJson, parseRequest, type HttpEvent, type HttpResponse } from "./http.ts";

export interface PrimeInvoker {
  /** Sync-invoke Prime with a 2 s abort; returns the raw outcome. */
  invoke(payload: object): Promise<InvokeOutcome>;
}

export type Log = (o: object) => void;

export interface Deps {
  /** The bearer token; loaded on first use. */
  token: () => Promise<string>;
  /** Ports for a fresh CommsCore per POST /messages. */
  comms?: () => { queue: QueuePort; wake: WakePort };
  prime?: PrimeInvoker;
  store?: LogStore;
  log: Log;
  ackWaitMs?: number;
  commsOptions?: Partial<CommsOptions>;
}

export const ACK_WAIT_MS = 20000;
export const MAX_TEXT_BYTES = 64 * 1024;
const MSG_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function route(deps: Deps, event: HttpEvent): Promise<HttpResponse> {
  const req = parseRequest(event);
  let token: string;
  try {
    token = await deps.token();
  } catch (e) {
    // The error's name only: never anything that could carry secret material.
    deps.log({ kind: "auth-unavailable", error: e instanceof Error ? e.name : "unknown" });
    return json(503, { error: "auth unavailable" });
  }
  if (!authorized(req, token)) return json(401, { error: "unauthorized" });
  const at = `${req.method} ${req.path}`;
  if (at === "POST /messages") {
    const p = parseJson(req.body);
    if (!p.ok) return json(400, { error: "malformed JSON" });
    return postMessage(deps, p.value);
  }
  if (at === "POST /wake") return prewake(deps);
  if (at === "GET /events") {
    const q = parseEventsQuery(req.query);
    if (!q) return json(400, { error: "after must be an integer >= -1, limit a positive integer" });
    if (!deps.store) throw new Error("doorman: no log store");
    return json(200, await listEvents(deps.store, q.after, q.limit, deps.log));
  }
  return json(404, { error: "not found" });
}

export async function postMessage(deps: Deps, body: unknown): Promise<HttpResponse> {
  const b = (body ?? {}) as { msg_id?: unknown; text?: unknown };
  if (typeof b.msg_id !== "string" || !MSG_ID_RE.test(b.msg_id)) return json(400, { error: "msg_id must be 1-128 chars of [A-Za-z0-9._-]" });
  if (typeof b.text !== "string" || Buffer.byteLength(b.text, "utf8") > MAX_TEXT_BYTES) {
    return json(400, { error: `text must be a string of at most ${MAX_TEXT_BYTES} bytes` });
  }
  if (!deps.comms) throw new Error("doorman: no comms ports");
  const msg_id = b.msg_id;
  const { queue, wake } = deps.comms();
  const comms = new CommsCore(
    "doorman",
    queue,
    wake,
    (e) => deps.log(e.kind === "wake" ? { kind: "wake", to: e.to, result: e.result, msg_id } : e),
    { pollWaitSeconds: 1, ...deps.commsOptions },
  ).start();
  comms.send("prime", "user.message", { text: b.text }, { msg_id });
  const until = Date.now() + (deps.ackWaitMs ?? ACK_WAIT_MS);
  while (comms.unackedCount() > 0 && Date.now() < until) await sleep(100);
  const acked = comms.unackedCount() === 0;
  // Finish the in-flight poll before returning: a frozen container must not resume it.
  await comms.stop();
  if (acked) return json(202, { msg_id });
  return json(503, { msg_id, error: "prime did not ack; retry with the same msg_id" });
}

export async function prewake(deps: Deps): Promise<HttpResponse> {
  let result: WakeResult;
  try {
    if (!deps.prime) throw new Error("doorman: no prime invoker");
    result = classifyInvoke(await deps.prime.invoke({ reason: "prewake" }));
  } catch (e) {
    result = { kind: "error", detail: String(e) };
  }
  deps.log({ kind: "prewake", result });
  return json(202, { wake: result.kind });
}
