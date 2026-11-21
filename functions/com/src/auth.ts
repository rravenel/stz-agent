// Auth headers for Com's outbound requests (spec §8). Keys come from the
// MODEL_SECRET_ARN secret, fetched once per run. Never log keys or headers.
//
// Secret JSON:
//   {"anthropic": "<key>",
//    "openai": {"https://api.openai.com/v1": "<key>", "<other base url>": "<key>"}}
// OpenAI-style keys are picked by the longest base-URL prefix of the request URL.

import type { HttpRequestBody } from "../../shared/src/envelope.ts";
import { defaultSigner, type Signer } from "./sigv4.ts";

export interface ModelSecret {
  anthropic?: string;
  openai?: Record<string, string>;
}

export interface SecretSource {
  get(): Promise<ModelSecret>;
}

/** Load once, share the promise; a failed load is retried next time. */
export function cachedSecrets(load: () => Promise<ModelSecret>): SecretSource {
  let p: Promise<ModelSecret> | null = null;
  return {
    get() {
      p ??= load().catch((e: unknown) => {
        p = null;
        throw e;
      });
      return p;
    },
  };
}

export function openaiKeyFor(url: string, keys: Record<string, string> = {}): string | null {
  let best: string | null = null;
  let len = -1;
  for (const [prefix, key] of Object.entries(keys)) {
    if (url.startsWith(prefix) && prefix.length > len) {
      best = key;
      len = prefix.length;
    }
  }
  return best;
}

export async function applyAuth(
  req: HttpRequestBody,
  secrets: SecretSource,
  body: string | Uint8Array | null = null,
  signer: Signer = defaultSigner,
): Promise<Record<string, string>> {
  const headers = { ...req.headers };
  switch (req.auth) {
    case "none":
    case "mock":
      return headers;
    case "anthropic": {
      const key = (await secrets.get()).anthropic;
      if (!key) throw new Error("no anthropic key in the model secret");
      headers["x-api-key"] = key;
      return headers;
    }
    case "openai": {
      const key = openaiKeyFor(req.url, (await secrets.get()).openai);
      if (!key) throw new Error("no openai key for this base URL in the model secret");
      headers["authorization"] = `Bearer ${key}`;
      return headers;
    }
    case "bedrock":
      // SigV4 over the exact body Com sends; credentials from the execution role.
      // The signer's headers alone: they hold every request header lower-cased, so
      // merging with `headers` would send e.g. Content-Type twice and break the signature.
      return signer.sign({ method: req.method, url: req.url, headers, body });
  }
}
