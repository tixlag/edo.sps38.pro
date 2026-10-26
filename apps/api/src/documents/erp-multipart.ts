import { createHash, randomUUID } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import { z } from "zod";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import type { EventEmitter } from "node:events";
import type { StorageService } from "../storage/storage.service";
import {
  assertArtifact,
  MAX_APPROVED_BYTES,
  type ApprovedArtifact,
} from "./approved-artifact";
import {
  captureErpDeliveryResponse,
  type ErpDeliveryResponse,
} from "./erp-delivery-response";

export type DeliveryArtifact = Pick<
  ApprovedArtifact,
  "key" | "mimeType" | "extension" | "filename" | "sizeBytes" | "sha256"
>;
export function createDocumentMultipart(
  source: Readable,
  metadata: object,
  artifact: DeliveryArtifact,
  signal: AbortSignal,
) {
  assertArtifact(artifact);
  const json = Buffer.from(JSON.stringify(metadata));
  if (!json.length || json.length > 262144)
    throw new Error("ERP_METADATA_TOO_LARGE");
  const boundary = `EDO-${randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${json.toString("utf8")}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${artifact.filename}"\r\nContent-Type: ${artifact.mimeType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = prefix.length + artifact.sizeBytes + suffix.length;
  if (contentLength > 105136128) throw new Error("ERP_MULTIPART_TOO_LARGE");
  let verified = false;
  const body = Readable.from(
    (async function* () {
      try {
        yield prefix;
        let length = 0;
        const hash = createHash("sha256");
        const delimiter = Buffer.from(`\r\n--${boundary}`);
        let tail = Buffer.alloc(0);
        for await (const chunk of source as AsyncIterable<Buffer>) {
          signal.throwIfAborted();
          length += chunk.length;
          if (length > artifact.sizeBytes || length > MAX_APPROVED_BYTES)
            throw new Error("APPROVED_ARTIFACT_MISMATCH");
          const seam = Buffer.concat([
            tail,
            chunk.subarray(0, delimiter.length),
          ]);
          if (chunk.includes(delimiter) || seam.includes(delimiter))
            throw new Error("ERP_MULTIPART_BOUNDARY_COLLISION");
          // Copy only a few delimiter bytes; do not retain/copy whole S3 chunks.
          tail = Buffer.from(
            chunk.length >= delimiter.length
              ? chunk.subarray(chunk.length - delimiter.length)
              : seam.subarray(Math.max(0, seam.length - delimiter.length)),
          );
          hash.update(chunk);
          yield chunk;
        }
        if (
          length !== artifact.sizeBytes ||
          hash.digest("hex") !== artifact.sha256
        )
          throw new Error("APPROVED_ARTIFACT_MISMATCH");
        verified = true;
        yield suffix;
      } finally {
        source.destroy();
      }
    })(),
    { objectMode: false, highWaterMark: 64 * 1024 },
  );
  // Also close S3 when a peer rejects before pulling any request bytes.
  (body as EventEmitter).once("close", () => source.destroy());
  (source as EventEmitter).on("error", (error: Error) => body.destroy(error));
  addAbortSignal(signal, source);
  addAbortSignal(signal, body);
  return { body, contentLength, boundary, verified: () => verified };
}

const uuid = z
  .string()
  .uuid()
  .refine((v) => v !== "00000000-0000-0000-0000-000000000000");
const receiptSchema = z.object({
  success: z.literal(true),
  receiptId: uuid,
  deliveryId: z.string(),
  duplicate: z.boolean(),
  candidateUid: uuid.nullable(),
  chatUid: uuid.nullish(),
  recipientType: z.enum(["candidate", "person"]).optional(),
  personUid: uuid.nullish(),
  documentUid: uuid,
  fileUid: uuid,
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => {
      const date = new Date(`${v}T00:00:00Z`);
      return (
        Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v
      );
    }),
  fileName: z.string(),
  mimeType: z.string(),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileSize: z.number().int().positive().max(MAX_APPROVED_BYTES),
});
export function validateErpReceipt(
  value: unknown,
  status: number,
  deliveryId: string,
  documentUid: string,
  artifact: DeliveryArtifact,
  recipient?: ErpDocumentRecipient,
): boolean {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success || ![200, 201].includes(status)) return false;
  const r = parsed.data;
  const recipientMatches = !recipient
    ? !!r.candidateUid
    : recipient.recipientType === "person"
      ? r.recipientType === "person" &&
        r.personUid === recipient.personUid &&
        r.candidateUid === null &&
        r.chatUid === null
      : r.recipientType !== "person" &&
        !r.personUid &&
        !!r.candidateUid &&
        (!recipient.candidateUid ||
          r.candidateUid === recipient.candidateUid) &&
        (!recipient.chatUid || !r.chatUid || r.chatUid === recipient.chatUid);
  return (
    recipientMatches &&
    r.deliveryId === deliveryId &&
    r.documentUid.toLowerCase() === documentUid.toLowerCase() &&
    r.fileSha256 === artifact.sha256 &&
    r.fileSize === artifact.sizeBytes &&
    r.mimeType === artifact.mimeType &&
    r.fileName === artifact.filename &&
    r.duplicate === (status === 200)
  );
}

export type ErpDocumentRecipient = {
  recipientType?: "candidate" | "person";
  candidateUid?: string;
  chatUid?: string;
  personUid?: string;
  code1c?: string;
};

export async function sendErpMultipart(options: {
  storage: StorageService;
  artifact: DeliveryArtifact;
  metadata: ErpDocumentRecipient & {
    documentUid: string;
    documentFields: object;
  };
  deliveryId: string;
  url: URL;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<{
  diagnostic: ErpDeliveryResponse;
  errorCode: string | null;
  retryable: boolean;
}> {
  const { artifact, metadata, signal } = options;
  assertArtifact(artifact);
  const source = await options.storage.openRead(artifact.key, signal);
  let multipart: ReturnType<typeof createDocumentMultipart> | undefined;
  try {
    multipart = createDocumentMultipart(source, metadata, artifact, signal);
    if (
      !["http:", "https:"].includes(options.url.protocol) ||
      options.url.username ||
      options.url.password
    )
      throw new Error("ERP_NOT_CONFIGURED");
    const request = (
      options.url.protocol === "https:" ? httpsRequest : httpRequest
    )(options.url, {
      method: "POST",
      signal,
      headers: {
        ...options.headers,
        Accept: "application/json",
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "Content-Length": String(multipart.contentLength),
        "Idempotency-Key": options.deliveryId,
        "X-File-SHA256": artifact.sha256,
        "X-File-Size": String(artifact.sizeBytes),
      },
    });
    // Node HTTP avoids fetch's replay handling of streaming 401 responses.
    // No redirects, buffering, chunked encoding or implicit transport retries.
    const incoming = new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
      },
    );
    let uploadError: unknown;
    const uploading = pipeline(multipart.body, request).catch(
      (error: unknown) => {
        uploadError = error;
      },
    );
    let message: import("node:http").IncomingMessage;
    try {
      message = await incoming;
    } catch (error) {
      request.destroy();
      await uploading;
      throw uploadError ?? error;
    }
    const response = new Response(
      [204, 304].includes(message.statusCode!)
        ? null
        : (Readable.toWeb(message) as never),
      {
        status: message.statusCode!,
        headers: {
          "content-type": String(message.headers["content-type"] ?? ""),
        },
      },
    );
    let value: unknown;
    const diagnostic = await captureErpDeliveryResponse(
      response,
      Object.values(options.headers),
      (raw) => {
        try {
          value = JSON.parse(raw);
        } catch {
          value = null;
        }
      },
    );
    if (![200, 201].includes(response.status)) multipart.body.destroy();
    await uploading;
    const input =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    // Allowlist only; never retain response descriptions, echoed metadata or PII.
    const code =
      typeof input.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code)
        ? input.code
        : undefined;
    const receiptId = uuid.safeParse(input.receiptId).success
      ? input.receiptId
      : undefined;
    const valid =
      !uploadError &&
      !diagnostic.responseTruncated &&
      !diagnostic.responseReadError &&
      multipart.verified() &&
      validateErpReceipt(
        value,
        response.status,
        options.deliveryId,
        metadata.documentUid,
        artifact,
        metadata,
      );
    diagnostic.responseBody = JSON.stringify({
      success: input.success === true,
      receiptId,
      duplicate:
        typeof input.duplicate === "boolean" ? input.duplicate : undefined,
      code,
    });
    const retryable =
      [408, 429, 500, 502, 503, 504].includes(response.status) &&
      code !== "FILE_STORAGE_NOT_CONFIGURED";
    return {
      diagnostic,
      errorCode: valid
        ? null
        : [200, 201].includes(response.status)
          ? "ERP_RECEIPT_INVALID"
          : `ERP_HTTP_${response.status}`,
      retryable,
    };
  } finally {
    multipart?.body.destroy();
    source.destroy();
  }
}

export const MAX_DELIVERY_ATTEMPTS = 5;
export function nextDeliveryAttempt(
  attemptCount: number,
  now = Date.now(),
  random = Math.random,
): Date {
  const delay = Math.min(
    3600000,
    30000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 7),
  );
  return new Date(now + Math.round(delay * (0.5 + random() * 0.5)));
}
