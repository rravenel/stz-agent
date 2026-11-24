// Thin SDK adapters for Doorman and the env wiring.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { fromEnv as commsFromEnv, type InvokeOutcome } from "../../shared/src/aws-ports.ts";
import type { Deps, PrimeInvoker } from "./doorman.ts";
import type { LogStore } from "./events.ts";

export class S3LogStore implements LogStore {
  private readonly bucket: string;
  private readonly client: S3Client;
  constructor(bucket: string, client?: S3Client) {
    this.bucket = bucket;
    this.client = client ?? new S3Client({});
  }
  async list(o: { prefix: string; startAfter?: string; maxKeys: number }) {
    const r = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: o.prefix, StartAfter: o.startAfter, MaxKeys: o.maxKeys }),
    );
    return { keys: (r.Contents ?? []).flatMap((c) => (c.Key ? [c.Key] : [])), truncated: r.IsTruncated === true };
  }
  async getText(key: string): Promise<string> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return (await r.Body?.transformToString("utf8")) ?? "";
  }
}

export class LambdaPrimeInvoker implements PrimeInvoker {
  private readonly name: string;
  private readonly client: LambdaClient;
  constructor(name: string, client?: LambdaClient) {
    this.name = name;
    this.client = client ?? new LambdaClient({ maxAttempts: 1 });
  }
  async invoke(payload: object): Promise<InvokeOutcome> {
    try {
      const r = await this.client.send(
        new InvokeCommand({ FunctionName: this.name, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify(payload)) }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      return { ok: true, StatusCode: r.StatusCode, FunctionError: r.FunctionError };
    } catch (error) {
      return { ok: false, error };
    }
  }
}

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`doorman: missing env ${k}`);
  return v;
}

/** Load once, share the in-flight load; a failed load is retried next time. */
export function cachedSecret(load: () => Promise<string>): () => Promise<string> {
  let p: Promise<string> | null = null;
  return () =>
    (p ??= load().catch((e: unknown) => {
      p = null;
      throw e;
    }));
}

export async function loadTokenSecret(arn: string, client = new SecretsManagerClient({})): Promise<string> {
  const r = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error("API token secret is empty");
  return r.SecretString;
}

export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): Deps {
  const ports = commsFromEnv("doorman", env); // SDK clients are reused across requests
  const tokenArn = need(env, "API_TOKEN_SECRET_ARN");
  return {
    token: cachedSecret(() => loadTokenSecret(tokenArn)),
    comms: () => ports,
    prime: new LambdaPrimeInvoker(need(env, "PRIME_FUNCTION_NAME")),
    store: new S3LogStore(need(env, "BUCKET_NAME")),
    log: (o) => console.log(JSON.stringify(o)),
  };
}
