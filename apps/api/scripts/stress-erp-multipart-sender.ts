/** Fresh-process measurement used by stress-erp-multipart.ts; local endpoints only. */
import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { StorageService } from "../src/storage/storage.service";
import { sendErpMultipart } from "../src/documents/erp-multipart";
import { MAX_APPROVED_BYTES } from "../src/documents/approved-artifact";

async function main() {
  const [bucket, sha256, deliveryId, documentUid, destination] =
    process.argv.slice(2);
  if (
    !/^artifact-stress-\d+$/.test(bucket) ||
    !/^http:\/\/127\.0\.0\.1:\d+\/candidate-documents-v2$/.test(destination)
  )
    throw new Error("Local stress target required");
  const storage = new StorageService(
    new ConfigService({
      S3_ENDPOINT: "http://127.0.0.1:5001",
      S3_BUCKET: bucket,
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test",
    }),
  );
  let openStreams = 0;
  const originalOpen = storage.openRead.bind(storage);
  storage.openRead = async (...args) => {
    const body = await originalOpen(...args);
    openStreams++;
    body.once("close", () => openStreams--);
    return body;
  };
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss,
    peakExternal = baseline.external,
    peakHeap = baseline.heapUsed;
  const sample = () => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakExternal = Math.max(peakExternal, m.external);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  };
  const timer = setInterval(sample, 5),
    started = performance.now();
  try {
    const result = await sendErpMultipart({
      storage,
      artifact: {
        key: "approved.pdf",
        filename: "document.pdf",
        extension: "pdf",
        mimeType: "application/pdf",
        sizeBytes: MAX_APPROVED_BYTES,
        sha256,
      },
      metadata: {
        documentUid,
        chatUid: "10000000-0000-0000-0000-000000000001",
        documentFields: {},
      },
      deliveryId,
      url: new URL(destination),
      headers: { token: "test", Authorization: "Basic dGVzdDp0ZXN0" },
      signal: AbortSignal.timeout(60000),
    });
    sample();
    if (result.errorCode || openStreams)
      throw new Error("Stress transfer failed");
    process.stdout.write(
      JSON.stringify({
        node: process.version,
        fileSize: MAX_APPROVED_BYTES,
        fileSha256: sha256,
        elapsedMs: Math.round(performance.now() - started),
        baselineRss: baseline.rss,
        peakRss,
        rssDelta: peakRss - baseline.rss,
        baselineExternal: baseline.external,
        peakExternal,
        baselineHeap: baseline.heapUsed,
        peakHeap,
        openStreamsAfter: openStreams,
        errorCode: result.errorCode,
      }) + "\n",
    );
  } finally {
    clearInterval(timer);
    storage.onModuleDestroy();
  }
}
void main();
