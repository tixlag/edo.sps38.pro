import "reflect-metadata";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import type { DocumentStatus } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { ManualDocumentService } from "../src/documents/manual-document.service";
import { DocumentPdfService } from "../src/documents/document-pdf.service";
import { DocumentReviewService } from "../src/documents/document-review.service";
import type { StagedUpload } from "../src/documents/document-upload.service";

const documentUid = "6ffb1fd5-8341-11eb-ba8b-00259002db81";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

interface FileRow {
  id: string;
  ordinal: number;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
  deletedAt?: null;
}
interface FieldRow {
  name: string;
  kind: string;
  required: boolean;
  ordinal: number;
  value: string;
  submittedValue: string;
}
interface VersionRow {
  id: string;
  documentId: string;
  version: number;
  status: DocumentStatus;
  revision: number;
  positionCode1c: string;
  citizenship: string;
  storageKey: string;
  files: FileRow[];
  fields: FieldRow[];
  submission: { id: string } | null;
  pendingApprovalStorageKey: string | null;
  approvalLeaseUntil: Date | null;
  approvedStorageKey: string | null;
  approvedPageCount: number | null;
  approvedMimeType: string | null;
  approvedSha256: string | null;
  approvedSizeBytes: number | null;
}

async function fixture() {
  const candidate = {
    id: "candidate",
    chatUuid: "00000000-0000-4000-8000-000000000001",
    erpUid: "00000000-0000-4000-8000-000000000002",
    reviewGroup: "RU",
    citizenship: "ru",
    code1c: null,
    locationId: null,
  };
  const type = {
    id: "type",
    erpUid: documentUid,
    code: "PASSPORT",
    title: "Паспорт",
    catalogSyncedAt: new Date(),
    allRu: true,
    allForeign: false,
    positions: [],
    definitions: [{ name: "number", kind: "text", required: true, ordinal: 0 }],
  };
  const document = {
    id: "document",
    candidateId: candidate.id,
    documentTypeId: type.id,
    status: "APPROVED" as DocumentStatus,
    currentVersion: 1,
    acceptedVersion: 1,
    candidate,
    documentType: type,
  };
  const dimensions = [
    [210, 297],
    [220, 307],
    [230, 317],
    [240, 327],
    [250, 337],
  ];
  const pages = await Promise.all(
    dimensions.map(async (size) => {
      const pdf = await PDFDocument.create();
      pdf.addPage(size as [number, number]);
      return Buffer.from(await pdf.save());
    }),
  );
  const objects = new Map<string, Buffer>();
  const originalFiles = pages.slice(0, 3).map((bytes, ordinal) => {
    const storageKey = `document/v1/page-${ordinal}`;
    objects.set(storageKey, bytes);
    return {
      id: `old-${ordinal}`,
      ordinal,
      storageKey,
      filename: `page-${ordinal + 1}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      sha256: hash(bytes),
      pageCount: 1,
      deletedAt: null,
    };
  });
  const previousPdf = await PDFDocument.create();
  for (const size of dimensions.slice(0, 3))
    previousPdf.addPage(size as [number, number]);
  const oldArtifact = Buffer.from(await previousPdf.save());
  objects.set("document/v1/approved.pdf", oldArtifact);
  const base: VersionRow = {
    id: "version-1",
    documentId: document.id,
    version: 1,
    status: "APPROVED",
    revision: 1,
    positionCode1c: "position",
    citizenship: "ru",
    storageKey: originalFiles[0].storageKey,
    files: originalFiles,
    fields: [
      { ...type.definitions[0], value: "000123", submittedValue: "000123" },
    ],
    submission: { id: "old-submission" },
    pendingApprovalStorageKey: null,
    approvalLeaseUntil: null,
    approvedStorageKey: "document/v1/approved.pdf",
    approvedPageCount: 3,
    approvedMimeType: "application/pdf",
    approvedSha256: hash(oldArtifact),
    approvedSizeBytes: oldArtifact.length,
  };
  const versions = new Map<string, VersionRow>([[base.id, base]]);
  type Submission = {
    id: string;
    status: string;
    fingerprint: string;
    versionId: string;
    version: VersionRow & { document: typeof document };
  };
  let submission: Submission | null = null;
  const deliveries: {
    id: string;
    versionId: string;
    status: string;
    transport: string;
  }[] = [
    {
      id: "old-delivery",
      versionId: base.id,
      status: "SENT",
      transport: "multipart-v2",
    },
  ];
  type VersionWhere = {
    id?: string;
    documentId_version?: { documentId: string; version: number };
  };
  const findVersion = (where: VersionWhere) =>
    where.id
      ? versions.get(where.id)
      : [...versions.values()].find(
          (row) =>
            row.documentId === where.documentId_version?.documentId &&
            row.version === where.documentId_version.version,
        );
  const tx = {
    $queryRaw: vi.fn(async () => []),
    candidate: {
      findFirstOrThrow: vi.fn(async () => candidate),
      findUniqueOrThrow: vi.fn(async () => candidate),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    igEmploymentState: { findFirst: vi.fn(async () => null) },
    documentType: {
      findUnique: vi.fn(async () => type),
      findUniqueOrThrow: vi.fn(async () => type),
    },
    document: {
      findFirst: vi.fn(async () => document),
      findUnique: vi.fn(async () => document),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(document, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => Object.assign(document, data)),
    },
    documentVersion: {
      aggregate: vi.fn(async () => ({ _max: { version: 1 } })),
      findFirst: vi.fn(async () => base),
      findUnique: vi.fn(async ({ where }: { where: VersionWhere }) => {
        const row = findVersion(where);
        return row ? { ...row, document } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: VersionWhere }) => {
        const row = findVersion(where);
        if (!row) throw new Error("version missing");
        return {
          ...row,
          files: [...row.files].sort((a, b) => a.ordinal - b.ordinal),
        };
      }),
      create: vi.fn(async ({ data }) => {
        const row: VersionRow = {
          ...data,
          id: "version-2",
          revision: 0,
          files: data.files.create,
          fields: data.fields.create,
          submission: null,
          pendingApprovalStorageKey: null,
          approvalLeaseUntil: null,
          approvedStorageKey: null,
          approvedPageCount: null,
          approvedMimeType: null,
          approvedSha256: null,
          approvedSizeBytes: null,
        };
        versions.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = findVersion(where)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = findVersion(where);
        if (
          !row ||
          row.status !== where.status ||
          row.revision !== where.revision ||
          row.pendingApprovalStorageKey !== where.pendingApprovalStorageKey ||
          row.approvedStorageKey !== where.approvedStorageKey
        )
          return { count: 0 };
        const revision =
          typeof data.revision === "object"
            ? row.revision + data.revision.increment
            : row.revision;
        Object.assign(row, data, { revision });
        return { count: 1 };
      }),
    },
    documentSubmission: {
      findUnique: vi.fn(async () => submission),
      findFirst: vi.fn(async () =>
        submission?.status === "UPLOADING" ? submission : null,
      ),
      create: vi.fn(async ({ data }) => {
        const row = versions.get(data.versionId)!;
        row.submission = { id: "submission" };
        submission = {
          ...data,
          id: "submission",
          status: "UPLOADING",
          version: Object.assign(row, { document }),
        };
        return submission;
      }),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(submission!, data);
        return { count: 1 };
      }),
    },
    erpDocumentDelivery: {
      create: vi.fn(async ({ data }) => {
        const delivery = { ...data, id: "new-delivery" };
        deliveries.push(delivery);
        return delivery;
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(apply: (client: typeof tx) => Promise<T>) =>
      apply(tx),
  };
  const stagedFiles = pages.slice(3).map((bytes, ordinal) => ({
    id: `new-${ordinal}`,
    ordinal,
    path: `staged-${ordinal}`,
    filename: `page-${ordinal + 4}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: bytes.length,
    sha256: hash(bytes),
    pageCount: 1,
  }));
  const storage = {
    keyFor: (id: string, version: number, filename: string) =>
      `${id}/v${version}/${filename}`,
    upload: vi.fn(async (key: string, path: string) => {
      const index = stagedFiles.findIndex((file) => file.path === path);
      if (index < 0) throw new Error("only new files can be uploaded");
      objects.set(key, pages[index + 3]);
    }),
    read: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("object missing");
      return bytes;
    }),
    uploadBuffer: vi.fn(async (key: string, bytes: Buffer) => {
      objects.set(key, bytes);
    }),
  };
  const config = new ConfigService({
    OCR_MODE: "disabled",
    ERP_DOCUMENTS_TRANSPORT: "multipart-v2",
  });
  const audit = { logInTransaction: vi.fn(async () => undefined) };
  const access = {
    document: vi.fn(async () => document),
    documentReviewWhere: vi.fn(() => ({})),
  };
  const reads = {
    version: vi.fn(async (_id: string, number: number) =>
      findVersion({
        documentId_version: { documentId: document.id, version: number },
      }),
    ),
  };
  const pdf = new DocumentPdfService(prisma as never, storage as never, config);
  const prepare = vi.spyOn(pdf, "prepare");
  const manual = new ManualDocumentService(
    prisma as never,
    storage as never,
    audit as never,
    { ensure: vi.fn(async () => undefined) } as never,
    config,
  );
  const review = new DocumentReviewService(
    prisma as never,
    access as never,
    audit as never,
    reads as never,
    pdf,
  );
  const upload: StagedUpload = {
    directory: "unused",
    files: stagedFiles,
    metadata: {
      documentUid,
      chat_uuid: candidate.chatUuid,
      position_code_1c: "position",
      citizenship: "ru",
      documentFields: {},
      mode: "append",
      documentId: document.id,
    },
  };
  const principal = {
    uuid: "reviewer",
    code1c: null,
    sid: null,
    deviceId: null,
    accessRules: { "20009": [] },
    expiresAt: null,
  };
  return {
    manual,
    review,
    upload,
    principal,
    document,
    base,
    versions,
    objects,
    oldArtifact,
    originalFiles,
    dimensions,
    storage,
    prepare,
    deliveries,
    tx,
  };
}

describe("manual append approval pipeline", () => {
  it("keeps the accepted version while reviewing the appended five pages and delivers the complete ordered artifact only after approval", async () => {
    const f = await fixture();
    const result = await f.manual.upload(
      f.upload,
      "append-bundle",
      "append-test",
      { candidateId: "candidate", principal: f.principal },
    );
    expect(result).toMatchObject({
      documentId: "document",
      version: 2,
      status: "IN_REVIEW",
    });
    const appended = f.versions.get("version-2")!;
    expect(appended.files.map((file) => file.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(appended.files.slice(0, 3).map((file) => file.storageKey)).toEqual(
      f.originalFiles.map((file) => file.storageKey),
    );
    expect(appended.files.slice(0, 3).map((file) => file.id)).not.toEqual(
      f.originalFiles.map((file) => file.id),
    );
    expect(appended.fields[0].value).toBe("000123");
    expect(f.storage.upload).toHaveBeenCalledTimes(2);
    expect(f.document).toMatchObject({
      currentVersion: 2,
      status: "IN_REVIEW",
      acceptedVersion: 1,
    });
    expect(f.base).toMatchObject({
      status: "APPROVED",
      approvedStorageKey: "document/v1/approved.pdf",
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.storage.uploadBuffer).not.toHaveBeenCalled();
    expect(f.tx.erpDocumentDelivery.create).not.toHaveBeenCalled();
    expect(appended.approvedStorageKey).toBeNull();

    await f.review.approve("document", 2, 0, f.principal, "approval-test");

    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.document).toMatchObject({
      currentVersion: 2,
      status: "APPROVED",
      acceptedVersion: 2,
    });
    expect(appended).toMatchObject({
      status: "APPROVED",
      revision: 1,
      approvedMimeType: "application/pdf",
      approvedPageCount: 5,
    });
    const artifact = f.objects.get(appended.approvedStorageKey!)!;
    const pdf = await PDFDocument.load(artifact);
    expect(
      pdf.getPages().map((page) => [page.getWidth(), page.getHeight()]),
    ).toEqual(f.dimensions);
    expect(appended.approvedSha256).toBe(hash(artifact));
    expect(appended.approvedSizeBytes).toBe(artifact.length);
    expect(f.storage.read.mock.calls.map(([key]) => key)).toEqual(
      appended.files.map((file) => file.storageKey),
    );
    expect(f.deliveries).toEqual([
      expect.objectContaining({ versionId: "version-1", status: "SENT" }),
      expect.objectContaining({
        versionId: appended.id,
        status: "PENDING",
        transport: "multipart-v2",
      }),
    ]);
    expect(f.tx.erpDocumentDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versionId: appended.id,
        payload: {
          documentUid,
          candidateUid: f.document.candidate.erpUid,
          documentFields: { number: "000123" },
        },
      }),
    });
    expect(f.objects.get("document/v1/approved.pdf")).toEqual(f.oldArtifact);
    expect(f.base.files.map((file) => file.ordinal)).toEqual([0, 1, 2]);
  });
});
