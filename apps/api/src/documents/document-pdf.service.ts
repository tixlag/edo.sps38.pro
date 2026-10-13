import {
  ConflictException,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

export async function mergeDocumentPdf(
  files: { mimeType: string; bytes: Buffer }[],
): Promise<Buffer> {
  if (files.length === 1 && files[0].mimeType === "application/pdf")
    return files[0].bytes;
  const result = await PDFDocument.create();
  for (const file of files) {
    if (file.mimeType === "application/pdf") {
      const input = await PDFDocument.load(file.bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
      for (const page of await result.copyPages(input, input.getPageIndices()))
        result.addPage(page);
    } else {
      const png = await sharp(file.bytes, { limitInputPixels: 40000000 })
        .rotate()
        .timeout({ seconds: 15 })
        .png()
        .toBuffer();
      const image = await result.embedPng(png);
      const page = result.addPage([image.width, image.height]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
    }
  }
  const bytes = Buffer.from(await result.save());
  if (bytes.length > 100 * 1024 * 1024)
    throw new PayloadTooLargeException("Approved PDF exceeds 100 MiB");
  return bytes;
}
@Injectable()
export class DocumentPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}
  async prepare(versionId: string, revision: number): Promise<string> {
    const version = await this.prisma.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: {
        files: { where: { deletedAt: null }, orderBy: { ordinal: "asc" } },
      },
    });
    const key = this.storage.keyFor(
      version.documentId,
      version.version,
      `approved-${randomUUID()}.pdf`,
    );
    const changed = await this.prisma.documentVersion.updateMany({
      where: {
        id: versionId,
        revision,
        status: "IN_REVIEW",
        pendingApprovalStorageKey: null,
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
      if (!version.files.length)
        throw new ConflictException("Document originals are unavailable");
      const files = [];
      for (const file of version.files)
        files.push({
          mimeType: file.mimeType,
          bytes: await this.storage.read(file.storageKey, 10 * 1024 * 1024),
        });
      await this.storage.uploadBuffer(
        key,
        await mergeDocumentPdf(files),
        "application/pdf",
      );
      return key;
    } catch (error) {
      await this.discard(versionId, key);
      throw error;
    }
  }
  async discard(versionId: string, key: string): Promise<void> {
    // Leave the owned key in the DB on S3 failure; maintenance retries cleanup.
    await this.storage.delete(key);
    await this.prisma.documentVersion.updateMany({
      where: { id: versionId, pendingApprovalStorageKey: key },
      data: { pendingApprovalStorageKey: null, approvalLeaseUntil: null },
    });
  }
}
