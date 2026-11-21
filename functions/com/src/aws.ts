// Thin SDK adapters for Com: S3 (streamed upload) and Secrets Manager.

import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { ComStore } from "./com.ts";
import type { ModelSecret } from "./auth.ts";

export class S3Store implements ComStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(bucket: string, client: S3Client = new S3Client({})) {
    this.bucket = bucket;
    this.client = client;
  }

  async getText(key: string): Promise<string | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (await r.Body?.transformToString()) ?? "";
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
  }

  async getJSONOrNull<T>(key: string): Promise<T | null> {
    const s = await this.getText(key);
    return s === null ? null : (JSON.parse(s) as T);
  }

  async putStream(key: string, body: ReadableStream<Uint8Array>, contentType?: string): Promise<void> {
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
        ...(contentType ? { ContentType: contentType } : {}),
      },
    }).done();
  }
}

export async function loadModelSecret(arn: string, client = new SecretsManagerClient({})): Promise<ModelSecret> {
  const r = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(r.SecretString ?? "{}") as ModelSecret;
}
