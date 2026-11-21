// Prime's Lambda entry point. The handler stays a stub until the real comms
// worker (#0005) and S3 store are wired in (#0008); the harness itself is
// createHandler (handler.ts), exported so the bundle carries it.

export { createHandler } from "./handler.ts";

export interface WakeEvent {
  reason?: string;
}

export async function handler(event: WakeEvent = {}): Promise<{ stub: string; reason: string | null }> {
  return { stub: "prime", reason: event.reason ?? null };
}
