// S3 implementation of Prime's ObjectStore (spec §4). Lives in shared/ (Track A);
// Prime wires it in #0026. Type-only import keeps Track B code out of the bundle path.

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ObjectStore } from "../../prime/src/store.ts";

interface SdkError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}
const status = (e: unknown) => (e as SdkError)?.$metadata?.httpStatusCode;
const named = (e: unknown, name: string, code: number) => (e as SdkError)?.name === name || status(e) === code;

/** The one method of S3Client we use, so tests can pass a fake. */
export interface S3Like {
  send(cmd: unknown): Promise<unknown>;
}

export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly client: S3Like;
  constructor(bucket: string, client: S3Like = new S3Client({})) {
    this.bucket = bucket;
    this.client = client;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const r = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
    } catch (e) {
      if (named(e, "NoSuchKey", 404) || (e as SdkError)?.name === "NotFound") return null;
      throw e;
    }
  }

  async put(key: string, body: Uint8Array | string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
  }

  async putIfAbsent(key: string, body: Uint8Array | string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, IfNoneMatch: "*" }));
        return true;
      } catch (e) {
        if (named(e, "PreconditionFailed", 412)) return false;
        if (named(e, "ConditionalRequestConflict", 409)) continue; // concurrent write in flight: retry once
        throw e;
      }
    }
    return false;
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = (await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )) as { Contents?: { Key?: string }[]; IsTruncated?: boolean; NextContinuationToken?: string };
      for (const c of r.Contents ?? []) if (c.Key) keys.push(c.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
