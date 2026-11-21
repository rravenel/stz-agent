// The slice of S3 that Prime uses (spec §4), behind an interface so the
// harness runs against an in-memory fake in tests. The S3 implementation
// lands with the AWS SDK (see issues/0013.md, Prerequisites).

export interface ObjectStore {
  /** The object's bytes, or null if there is no such key. */
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array | string): Promise<void>;
  /** Create only if absent (S3 `If-None-Match: *`). Returns false if the key already exists. */
  putIfAbsent(key: string, body: Uint8Array | string): Promise<boolean>;
  /** Keys under a prefix, sorted. */
  list(prefix: string): Promise<string[]>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (b: Uint8Array | string) => (typeof b === "string" ? enc.encode(b) : new Uint8Array(b));

export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.objects.get(key);
    return v ? new Uint8Array(v) : null;
  }

  async put(key: string, body: Uint8Array | string): Promise<void> {
    this.objects.set(key, bytes(body));
  }

  async putIfAbsent(key: string, body: Uint8Array | string): Promise<boolean> {
    if (this.objects.has(key)) return false;
    this.objects.set(key, bytes(body));
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export async function getText(store: ObjectStore, key: string): Promise<string | null> {
  const b = await store.get(key);
  return b === null ? null : dec.decode(b);
}

export async function getJSON<T>(store: ObjectStore, key: string): Promise<T | null> {
  const s = await getText(store, key);
  return s === null ? null : (JSON.parse(s) as T);
}
