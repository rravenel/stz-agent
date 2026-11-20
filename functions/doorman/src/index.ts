// Stub doorman handler. Replaced by the real implementation (see issues/).

export interface WakeEvent {
  reason?: string;
}

export async function handler(event: WakeEvent = {}): Promise<{ stub: string; reason: string | null }> {
  return { stub: "doorman", reason: event.reason ?? null };
}
