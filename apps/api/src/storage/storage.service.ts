import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

/** Private original files. Bucket provisioning and public access policy are operator-owned. */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private client?: S3Client;
  constructor(private readonly config: ConfigService) {}

  bucket(): string {
    return this.config.get<string>("S3_BUCKET") ?? "edo-documents";
  }
  endpoint(): string {
    return this.config.get<string>("S3_ENDPOINT") ?? "http://localhost:9000";
  }

  private s3(): S3Client {
    return (this.client ??= new S3Client({
      endpoint: this.endpoint(),
      region: this.config.get<string>("S3_REGION") ?? "us-east-1",
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: {
        accessKeyId: this.config.get<string>("S3_ACCESS_KEY") ?? "",
        secretAccessKey: this.config.get<string>("S3_SECRET_KEY") ?? "",
      },
    }));
  }

  keyFor(documentId: string, version: number, filename: string): string {
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return `documents/${documentId}/v${version}/${safe}`;
  }

  async upload(
    key: string,
    path: string,
    mimeType: string,
    sizeBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const body = createReadStream(path);
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: key,
          Body: body,
          ContentType: mimeType,
          ContentLength: sizeBytes,
        }),
        { abortSignal: signal },
      );
    } finally {
      body.destroy();
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3().send(
      new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }),
      {
        abortSignal: AbortSignal.timeout(15_000),
      },
    );
  }

  async read(key: string, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
    const response = await this.s3().send(new GetObjectCommand({ Bucket: this.bucket(), Key: key }), { abortSignal: AbortSignal.timeout(30000) });
    const body = response.Body as Readable | undefined;
    if (!body || (response.ContentLength ?? 0) > maxBytes) { body?.destroy(); throw new Error("S3_OBJECT_TOO_LARGE"); }
    const chunks: Buffer[] = []; let length = 0;
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > maxBytes) throw new Error("S3_OBJECT_TOO_LARGE");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally { body.destroy(); }
  }
  async uploadBuffer(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: bytes, ContentType: mimeType, ContentLength: bytes.length }), { abortSignal: AbortSignal.timeout(120000) });
  }

  async downloadUrl(
    key: string,
    filename: string,
    expiresIn = 300,
  ): Promise<string> {
    // Do not interpolate untrusted names into response headers.
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "document";
    return getSignedUrl(
      this.s3(),
      new GetObjectCommand({
        Bucket: this.bucket(),
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safe}"`,
      }),
      { expiresIn },
    );
  }

  onModuleDestroy(): void {
    this.client?.destroy();
  }
}
