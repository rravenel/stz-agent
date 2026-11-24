// AWS adapters for the comms ports (protocol §4.1, §6).
//
// SqsQueuePort / LambdaWakePort wrap the SDK; classifyInvoke stays pure so it
// is testable without AWS.

import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { QueuePort, WakePort, WakeResult } from "./comms-core.ts";
import type { Endpoint, Envelope } from "./envelope.ts";

export class SqsQueuePort implements QueuePort {
  private readonly client: SQSClient;
  private readonly urls: Record<Endpoint, string>;
  private readonly self: Endpoint;
  constructor(urls: Record<Endpoint, string>, self: Endpoint, client?: SQSClient) {
    this.urls = urls;
    this.self = self;
    this.client = client ?? new SQSClient({});
  }

  async receive(waitSeconds: number): Promise<{ body: string; receipt: string }[]> {
    const r = await this.client.send(
      new ReceiveMessageCommand({ QueueUrl: this.urls[this.self], WaitTimeSeconds: waitSeconds, MaxNumberOfMessages: 10 }),
    );
    return (r.Messages ?? []).flatMap((m) => (m.ReceiptHandle ? [{ body: m.Body ?? "", receipt: m.ReceiptHandle }] : []));
  }

  async send(to: Endpoint, msg: Envelope): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.urls[to], MessageBody: JSON.stringify(msg) }));
  }

  async delete(receipt: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.urls[this.self], ReceiptHandle: receipt }));
  }

  async release(receipt: string): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.urls[this.self], ReceiptHandle: receipt, VisibilityTimeout: 0 }),
    );
  }
}

export class LambdaWakePort implements WakePort {
  private readonly client: LambdaClient;
  private readonly names: Record<Endpoint, string>;
  private readonly callTimeoutMs: number;
  constructor(names: Record<Endpoint, string>, callTimeoutMs = 2000, client?: LambdaClient) {
    this.names = names;
    this.callTimeoutMs = callTimeoutMs;
    this.client = client ?? new LambdaClient({ maxAttempts: 1 });
  }

  async wake(to: Endpoint): Promise<WakeResult> {
    try {
      const r = await this.client.send(
        new InvokeCommand({
          FunctionName: this.names[to],
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(JSON.stringify({ reason: "wake" })),
        }),
        { abortSignal: AbortSignal.timeout(this.callTimeoutMs) },
      );
      return classifyInvoke({ ok: true, StatusCode: r.StatusCode, FunctionError: r.FunctionError });
    } catch (error) {
      return classifyInvoke({ ok: false, error });
    }
  }
}

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`comms: missing env ${k}`);
  return v;
}

/** Build the AWS ports from the env vars set by the stack (#0003). */
export function fromEnv(self: Endpoint, env: NodeJS.ProcessEnv = process.env): { queue: SqsQueuePort; wake: LambdaWakePort } {
  const urls = { doorman: need(env, "DOORMAN_QUEUE_URL"), prime: need(env, "PRIME_QUEUE_URL"), com: need(env, "COM_QUEUE_URL") };
  const names = {
    doorman: need(env, "DOORMAN_FUNCTION_NAME"),
    prime: need(env, "PRIME_FUNCTION_NAME"),
    com: need(env, "COM_FUNCTION_NAME"),
  };
  return { queue: new SqsQueuePort(urls, self), wake: new LambdaWakePort(names) };
}

/** The parts of a Lambda Invoke result or error the classifier looks at. */
export type InvokeOutcome =
  | { ok: true; StatusCode?: number; FunctionError?: string }
  | { ok: false; error: unknown };

/**
 * Classify a sync-wake Invoke (protocol §4.1):
 * abort → started (the target is starting and outlived our 2 s budget);
 * 429 / TooManyRequestsException → running; FunctionError → failed;
 * any other error → error; a normal fast return → started.
 */
export function classifyInvoke(o: InvokeOutcome): WakeResult {
  if (o.ok) {
    if (o.FunctionError) return { kind: "failed", detail: o.FunctionError };
    return { kind: "started", detail: `status ${o.StatusCode ?? "?"}` };
  }
  const e = (o.error ?? {}) as { name?: unknown; Reason?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return { kind: "started", detail: "aborted" };
  if (name === "TooManyRequestsException" || e.$metadata?.httpStatusCode === 429) {
    return { kind: "running", detail: typeof e.Reason === "string" ? e.Reason : "429" };
  }
  return { kind: "error", detail: name || (typeof e.message === "string" ? e.message : String(o.error)) };
}
