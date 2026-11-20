// Stub prime handler. Replaced by the real implementation (see issues/).

export interface WakeEvent {
  reason?: string;
}

export async function handler(event: WakeEvent = {}): Promise<{ stub: string; reason: string | null }> {
  return { stub: "prime", reason: event.reason ?? null };
}
