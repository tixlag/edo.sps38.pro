import {
  ConflictException,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
} from "pdf-lib";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  artifactExtensions,
  hashArtifact,
  MAX_APPROVED_BYTES,
  type ApprovedArtifact,
  type DocumentTransport,
} from "./approved-artifact";

/** EXIF top-left coordinates expressed in PDF's bottom-left coordinate system. */
export function orientationMatrix(
  orientation: number,
  w: number,
  h: number,
): [number, number, number, number, number, number] {
  return (
    (
      {
        1: [1, 0, 0, 1, 0, 0],
        2: [-1, 0, 0, 1, w, 0],
        3: [-1, 0, 0, -1, w, h],
        4: [1, 0, 0, -1, 0, h],
        5: [0, -1, -1, 0, h, w],
        6: [0, -1, 1, 0, 0, w],
        7: [0, 1, 1, 0, 0, 0],
        8: [0, 1, -1, 0, h, 0],
      } as Record<number, [number, number, number, number, number, number]>
    )[orientation] ?? [1, 0, 0, 1, 0, 0]
  );
}
export async function mergeDocumentPdf(
  files: { mimeType: string; bytes: Buffer }[],
): Promise<Buffer> {
  if (!files.length || files.length > 10)
    throw new PayloadTooLargeException("Expected 1–10 files");
  if (files.some((f) => !f.bytes.length || f.bytes.length > MAX_APPROVED_BYTES))
    throw new PayloadTooLargeException("Invalid input size");
  if (files.length === 1 && files[0].mimeType === "application/pdf") {
    const pdf = await PDFDocument.load(files[0].bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 100)
      throw new PayloadTooLargeException("At most 100 pages");
    return files[0].bytes;
  }
  const result = await PDFDocument.create();
  for (const file of files) {
    if (file.mimeType === "application/pdf") {
      const input = await PDFDocument.load(file.bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
      if (
        !input.getPageCount() ||
        result.getPageCount() + input.getPageCount() > 100
      )
        throw new PayloadTooLargeException("At most 100 pages");
      for (const page of await result.copyPages(input, input.getPageIndices()))
        result.addPage(page);
    } else {
      if (!artifactExtensions[file.mimeType])
        throw new ConflictException("Unsupported image");
      const metadata = await sharp(file.bytes, {
        limitInputPixels: 40000000,
      }).metadata();
      let image;
      if (file.mimeType === "image/jpeg") {
        // JPEG bytes (including the original DCT data) go directly into the PDF.
        try {
          image = await result.embedJpg(file.bytes);
        } catch {
          // Some JPEG variants decode in sharp but cannot be embedded by pdf-lib.
          // A lossless PNG fallback preserves pixels and still uses the EXIF matrix.
          const png = await sharp(file.bytes, { limitInputPixels: 40000000 })
            .timeout({ seconds: 15 })
            .png()
            .toBuffer();
          image = await result.embedPng(png);
        }
      } else if (file.mimeType === "image/png") {
        image = await result.embedPng(file.bytes);
      } else {
        // WebP is decoded losslessly to PNG. Never introduce another lossy encode;
        // alpha, fine text and QR pixels are preserved. Originals are untouched.
        const png = await sharp(file.bytes, { limitInputPixels: 40000000 })
          .timeout({ seconds: 15 })
          .png()
          .toBuffer();
        image = await result.embedPng(png);
      }
      const orientation = metadata.orientation ?? 1;
      const w = image.width,
        h = image.height;
      const page = result.addPage(
        orientation >= 5 && orientation <= 8 ? [h, w] : [w, h],
      );
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...orientationMatrix(orientation, w, h)),
      );
      page.drawImage(image, { x: 0, y: 0, width: w, height: h });
      page.pushOperators(popGraphicsState());
    }
    if (result.getPageCount() > 100)
      throw new PayloadTooLargeException("At most 100 pages");
  }
  const bytes = Buffer.from(await result.save());
  if (bytes.length > MAX_APPROVED_BYTES)
    throw new PayloadTooLargeException("Approved PDF exceeds 100 MiB");
  return bytes;
}
@Injectable()
export class DocumentPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}
  async prepare(
    versionId: string,
    revision: number,
  ): Promise<ApprovedArtifact> {
    const version = await this.prisma.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: {
        files: { where: { deletedAt: null }, orderBy: { ordinal: "asc" } },
      },
    });
    const transport = (this.config.get<string>("ERP_DOCUMENTS_TRANSPORT") ??
      "multipart-v2") as DocumentTransport;
    if (!["base64-v1", "multipart-v2"].includes(transport))
      throw new Error("ERP_TRANSPORT_INVALID");
    if (!version.files.length)
      throw new ConflictException("Document originals are unavailable");
    if (
      version.files.length > 10 ||
      version.files.reduce((n, f) => n + f.pageCount, 0) > 100
    )
      throw new PayloadTooLargeException("At most 10 files and 100 pages");
    const single = transport === "multipart-v2" && version.files.length === 1;
    const mimeType = single ? version.files[0].mimeType : "application/pdf";
    const extension = artifactExtensions[mimeType];
    if (!extension) throw new ConflictException("Unsupported original format");
    const key = this.storage.keyFor(
      version.documentId,
      version.version,
      `approved-${randomUUID()}.${extension}`,
    );
    const changed = await this.prisma.documentVersion.updateMany({
      where: {
        id: versionId,
        revision,
        status: "IN_REVIEW",
        pendingApprovalStorageKey: null,
        approvedStorageKey: null,
      },
      data: {
        pendingApprovalStorageKey: key,
        approvalLeaseUntil: new Date(Date.now() + 600000),
      },
    });
    if (!changed.count)
      throw new ConflictException(
        "Document is already being approved or has changed",
      );
    try {
      let sizeBytes: number, sha256: string;
      if (single) {
        // Server-side byte copy, independent ownership; verify the destination,
        // even for legacy originals without a reliable stored SHA-256.
        const signal = AbortSignal.timeout(120000);
        await this.storage.copy(version.files[0].storageKey, key, signal);
        ({ sizeBytes, sha256 } = await hashArtifact(
          await this.storage.openRead(key, signal),
        ));
        const source = version.files[0];
        if (
          source.sizeBytes !== sizeBytes ||
          (source.sha256 && source.sha256 !== sha256)
        )
          throw new Error("APPROVED_ARTIFACT_MISMATCH");
      } else {
        const files = [];
        for (const file of version.files) {
          const bytes = await this.storage.read(
            file.storageKey,
            10 * 1024 * 1024,
          );
          if (
            bytes.length !== file.sizeBytes ||
            (file.sha256 &&
              createHash("sha256").update(bytes).digest("hex") !== file.sha256)
          )
            throw new Error("APPROVED_ARTIFACT_MISMATCH");
          files.push({ mimeType: file.mimeType, bytes });
        }
        const bytes = await mergeDocumentPdf(files);
        sizeBytes = bytes.length;
        sha256 = createHash("sha256").update(bytes).digest("hex");
        await this.storage.uploadBuffer(key, bytes, mimeType);
      }
      return {
        key,
        mimeType,
        extension,
        filename: `document.${extension}`,
        sizeBytes,
        sha256,
        pageCount: version.files.reduce((n, f) => n + f.pageCount, 0),
        preparation: single ? "original-copy-v2" : "direct-images-pdf-v2",
        transport,
      };
    } catch (error) {
      await this.discard(versionId, key);
      throw error;
    }
  }
  async discard(versionId: string, key: string): Promise<void> {
    // Serialize with approval's UPDATE. A stale maintenance read must never
    // delete an artifact which has since been committed as approved.
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM document_versions WHERE id = ${versionId} FOR UPDATE`;
        const row = await tx.documentVersion.findUnique({
          where: { id: versionId },
        });
        if (
          !row ||
          row.pendingApprovalStorageKey !== key ||
          row.approvedStorageKey === key
        )
          return;
        const ownedPrefix = this.storage.keyFor(
          row.documentId,
          row.version,
          "approved-",
        );
        if (
          !key.startsWith(ownedPrefix) ||
          (await tx.documentVersionFile.findFirst({
            where: { storageKey: key },
          }))
        )
          throw new Error("APPROVAL_CLEANUP_NOT_OWNED");
        await this.storage.delete(key);
        await tx.documentVersion.updateMany({
          where: {
            id: versionId,
            pendingApprovalStorageKey: key,
            approvedStorageKey: null,
          },
          data: { pendingApprovalStorageKey: null, approvalLeaseUntil: null },
        });
      },
      { timeout: 20000 },
    );
  }
}
