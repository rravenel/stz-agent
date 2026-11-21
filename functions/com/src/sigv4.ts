// SigV4 signing for Bedrock requests (spec §8, auth "bedrock").
// Credentials are Com's execution-role env vars, read per request.
// Never log the signed headers.

import { createHash, createHmac, type Hash, type Hmac } from "node:crypto";
import { SignatureV4 } from "@smithy/signature-v4";

/** The @smithy Checksum shape over node:crypto (HMAC when given a secret). No parameter properties: type stripping rejects them. */
type SourceData = string | ArrayBuffer | ArrayBufferView;
const toBuf = (d: SourceData) =>
  typeof d === "string" ? Buffer.from(d, "utf8") : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : Buffer.from(d);

export class NodeSha256 {
  private readonly secret: SourceData | undefined;
  private h: Hash | Hmac;
  constructor(secret?: SourceData) {
    this.secret = secret;
    this.h = this.fresh();
  }
  private fresh(): Hash | Hmac {
    return this.secret === undefined ? createHash("sha256") : createHmac("sha256", toBuf(this.secret));
  }
  update(data: SourceData): void {
    this.h.update(toBuf(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.h.digest());
  }
  reset(): void {
    this.h = this.fresh();
  }
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function credsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials {
  const accessKeyId = env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) throw new Error("bedrock auth: AWS credentials are not set in the environment");
  const c: Credentials = { accessKeyId, secretAccessKey };
  if (env["AWS_SESSION_TOKEN"]) c.sessionToken = env["AWS_SESSION_TOKEN"];
  return c;
}

/** bedrock-runtime.<region>.amazonaws.com or bedrock.<region>.amazonaws.com → region. */
export function regionFromBedrockUrl(url: string): string {
  const host = new URL(url).hostname;
  const m = /^bedrock(?:-runtime)?(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  if (!m) throw new Error(`bedrock auth: not a Bedrock host: ${host}`);
  return m[1]!;
}

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | null;
}

/** The headers to send: the request's own (lower-cased) plus host, x-amz-* and authorization. */
export async function signBedrock(req: SignInput, o: { credentials: Credentials; now?: Date }): Promise<Record<string, string>> {
  const u = new URL(req.url);
  const region = regionFromBedrockUrl(req.url);
  const headers: Record<string, string> = { host: u.host };
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of u.searchParams) {
    const prev = query[k];
    query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const signer = new SignatureV4({ service: "bedrock", region, credentials: o.credentials, sha256: NodeSha256 });
  const signed = await signer.sign(
    {
      method: req.method.toUpperCase(),
      protocol: u.protocol,
      hostname: u.hostname,
      ...(u.port ? { port: Number(u.port) } : {}),
      path: u.pathname,
      query,
      headers,
      ...(req.body !== undefined && req.body !== null ? { body: req.body } : {}),
    },
    o.now ? { signingDate: o.now } : {},
  );
  return signed.headers as Record<string, string>;
}

export interface Signer {
  sign(req: SignInput): Promise<Record<string, string>>;
}

export const defaultSigner: Signer = { sign: (req) => signBedrock(req, { credentials: credsFromEnv() }) };
