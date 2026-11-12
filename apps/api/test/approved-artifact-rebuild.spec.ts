import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { ConfigService } from "@nestjs/config";
import { DocumentPdfService } from "../src/documents/document-pdf.service";
import { erpDeliveryErrorCode } from "../src/documents/erp-multipart";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function jpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 4, g: 5, b: 6 } },
  })
    .jpeg()
    .toBuffer();
}

function fixture(bytes: Buffer, options: { approved?: boolean } = {}) {
  const objects = new Map<string, Buffer>([["original", bytes]]);
  const row = {
    id: "v",
    documentId: "doc",
    version: 1,
    status: "APPROVED",
    revision: 3,
    pendingApprovalStorageKey: null as string | null,
    approvedStorageKey: (options.approved ? "doc/v1/approved-old.jpg" : null) as
      | string
      | null,
    files: [
      {
        storageKey: "original",
        mimeType: "image/jpeg",
        sizeBytes: bytes.length,
        sha256: hash(bytes),
        pageCount: 1,
      },
    ],
  };
  if (row.approvedStorageKey)
    objects.set(row.approvedStorageKey, Buffer.from(bytes));
  const storage = {
    keyFor: (_id: string, _v: number, name: string) => `doc/v1/${name}`,
    read: vi.fn(async (key: string) => objects.get(key)!),
    openRead: vi.fn(async (key: string) => Readable.from([objects.get(key)!])),
    copy: vi.fn(async (from: string, to: string) => {
      objects.set(to, Buffer.from(objects.get(from)!));
    }),
    uploadBuffer: vi.fn(async (key: string, data: Buffer) => {
      objects.set(key, data);
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  const tx = {
    $queryRaw: vi.fn(),
    documentVersion: {
      findUniqueOrThrow: vi.fn(async () => row),
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.approvedStorageKey !== undefined &&
          row.approvedStorageKey !== where.approvedStorageKey
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    documentVersionFile: { findFirst: vi.fn(async () => null) },
  };
  const prisma = {
    ...tx,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
  const service = new DocumentPdfService(
    prisma as never,
    storage as never,
    new ConfigService({ ERP_DOCUMENTS_TRANSPORT: "multipart-v2" }),
  );
  return { service, row, storage, objects, tx };
}

describe("approved artifact rebuild", () => {
  it("rebuilds the artifact of a single JPEG with a removable trailer", async () => {
    const bytes = await jpeg();
    const original = Buffer.concat([bytes, Buffer.alloc(1208)]);
    const f = fixture(original, { approved: true });
    const artifact = await f.service.reprepareCanonical("v");
    expect(artifact).not.toBeNull();
    expect(artifact).toMatchObject({
      mimeType: "image/jpeg",
      extension: "jpg",
      sizeBytes: bytes.length,
      sha256: hash(bytes),
      preparation: "original-copy-v3-trimmed",
    });
    // The new artifact holds the canonical bytes...
    expect(f.objects.get(artifact!.key)!.equals(bytes)).toBe(true);
    // ...the replaced artifact is removed only after the row points to the new one
    expect(f.row.approvedStorageKey).toBe(artifact!.key);
    expect(f.row.approvedSha256).toBe(hash(bytes));
    expect(f.storage.delete).toHaveBeenCalledWith("doc/v1/approved-old.jpg");
    // The original upload is never touched
    expect(f.objects.get("original")!.equals(original)).toBe(true);
  });

  it("keeps the artifact of a clean JPEG", async () => {
    const bytes = await jpeg();
    const f = fixture(bytes, { approved: true });
    expect(await f.service.reprepareCanonical("v")).toBeNull();
    expect(f.row.approvedStorageKey).toBe("doc/v1/approved-old.jpg");
    expect(f.storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it("refuses to rebuild when the source does not match its stored hash", async () => {
    const bytes = await jpeg();
    const f = fixture(Buffer.concat([bytes, Buffer.alloc(1208)]), {
      approved: true,
    });
    f.row.files[0].sha256 = hash(Buffer.from("other"));
    await expect(f.service.reprepareCanonical("v")).rejects.toThrow(
      "APPROVED_ARTIFACT_MISMATCH",
    );
    expect(f.storage.uploadBuffer).not.toHaveBeenCalled();
  });
});

describe("ERP delivery error codes", () => {
  it("maps the 1C answer codes to stable EDO codes", () => {
    expect(erpDeliveryErrorCode(422, "INVALID_FILE_CONTENT")).toBe(
      "ERP_INVALID_FILE_CONTENT",
    );
    expect(erpDeliveryErrorCode(409, "DOCUMENT_ALREADY_EXISTS")).toBe(
      "ERP_DOCUMENT_ALREADY_EXISTS",
    );
    expect(erpDeliveryErrorCode(400, "INVALID_METADATA")).toBe(
      "ERP_INVALID_METADATA",
    );
    expect(erpDeliveryErrorCode(503, "DELIVERY_BUSY")).toBe("ERP_HTTP_503");
    expect(erpDeliveryErrorCode(422, undefined)).toBe("ERP_HTTP_422");
    expect(erpDeliveryErrorCode(422, "SOMETHING_ELSE")).toBe("ERP_HTTP_422");
  });
});
