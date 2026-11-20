// Stub com handler. Replaced by the real implementation (see issues/).

export interface WakeEvent {
  reason?: string;
}

export async function handler(event: WakeEvent = {}): Promise<{ stub: string; reason: string | null }> {
  return { stub: "com", reason: event.reason ?? null };
}
