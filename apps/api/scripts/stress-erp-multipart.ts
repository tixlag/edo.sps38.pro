/** Local-only 100 MiB sender measurement. Does not load root .env. */
import "reflect-metadata";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ConfigService } from "@nestjs/config";
import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { StorageService } from "../src/storage/storage.service";
import {
  hashArtifact,
  MAX_APPROVED_BYTES,
} from "../src/documents/approved-artifact";

async function main() {
  const endpoint = process.env.EDO_TEST_S3_ENDPOINT;
  if (endpoint !== "http://127.0.0.1:5001")
    throw new Error("Disposable S3 at 127.0.0.1:5001 required");
  const directory = join(
    __dirname,
    "../../../.cache/approved-artifacts/stress",
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, "document.pdf"),
    received = join(directory, "multipart.bin");
  const output = createWriteStream(path);
  let size = 0;
  const hash = createHash("sha256");
  async function write(data: Buffer) {
    hash.update(data);
    size += data.length;
    if (!output.write(data)) await once(output, "drain");
  }
  // A valid one-page PDF with a large comment stream, xref offsets computed exactly.
  const offsets = [0];
  await write(Buffer.from("%PDF-1.7\n"));
  const object = async (n: number, text: string) => {
    offsets[n] = size;
    await write(Buffer.from(`${n} 0 obj\n${text}\nendobj\n`));
  };
  await object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  await object(2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>");
  await object(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
  );
  // Reserve 1 KiB for object headers, xref and trailer, then pad after EOF.
  const streamLength = MAX_APPROVED_BYTES - size - 1024;
  offsets[4] = size;
  await write(Buffer.from(`4 0 obj\n<< /Length ${streamLength} >>\nstream\n`));
  const block = Buffer.from(`%${" ".repeat(65534)}\n`);
  let remaining = streamLength;
  while (remaining) {
    const data = block.subarray(0, Math.min(remaining, block.length));
    await write(data);
    remaining -= data.length;
  }
  await write(Buffer.from("\nendstream\nendobj\n"));
  const xref = size;
  await write(
    Buffer.from(
      `xref\n0 5\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  await write(Buffer.alloc(MAX_APPROVED_BYTES - size, 32));
  output.end();
  await once(output, "close");
  const sha256 = hash.digest("hex");
  const bucket = `artifact-stress-${Date.now()}`;
  const s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const storage = new StorageService(
    new ConfigService({
      S3_ENDPOINT: endpoint,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test",
    }),
  );
  const deliveryId = randomUUID(),
    documentUid = randomUUID();
  let actualSize = 0,
    actualSha = "";
  const server = createServer(async (req, res) => {
    try {
      await pipeline(req, createWriteStream(received));
      const fd = await open(received, "r");
      const prefix = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(prefix, 0, prefix.length, 0);
      await fd.close();
      const header = prefix.subarray(0, bytesRead);
      const fileHeader = header.indexOf(Buffer.from('name="file";'));
      const start = header.indexOf(Buffer.from("\r\n\r\n"), fileHeader) + 4;
      const digest = await hashArtifact(
        createReadStream(received, {
          start,
          end: start + MAX_APPROVED_BYTES - 1,
        }),
      );
      actualSize = digest.sizeBytes;
      actualSha = digest.sha256;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          receiptId: randomUUID(),
          deliveryId,
          duplicate: false,
          candidateUid: randomUUID(),
          documentUid,
          fileUid: randomUUID(),
          period: "2026-10-22",
          fileName: "document.pdf",
          mimeType: "application/pdf",
          fileSha256: actualSha,
          fileSize: actualSize,
        }),
      );
    } catch {
      res.destroy();
    }
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await storage.upload(
      "approved.pdf",
      path,
      "application/pdf",
      MAX_APPROVED_BYTES,
      AbortSignal.timeout(60000),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const sender = spawn(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        join(__dirname, "stress-erp-multipart-sender.ts"),
        bucket,
        sha256,
        deliveryId,
        documentUid,
        `http://127.0.0.1:${(server.address() as { port: number }).port}/candidate-documents-v2`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let result = "",
      errors = "";
    sender.stdout.on("data", (chunk) => {
      result += chunk.toString();
    });
    sender.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const [code] = await once(sender, "close");
    if (code !== 0) throw new Error(`Local sender failed: ${errors}`);
    if (actualSha !== sha256 || actualSize !== MAX_APPROVED_BYTES)
      throw new Error("Receiver mismatch");
    const measurement = JSON.parse(result);
    await writeFile(
      join(directory, "measurement.json"),
      JSON.stringify(measurement, null, 2),
    );
    process.stdout.write(JSON.stringify(measurement, null, 2) + "\n");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: "approved.pdf" }),
    );
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
    storage.onModuleDestroy();
  }
}
void main();
