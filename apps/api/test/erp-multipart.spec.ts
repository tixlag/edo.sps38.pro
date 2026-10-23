import "reflect-metadata";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createDocumentMultipart,
  sendErpMultipart,
  validateErpReceipt,
  nextDeliveryAttempt,
} from "../src/documents/erp-multipart";
import { MAX_APPROVED_BYTES } from "../src/documents/approved-artifact";

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0, 0x41, 0x42, 0, 0xff, 0xd9]);
const artifact = {
  key: "approved.jpg",
  filename: "document.jpg",
  extension: "jpg",
  mimeType: "image/jpeg",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const metadata = {
  documentUid: randomUUID(),
  chatUid: randomUUID(),
  documentFields: {
    number: "0001",
    issueDate: "2020-01-15",
    isIdentityDocument: false,
  },
};
const deliveryId = "delivery-permanent-id";
const receipt = {
  success: true,
  receiptId: randomUUID(),
  deliveryId,
  duplicate: false,
  candidateUid: randomUUID(),
  documentUid: metadata.documentUid,
  fileUid: randomUUID(),
  period: "2026-10-22",
  fileName: artifact.filename,
  mimeType: artifact.mimeType,
  fileSha256: artifact.sha256,
  fileSize: artifact.sizeBytes,
};
let server: Server, url: URL;
let action = "valid",
  status = 201;
let received: {
  headers: Record<string, unknown>;
  metadata: unknown;
  bytes: Buffer;
  filename: string;
  mimeType: string;
  length: number;
}[] = [];
let streams: Readable[] = [];
const storage = {
  read: vi.fn(() => {
    throw new Error("Buffer reads forbidden");
  }),
  openRead: vi.fn(async () => {
    const stream = Readable.from(
      (async function* () {
        for (const byte of bytes) yield Buffer.from([byte]);
      })(),
      { objectMode: false },
    );
    streams.push(stream);
    return stream;
  }),
};
function send(signal = AbortSignal.timeout(5000)) {
  return sendErpMultipart({
    storage: storage as never,
    artifact,
    metadata,
    deliveryId,
    url,
    headers: { token: "private-token", Authorization: "Basic private-basic" },
    signal,
  });
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      if (action === "early") {
        res.writeHead(401);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const form = await new Response(body, {
        headers: { "content-type": String(req.headers["content-type"]) },
      }).formData();
      expect([...form.keys()]).toEqual(["metadata", "file"]);
      const file = form.get("file") as File;
      received.push({
        headers: req.headers,
        metadata: JSON.parse(String(form.get("metadata"))),
        bytes: Buffer.from(await file.arrayBuffer()),
        filename: file.name,
        mimeType: file.type,
        length: body.length,
      });
      if (action === "lost") {
        res.destroy();
        return;
      }
      if (action === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>proxy</html>");
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          action === "false"
            ? { success: false, description: "PERSONAL INFORMATION" }
            : action === "storage"
              ? { success: false, code: "FILE_STORAGE_NOT_CONFIGURED" }
              : {
                  ...receipt,
                  duplicate: status === 200,
                  description: "PERSONAL INFORMATION",
                  token: "private-token",
                },
        ),
      );
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = new URL(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/candidate-documents-v2`,
  );
});
afterEach(() => {
  action = "valid";
  status = 201;
  received = [];
  streams = [];
  vi.restoreAllMocks();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("binary multipart HTTP", () => {
  it("sends exact binary, metadata, MIME, length and hash, never buffers/Base64", async () => {
    const result = await send();
    expect(result.errorCode).toBeNull();
    expect(received[0]).toMatchObject({
      metadata,
      bytes,
      filename: "document.jpg",
      mimeType: "image/jpeg",
    });
    expect(received[0].headers).toMatchObject({
      "idempotency-key": deliveryId,
      "x-file-sha256": artifact.sha256,
      "x-file-size": String(bytes.length),
      accept: "application/json",
    });
    expect(Number(received[0].headers["content-length"])).toBe(
      received[0].length,
    );
    expect(received[0].headers["transfer-encoding"]).toBeUndefined();
    expect(storage.read).not.toHaveBeenCalled();
    expect(streams.every((s) => s.destroyed)).toBe(true);
    expect(result.diagnostic.responseBody).not.toContain(
      "PERSONAL INFORMATION",
    );
    expect(result.diagnostic.responseBody).not.toContain("private-token");
    expect(JSON.parse(result.diagnostic.responseBody)).toMatchObject({
      receiptId: receipt.receiptId,
      duplicate: false,
    });
  });
  it("accepts the same receipt after a committed response is lost; keeps the delivery key", async () => {
    action = "lost";
    await expect(send()).rejects.toThrow();
    action = "valid";
    status = 200;
    const result = await send();
    expect(result.errorCode).toBeNull();
    expect(received).toHaveLength(2);
    expect(received.map((r) => r.headers["idempotency-key"])).toEqual([
      deliveryId,
      deliveryId,
    ]);
    expect(received[0].bytes).toEqual(received[1].bytes);
    expect(received[0].metadata).toEqual(received[1].metadata);
  });
  it.each(["html", "false"])("rejects a 200 %s reply", async (mode) => {
    action = mode;
    status = 200;
    const result = await send();
    expect(result.errorCode).toBe("ERP_RECEIPT_INVALID");
    expect(result.retryable).toBe(false);
  });
  it.each([408, 429, 500, 502, 503, 504])(
    "schedules transient HTTP %i for a bounded retry",
    async (code) => {
      status = code;
      const result = await send();
      expect(result.errorCode).toBe(`ERP_HTTP_${code}`);
      expect(result.retryable).toBe(true);
    },
  );
  it.each([400, 401, 403, 404, 409, 413, 415, 422])(
    "does not retry business/auth HTTP %i",
    async (code) => {
      status = code;
      expect((await send()).retryable).toBe(false);
    },
  );
  it("does not retry a missing 1C disk storage configuration", async () => {
    status = 503;
    action = "storage";
    expect((await send()).retryable).toBe(false);
  });
  it("closes S3 and multipart if the server rejects before consumption", async () => {
    action = "early";
    expect((await send()).errorCode).toBe("ERP_HTTP_401");
    expect(streams.every((s) => s.destroyed)).toBe(true);
  });
  it("closes stalled input on timeout", async () => {
    let source: Readable | undefined;
    vi.spyOn(storage, "openRead").mockImplementationOnce(
      async (_key?: unknown) => {
        source = new Readable({ read() {} });
        return source;
      },
    );
    await expect(send(AbortSignal.timeout(60))).rejects.toThrow();
    expect(source?.destroyed).toBe(true);
  });
  it("detects S3 truncation and mismatching bytes before the terminating boundary", async () => {
    for (const data of [
      Buffer.from([1]),
      Buffer.alloc(bytes.length, 2),
      Buffer.alloc(bytes.length + 1, 3),
    ]) {
      const source = Readable.from([data]);
      const multipart = createDocumentMultipart(
        source,
        metadata,
        artifact,
        AbortSignal.timeout(2000),
      );
      const parts: Buffer[] = [];
      await expect(
        (async () => {
          for await (const part of multipart.body) parts.push(part);
        })(),
      ).rejects.toThrow("MISMATCH");
      expect(source.destroyed).toBe(true);
      expect(multipart.verified()).toBe(false);
      expect(
        Buffer.concat(parts).includes(Buffer.from(`--${multipart.boundary}--`)),
      ).toBe(false);
    }
  });
  it("propagates a mid-stream S3 failure and closes input", async () => {
    const source = Readable.from(
      (async function* () {
        yield bytes.subarray(0, 2);
        throw new Error("S3 disconnected");
      })(),
    );
    const m = createDocumentMultipart(
      source,
      metadata,
      artifact,
      AbortSignal.timeout(2000),
    );
    await expect(
      (async () => {
        for await (const chunk of m.body) {
          expect(chunk.length).toBeGreaterThan(0);
        }
      })(),
    ).rejects.toThrow("disconnected");
    expect(source.destroyed).toBe(true);
  });
  it("enforces limits, including exact 100 MiB acceptance without allocating the file", () => {
    const source = new Readable({ read() {} });
    expect(() =>
      createDocumentMultipart(
        source,
        metadata,
        { ...artifact, sizeBytes: MAX_APPROVED_BYTES + 1 },
        AbortSignal.timeout(1000),
      ),
    ).toThrow();
    const m = createDocumentMultipart(
      source,
      metadata,
      { ...artifact, sizeBytes: MAX_APPROVED_BYTES },
      AbortSignal.timeout(1000),
    );
    expect(m.contentLength).toBeGreaterThan(MAX_APPROVED_BYTES);
    m.body.destroy();
    source.destroy();
    expect(() =>
      createDocumentMultipart(
        Readable.from([]),
        { text: "x".repeat(262144) },
        artifact,
        AbortSignal.timeout(1000),
      ),
    ).toThrow("METADATA");
  });
});

describe("receipt identity", () => {
  it.each([
    "receiptId",
    "deliveryId",
    "documentUid",
    "candidateUid",
    "fileUid",
    "mimeType",
    "fileSha256",
    "fileSize",
    "period",
    "fileName",
    "duplicate",
    "success",
  ])("rejects inconsistent %s", (field) => {
    expect(
      validateErpReceipt(
        { ...receipt, [field]: field === "fileSize" ? 1 : "wrong" },
        201,
        deliveryId,
        metadata.documentUid,
        artifact,
      ),
    ).toBe(false);
  });
  it("accepts a candidate UID different from chatUid", () => {
    expect(receipt.candidateUid).not.toBe(metadata.chatUid);
    expect(
      validateErpReceipt(
        receipt,
        201,
        deliveryId,
        metadata.documentUid,
        artifact,
      ),
    ).toBe(true);
  });
  it("uses exponential backoff with bounded jitter", () => {
    expect(nextDeliveryAttempt(1, 0, () => 0).getTime()).toBe(15000);
    expect(nextDeliveryAttempt(2, 0, () => 1).getTime()).toBe(60000);
    expect(nextDeliveryAttempt(100, 0, () => 1).getTime()).toBe(3600000);
  });
});
