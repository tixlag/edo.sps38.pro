import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { PDFDocument, degrees, PDFName, PDFNumber } from "pdf-lib";
import {
  AnnotationSourceService,
  inspectAnnotationSource,
} from "../src/annotations/annotation-source.service";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { StorageService } from "../src/storage/storage.service";
import type { DocumentAccessService } from "../src/documents/document-access.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
const principal: AuthPrincipal = {
  uuid: "author",
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: { "20002": [] },
};
async function sourceFixture() {
  const bytes = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const row = {
    id: "version",
    version: 1,
    status: "IN_REVIEW",
    cleanupPending: false,
    citizenship: "ru",
    submission: null as null | { status: string },
    job: null as null | {
      status: string;
      errorCode: string | null;
      cleanupPending: boolean;
    },
    document: {
      currentVersion: 1,
      documentType: { code: "passport" },
      candidate: { citizenship: "ru" },
    },
    files: [
      {
        id: "file",
        storageKey: "private/source.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        deletedAt: null as Date | null,
      },
    ],
  };
  const prisma = { documentVersion: { findFirst: vi.fn(async () => row) } };
  const storage = {
    read: vi.fn(async () => bytes),
    previewUrl: vi.fn(async () => "https://private.invalid/source"),
  };
  const service = new AnnotationSourceService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    { documentReviewWhere: () => ({}) } as unknown as DocumentAccessService,
  );
  return { row, prisma, storage, service };
}
describe("annotation retained and completed source policy", () => {
  it("denies real failed-upload bytes before storage read or URL signing", async () => {
    const { row, service, storage } = await sourceFixture();
    row.status = "OCR_FAILED";
    row.job = {
      status: "FAILED",
      errorCode: "UPLOAD_FAILED",
      cleanupPending: true,
    };
    await expect(
      service
        .manifest("document", 1, principal)
        .then((manifest) => service.publicDto(manifest, principal)),
    ).rejects.toThrow("unavailable");
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.previewUrl).not.toHaveBeenCalled();
  });
  it.each([
    { submission: { status: "UPLOADING" } },
    { submission: { status: "FAILED" } },
    { submission: { status: "UNKNOWN" } },
    { job: { status: "UPLOADING", errorCode: null, cleanupPending: false } },
    {
      job: {
        status: "FAILED",
        errorCode: "UPLOAD_FAILED",
        cleanupPending: false,
      },
    },
    { job: { status: "SUCCEEDED", errorCode: null, cleanupPending: true } },
    { job: { status: "REJECTED", errorCode: null, cleanupPending: false } },
    { job: { status: "CANCELLED", errorCode: null, cleanupPending: false } },
    { job: { status: "UNKNOWN", errorCode: null, cleanupPending: false } },
    { status: "OCR_FAILED" },
    { status: "RETURNED" },
    { status: "UNKNOWN" },
  ])(
    "fails closed before reading an incomplete or ineligible source: %j",
    async (state) => {
      const { row, service, storage } = await sourceFixture();
      Object.assign(row, state);
      await expect(
        service.manifest("document", 1, principal),
      ).rejects.toThrow();
      expect(storage.read).not.toHaveBeenCalled();
    },
  );
  it("rechecks failed-upload state using the mutation transaction", async () => {
    const { row, service, prisma } = await sourceFixture();
    const manifest = await service.manifest("document", 1, principal);
    const tx = {
      documentVersion: {
        findFirst: vi.fn(async () => ({
          ...row,
          job: {
            status: "FAILED",
            errorCode: "UPLOAD_FAILED",
            cleanupPending: true,
          },
        })),
      },
    };
    await expect(
      service.assertRetained(
        tx as unknown as Prisma.TransactionClient,
        manifest,
        principal,
      ),
    ).rejects.toThrow();
    expect(tx.documentVersion.findFirst).toHaveBeenCalledOnce();
    expect(prisma.documentVersion.findFirst).toHaveBeenCalledOnce();
  });
  it.each([
    "deleted",
    "cleanup",
    "failed-upload",
    "unsubmitted",
    "returned",
    "missing",
  ])(
    "keeps stored %s snapshot metadata without signing its original",
    async (state) => {
      const { row, service, storage, prisma } = await sourceFixture();
      const manifest = await service.manifest("document", 1, principal);
      storage.read.mockClear();
      if (state === "deleted") row.files[0].deletedAt = new Date();
      if (state === "cleanup") row.cleanupPending = true;
      if (state === "failed-upload")
        row.job = {
          status: "FAILED",
          errorCode: "UPLOAD_FAILED",
          cleanupPending: true,
        };
      if (state === "unsubmitted") row.submission = { status: "UPLOADING" };
      if (state === "returned") row.status = "RETURNED";
      if (state === "missing")
        prisma.documentVersion.findFirst.mockResolvedValueOnce(
          null as unknown as typeof row,
        );
      const dto = await service.publicDto(manifest, principal);
      expect(dto.available).toBe(false);
      expect(dto.pages).toHaveLength(1);
      expect(dto.pages[0]).toMatchObject({
        id: manifest.pages[0].id,
        width: 10,
        height: 10,
        sha256: manifest.pages[0].sha256,
        previewUrl: "",
      });
      expect(dto.pages[0]).not.toHaveProperty("storageKey");
      expect(storage.read).not.toHaveBeenCalled();
      expect(storage.previewUrl).not.toHaveBeenCalled();
    },
  );
  it("propagates database failures instead of hiding them as unavailable metadata", async () => {
    const { service, storage, prisma } = await sourceFixture();
    const manifest = await service.manifest("document", 1, principal);
    prisma.documentVersion.findFirst.mockRejectedValueOnce(
      new Error("database offline"),
    );
    await expect(service.publicDto(manifest, principal)).rejects.toThrow(
      "database offline",
    );
    expect(storage.previewUrl).not.toHaveBeenCalled();
  });
  it("denies verification storage reads after upload eligibility changes", async () => {
    const { row, service, storage } = await sourceFixture();
    const manifest = await service.manifest("document", 1, principal);
    storage.read.mockClear();
    row.job = {
      status: "FAILED",
      errorCode: "UPLOAD_FAILED",
      cleanupPending: true,
    };
    await expect(service.verifyBytes(manifest, principal)).rejects.toThrow();
    expect(storage.read).not.toHaveBeenCalled();
  });
  it.each([null, "QUEUED", "RUNNING", "SUCCEEDED", "FAILED"])(
    "retains completed originals when OCR job is %s",
    async (status) => {
      const { row, service, storage } = await sourceFixture();
      if (status)
        row.job = {
          status,
          errorCode: status === "FAILED" ? "OCR_TIMEOUT" : null,
          cleanupPending: false,
        };
      const manifest = await service.manifest("document", 1, principal);
      const dto = await service.publicDto(manifest, principal);
      expect(dto.available).toBe(true);
      expect(dto.pages[0].previewUrl).toBe("https://private.invalid/source");
      expect(dto.pages[0]).not.toHaveProperty("storageKey");
      expect(storage.previewUrl).toHaveBeenCalledOnce();
    },
  );
  it.each(["IN_REVIEW", "APPROVED", "SIGNED"])(
    "preserves completed %s originals including retained historical approvals",
    async (status) => {
      const { row, service, prisma, storage } = await sourceFixture();
      row.status = status;
      row.submission = { status: "SUCCEEDED" };
      row.job = { status: "SUCCEEDED", errorCode: null, cleanupPending: false };
      if (status !== "IN_REVIEW") row.document.currentVersion = 2;
      const manifest = await service.manifest("document", 1, principal);
      await service.assertRetained(
        prisma as unknown as Prisma.TransactionClient,
        manifest,
        principal,
      );
      expect(storage.read).toHaveBeenCalledOnce();
    },
  );
});
describe("server canonical annotation source metadata", () => {
  it("hashes actual bytes and applies EXIF orientation to dimensions", async () => {
    const bytes = await sharp({
      create: { width: 100, height: 60, channels: 3, background: "white" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const p = await inspectAnnotationSource(bytes, "image/jpeg");
    expect(p).toMatchObject({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    });
    expect(p.pages).toEqual([
      { pageNumber: 1, width: 60, height: 100, rotation: 90 },
    ]);
  });
  it("uses crop box and PDF intrinsic rotation at 200 DPI", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 500]);
    page.setCropBox(10, 20, 200, 400);
    page.setRotation(degrees(90));
    const p = await inspectAnnotationSource(
      Buffer.from(await pdf.save()),
      "application/pdf",
    );
    expect(p.pages).toEqual([
      { pageNumber: 1, width: 1112, height: 556, rotation: 90 },
    ]);
  });
  it("rejects unsupported source MIME", async () => {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(
      inspectAnnotationSource(bytes, "text/plain"),
    ).rejects.toThrow();
  });
  it("rejects unsupported PDF user units and crop boxes outside media", async () => {
    for (const variant of ["unit", "crop"]) {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([300, 500]);
      if (variant === "unit")
        page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
      else page.setCropBox(-20, 0, 400, 500);
      await expect(
        inspectAnnotationSource(
          Buffer.from(await pdf.save()),
          "application/pdf",
        ),
      ).rejects.toThrow();
    }
  });
});
