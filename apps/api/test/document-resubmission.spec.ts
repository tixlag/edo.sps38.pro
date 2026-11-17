import { describe, expect, it, vi } from "vitest";
import { ManualDocumentService } from "../src/documents/manual-document.service";
import { CandidateDocumentError } from "../src/documents/candidate-document.error";
import { HttpErrorFilter } from "../src/common/http-error.filter";
import type { ArgumentsHost } from "@nestjs/common";
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
function fixture(
  status: DocumentStatus,
  externalOcr = false,
  existingPages: number[] = [],
) {
  const document = {
    id: "document",
    status,
    currentVersion: 1,
    candidateId: "owner",
    acceptedVersion: ["APPROVED", "SIGNED"].includes(status) ? 1 : null,
  };
  const prior = {
    id: "previous-version",
    version: 1,
    status,
    fields: [],
    files: existingPages.map((pageCount, ordinal) => ({
      id: `old-${ordinal}`,
      versionId: "previous-version",
      deletedAt: null,
      ordinal,
      storageKey: `old/${ordinal}`,
      pageCount,
      filename: `old-${ordinal}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "test",
    })),
  };
  let createdFiles: Array<{ id: string; ordinal: number; storageKey: string }> =
    [];
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
    documentType: { findUniqueOrThrow: vi.fn(async () => ({ erpUid: uid })) },
    ocrJob: { create: vi.fn(async () => ({ id: "check-job" })) },
    $queryRaw: vi.fn(async () => []),
    candidate: {
      findMany: vi.fn(async () => [{ id: "owner" }]),
      update: vi.fn(async () => ({ id: "owner" })),
      upsert: vi.fn(async () => ({ id: "owner" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: "owner",
        code1c: null,
        locationId: null,
      })),
    },
    document: {
      upsert: vi.fn(async () => document),
      findFirst: vi.fn(async () => document),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(document, data);
        return { count: 1 };
      }),
    },
    documentVersion: {
      aggregate: vi.fn(async () => ({ _max: { version: 1 } })),
      findFirst: vi.fn(async () => prior),
      findUnique: vi.fn(async () => prior),
      create: vi.fn(async ({ data }) => {
        createdFiles = data.files.create;
        return { id: "version", version: 2 };
      }),
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
            files: createdFiles,
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
        code: "PASSPORT",
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
    {
      get: (key: string) =>
        ({
          OCR_MODE: externalOcr ? "external" : "disabled",
          OCR_WORKER_ENABLED: "true",
        })[key],
    } as never,
  );
  return { service, tx, storage, document, prior };
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
  it("dates a successful replacement and queues checking exactly once, without copying review metadata", async () => {
    const { service, tx } = fixture("RETURNED", true);
    await service.upload(staged, "bundle", "");
    expect(tx.documentVersion.update).toHaveBeenCalledWith({
      where: { id: "version" },
      data: { status: "OCR_PENDING", submittedAt: expect.any(Date) },
    });
    expect(tx.ocrJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versionId: "version",
        status: "QUEUED",
        outbox: { create: {} },
      }),
    });
    const creation = tx.documentVersion.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(creation[0].data).not.toHaveProperty("reviewedAt");
    expect(creation[0].data).not.toHaveProperty("reviewedBy");
    await service.upload(staged, "bundle", "");
    expect(tx.documentVersion.update).toHaveBeenCalledTimes(1);
    expect(tx.ocrJob.create).toHaveBeenCalledTimes(1);
  });
  it("queues image checking for a document without any field OCR profile", async () => {
    const { service, tx } = fixture("RETURNED", true);
    const result = await service.upload(
      {
        ...staged,
        metadata: {
          ...staged.metadata!,
          documentUid: "00000000-0000-4000-8000-000000000099",
        },
      },
      "bundle",
      "check-other-document",
    );
    expect(result).toMatchObject({ status: "OCR_PENDING", jobId: "check-job" });
    expect(tx.ocrJob.create).toHaveBeenCalledTimes(1);
  });
  it("blocks replacement while document checking is pending", async () => {
    const { service, storage } = fixture("OCR_PENDING", true);
    await expect(service.upload(staged, "bundle", "")).rejects.toThrow(
      "DOCUMENT_IN_REVIEW",
    );
    expect(storage.upload).not.toHaveBeenCalled();
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
  const appended = (pages = [1, 1]): StagedUpload => ({
    ...staged,
    metadata: { ...staged.metadata!, mode: "append", documentId: "document" },
    files: pages.map((pageCount, ordinal) => ({
      ...staged.files[0],
      id: `new-${ordinal}`,
      filename: `new-${ordinal}.pdf`,
      pageCount,
      ordinal,
    })),
  });
  it("accepts two new files after eight originals and keeps the accepted version", async () => {
    const { service, tx, storage, document, prior } = fixture(
      "APPROVED",
      false,
      Array(8).fill(1),
    );
    const originals = structuredClone(prior);
    await expect(
      service.upload(appended(), "bundle", "append-ten"),
    ).resolves.toMatchObject({ version: 2, status: "IN_REVIEW" });
    const files = tx.documentVersion.create.mock.calls[0][0].data.files.create;
    expect(files.map((file: { ordinal: number }) => file.ordinal)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(files.map((file: { filename: string }) => file.filename)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `old-${index}.pdf`),
      "new-0.pdf",
      "new-1.pdf",
    ]);
    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(document).toMatchObject({
      currentVersion: 2,
      status: "IN_REVIEW",
      acceptedVersion: 1,
    });
    expect(prior).toEqual(originals);
  });
  it("rejects nine originals plus two new files before reserving any new version", async () => {
    const { service, tx, storage, document, prior } = fixture(
      "APPROVED",
      false,
      Array(9).fill(1),
    );
    const before = structuredClone({ document, prior });
    const error = await service
      .upload(appended(), "bundle", "too-many-files")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CandidateDocumentError);
    expect((error as CandidateDocumentError).getStatus()).toBe(400);
    expect((error as CandidateDocumentError).getResponse()).toMatchObject({
      code: "DOCUMENT_REQUEST_INVALID",
      retryable: false,
      message:
        "В документе может быть не больше 10 файлов. Удалите лишние страницы или замените документ.",
    });
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
    expect(tx.documentSubmission.create).not.toHaveBeenCalled();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect({ document, prior }).toEqual(before);

    // Both candidate and reviewer UIs receive the existing safe error envelope.
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    for (const url of [
      "/api/candidate-documents",
      "/api/v1/review/candidates/id/documents",
    ]) {
      new HttpErrorFilter().catch(error, {
        switchToHttp: () => ({
          getResponse: () => reply,
          getRequest: () => ({ url, correlationId: "limit" }),
        }),
      } as unknown as ArgumentsHost);
      expect(reply.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          code: "DOCUMENT_REQUEST_INVALID",
          message: (error as CandidateDocumentError).message,
        }),
      );
    }
  });
  it("accepts a combined 100 pages but rejects 101 without changing the original", async () => {
    const atLimit = fixture("APPROVED", false, [98]);
    await expect(
      atLimit.service.upload(appended(), "bundle", "hundred-pages"),
    ).resolves.toMatchObject({ version: 2 });
    const exceeded = fixture("APPROVED", false, [99]);
    await expect(
      exceeded.service.upload(appended(), "bundle", "too-many-pages"),
    ).rejects.toThrow("В документе может быть не больше 100 страниц");
    expect(exceeded.tx.documentVersion.create).not.toHaveBeenCalled();
    expect(exceeded.storage.upload).not.toHaveBeenCalled();
    expect(exceeded.document).toMatchObject({
      currentVersion: 1,
      status: "APPROVED",
      acceptedVersion: 1,
    });
  });
});
describe("owner-scoped returned document fields", () => {
  const make = () => {
    const findMany = vi.fn().mockResolvedValue([
      {
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
      },
    ]);
    const service = new DocumentReadService(
      {
        document: { findMany },
        igEmploymentState: { findUnique: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      {} as DocumentAccessService,
      {} as StorageService,
    );
    return { service, findMany };
  };
  it("uses only the current returned version and preserves false, null, dates and leading zeros", async () => {
    const { service, findMany } = make();
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
    expect(findMany.mock.calls[0][0].where).toEqual({
      candidate: { chatUuid: "chat-owner" },
      documentType: { erpUid: uid },
      status: "RETURNED",
      currentVersion: { gt: 0 },
    });
  });
  it("requires an owner and does not fall back to a historical rejected version", async () => {
    const { service, findMany } = make();
    await expect(service.internalDraft({}, uid)).rejects.toThrow(
      "Document owner is required",
    );
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockResolvedValue([
      {
        currentVersion: 3,
        versions: [{ version: 2, fields: [] }],
      },
    ]);
    await expect(
      service.internalDraft({ code_1c: "001" }, uid),
    ).rejects.toThrow("Returned document not found");
    findMany.mockResolvedValue([]);
    await expect(
      service.internalDraft({ chat_uuid: "another-owner" }, uid),
    ).rejects.toThrow("Returned document not found");
  });
});
