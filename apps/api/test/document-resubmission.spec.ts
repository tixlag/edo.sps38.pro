import { describe, expect, it, vi } from "vitest";
import { ManualDocumentService } from "../src/documents/manual-document.service";
import { DocumentReadService } from "../src/documents/document-read.service";
import type { DocumentStatus } from "@prisma/client";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { AuditService } from "../src/audit/audit.service";
import type { StorageService } from "../src/storage/storage.service";
import type { DocumentCatalogService } from "../src/documents/document-catalog.service";
import type { DocumentAccessService } from "../src/documents/document-access.service";
import type { StagedUpload } from "../src/documents/document-upload.service";

const uid = "6ffb1fd5-8341-11eb-ba8b-00259002db81";
const staged: StagedUpload = {
  directory: "unused",
  files: [
    {
      id: "file",
      filename: "photo.png",
      mimeType: "image/png",
      sizeBytes: 1,
      sha256: "test",
      pageCount: 1,
      path: "unused",
    },
  ],
  metadata: {
    documentUid: uid,
    chat_uuid: "00000000-0000-4000-8000-000000000001",
    position_code_1c: "001",
    citizenship: "ru",
    documentFields: {},
  },
};
function fixture(status: DocumentStatus) {
  const document = {
    id: "document",
    status,
    currentVersion: 1,
    candidateId: "owner",
  };
  let receipt: {
    id: string;
    status: string;
    fingerprint: string;
    versionId: string;
    version: {
      document: typeof document;
      documentId: string;
      version: number;
      status: DocumentStatus;
      files: Array<{ ordinal: number; storageKey: string }>;
    };
  } | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    candidate: {
      findMany: vi.fn(async () => [{ id: "owner" }]),
      findUniqueOrThrow: vi.fn(async () => ({
        id: "owner",
        chatUuid: staged.metadata!.chat_uuid,
        code1c: null,
        locationId: null,
      })),
    },
    document: {
      upsert: vi.fn(async () => document),
      updateMany: vi.fn(async () => {
        document.status = "IN_REVIEW";
        return { count: 1 };
      }),
    },
    documentVersion: {
      aggregate: vi.fn(async () => ({ _max: { version: 1 } })),
      create: vi.fn(async () => ({ id: "version", version: 2 })),
      update: vi.fn(async () => {
        if (receipt) receipt.version.status = "IN_REVIEW";
      }),
    },
    documentSubmission: {
      findUnique: vi.fn(
        async (args: {
          where: { identityKey_idempotencyKey: { idempotencyKey: string } };
        }) =>
          args.where.identityKey_idempotencyKey.idempotencyKey === "bundle"
            ? receipt
            : null,
      ),
      findFirst: vi.fn(async () =>
        receipt?.status === "UPLOADING" ? { id: receipt.id } : null,
      ),
      create: vi.fn(async (args: { data: { fingerprint: string } }) => {
        receipt = {
          id: "receipt",
          status: "UPLOADING",
          fingerprint: args.data.fingerprint,
          versionId: "version",
          version: {
            document,
            documentId: document.id,
            version: 2,
            status: "UPLOADED",
            files: [{ ordinal: 0, storageKey: "key" }],
          },
        };
        return receipt;
      }),
      updateMany: vi.fn(async () => {
        if (receipt) receipt.status = "SUCCEEDED";
        return { count: 1 };
      }),
    },
  };
  let transactions = Promise.resolve();
  const prisma = {
    documentSubmission: tx.documentSubmission,
    documentType: {
      findUnique: vi.fn(async () => ({
        id: "type",
        catalogSyncedAt: new Date(),
        allRu: true,
        allForeign: false,
        positions: [],
        definitions: [],
      })),
    },
    $transaction: vi.fn(<T>(apply: (value: typeof tx) => Promise<T>) => {
      const pending = transactions.then(() => apply(tx));
      transactions = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    }),
  };
  const storage = {
    upload: vi.fn(async () => undefined),
    keyFor: vi.fn(() => "key"),
  };
  const audit = { logInTransaction: vi.fn(async () => undefined) };
  const service = new ManualDocumentService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    audit as unknown as AuditService,
    {
      ensure: vi.fn(async () => undefined),
    } as unknown as DocumentCatalogService,
  );
  return { service, tx, storage };
}
describe("candidate document resubmission", () => {
  it("rejects a new bundle under review before reserving a version or writing to S3", async () => {
    const { service, tx, storage } = fixture("IN_REVIEW");
    await expect(service.upload(staged, "bundle", "")).rejects.toThrow(
      "DOCUMENT_IN_REVIEW",
    );
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("permits replacement after rejection and replays an identical key even after entering review", async () => {
    const { service, tx } = fixture("RETURNED");
    const result = await service.upload(staged, "bundle", "");
    expect(result).toMatchObject({ version: 2, status: "IN_REVIEW" });
    expect(await service.upload(staged, "bundle", "")).toEqual(result);
    expect(tx.documentVersion.create).toHaveBeenCalledTimes(1);
    await expect(service.upload(staged, "another-bundle", "")).rejects.toThrow(
      "DOCUMENT_IN_REVIEW",
    );
  });
  it("blocks a simultaneous new bundle while the first transfer is still uploading", async () => {
    const { service, tx, storage } = fixture("RETURNED");
    let complete!: () => void;
    storage.upload.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const first = service.upload(staged, "bundle", "");
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledTimes(1));
    await expect(service.upload(staged, "another-bundle", "")).rejects.toThrow(
      "DOCUMENT_UPLOAD_IN_PROGRESS",
    );
    expect(tx.documentVersion.create).toHaveBeenCalledTimes(1);
    complete();
    await first;
  });
});
describe("owner-scoped returned document fields", () => {
  const make = () => {
    const findFirst = vi.fn().mockResolvedValue({
      currentVersion: 2,
      versions: [
        {
          version: 1,
          fields: [{ name: "number", kind: "text", submittedValue: "old" }],
        },
        {
          version: 2,
          fields: [
            { name: "number", kind: "text", submittedValue: "000123" },
            { name: "isInvalid", kind: "boolean", submittedValue: "false" },
            { name: "issueDate", kind: "date", submittedValue: "2026-10-01" },
            { name: "comment", kind: "text", submittedValue: null },
          ],
        },
      ],
    });
    const service = new DocumentReadService(
      { document: { findFirst } } as unknown as PrismaService,
      {} as DocumentAccessService,
      {} as StorageService,
    );
    return { service, findFirst };
  };
  it("uses only the current returned version and preserves false, null, dates and leading zeros", async () => {
    const { service, findFirst } = make();
    expect(
      await service.internalDraft({ chat_uuid: "CHAT-OWNER" }, uid),
    ).toEqual({
      documentUid: uid,
      version: 2,
      fields: [
        { name: "number", value: "000123" },
        { name: "isInvalid", value: false },
        { name: "issueDate", value: "2026-10-01" },
        { name: "comment", value: null },
      ],
    });
    expect(findFirst.mock.calls[0][0].where).toEqual({
      candidate: { chatUuid: "chat-owner" },
      documentType: { erpUid: uid },
      status: "RETURNED",
      currentVersion: { gt: 0 },
    });
  });
  it("requires an owner and does not fall back to a historical rejected version", async () => {
    const { service, findFirst } = make();
    await expect(service.internalDraft({}, uid)).rejects.toThrow(
      "Document owner is required",
    );
    expect(findFirst).not.toHaveBeenCalled();
    findFirst.mockResolvedValue({
      currentVersion: 3,
      versions: [{ version: 2, fields: [] }],
    });
    await expect(
      service.internalDraft({ code_1c: "001" }, uid),
    ).rejects.toThrow("Returned document not found");
    findFirst.mockResolvedValue(null);
    await expect(
      service.internalDraft({ chat_uuid: "another-owner" }, uid),
    ).rejects.toThrow("Returned document not found");
  });
});
