import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { DocumentAccessService } from "../documents/document-access.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import {
  AnnotationProfile,
  AnnotationSourceDto,
  AnnotationSourceKind,
} from "./annotation.dto";
export const ANNOTATION_SOURCE_LIMIT = 50 * 1024 * 1024;
const MAX_PIXELS = 40_000_000,
  MAX_PAGES = 50;
export interface SourceManifest {
  documentId: string;
  documentTypeCode: string;
  profile: AnnotationProfile;
  versionId: string;
  version: number;
  sourceKind: AnnotationSourceKind;
  pages: SourcePage[];
}
export interface SourcePage {
  id: string;
  fileId: string;
  pageNumber: number;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  rotation: number;
  frame: "UPRIGHT_PIXELS_V1";
  renderDpi: number;
  mimeType: string;
  storageKey: string;
}
export async function inspectAnnotationSource(
  bytes: Buffer,
  mimeType: string,
): Promise<{
  sha256: string;
  sizeBytes: number;
  pages: {
    pageNumber: number;
    width: number;
    height: number;
    rotation: number;
  }[];
}> {
  if (bytes.length > ANNOTATION_SOURCE_LIMIT)
    throw new PayloadTooLargeException("Annotation source exceeds limit");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let pages: {
    pageNumber: number;
    width: number;
    height: number;
    rotation: number;
  }[];
  if (mimeType === "application/pdf") {
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (!pdf.getPageCount() || pdf.getPageCount() > MAX_PAGES)
      throw new PayloadTooLargeException("Too many annotation pages");
    pages = pdf.getPages().map((p, i) => {
      const box = p.getCropBox(),
        media = p.getMediaBox(),
        unit =
          p.node.lookupMaybe(PDFName.of("UserUnit"), PDFNumber)?.asNumber() ??
          1;
      if (
        unit !== 1 ||
        box.x < media.x ||
        box.y < media.y ||
        box.x + box.width > media.x + media.width ||
        box.y + box.height > media.y + media.height
      )
        throw new UnsupportedMediaTypeException(
          "PDF crop box or user unit is unsupported",
        );
      const rotation = ((p.getRotation().angle % 360) + 360) % 360;
      if (![0, 90, 180, 270].includes(rotation))
        throw new BadRequestException("Invalid PDF rotation");
      const width = Math.ceil(
          ((rotation % 180 ? box.height : box.width) * 200) / 72,
        ),
        height = Math.ceil(
          ((rotation % 180 ? box.width : box.height) * 200) / 72,
        );
      return { pageNumber: i + 1, width, height, rotation };
    });
  } else if (["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    const m = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
    if (!m.width || !m.height || (m.pages ?? 1) > 1)
      throw new BadRequestException("Unsupported multi-page image");
    const swap = (m.orientation ?? 1) >= 5;
    pages = [
      {
        pageNumber: 1,
        width: swap ? m.height : m.width,
        height: swap ? m.width : m.height,
        rotation:
          (
            { 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 } as Record<
              number,
              number
            >
          )[m.orientation ?? 1] ?? 0,
      },
    ];
  } else
    throw new UnsupportedMediaTypeException("Unsupported annotation source");
  if (
    pages.some(
      (p) =>
        !Number.isFinite(p.width * p.height) ||
        p.width < 1 ||
        p.height < 1 ||
        p.width * p.height > MAX_PIXELS,
    )
  )
    throw new PayloadTooLargeException("Annotation page exceeds pixel limit");
  return { sha256, sizeBytes: bytes.length, pages };
}
@Injectable()
export class AnnotationSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly access: DocumentAccessService,
  ) {}
  async version(
    documentId: string,
    version: number,
    principal: AuthPrincipal,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const row = await tx.documentVersion.findFirst({
      where: {
        documentId,
        version,
        document: this.access.documentReviewWhere(principal),
      },
      include: {
        document: { include: { documentType: true, candidate: true } },
        files: { orderBy: { ordinal: "asc" } },
        submission: true,
        job: true,
      },
    });
    if (!row) throw new NotFoundException("Document version not found");
    return row;
  }
  async manifest(
    documentId: string,
    version: number,
    principal: AuthPrincipal,
  ): Promise<SourceManifest> {
    const row = await this.version(documentId, version, principal);
    this.assertEligible(row);
    const code = row.document.documentType?.code;
    if (!code) throw new ConflictException("Document type is unavailable");
    const citizenship = (
      row.citizenship ??
      row.document.candidate?.citizenship ??
      ""
    ).toLowerCase();
    const profile =
      citizenship === "ru"
        ? AnnotationProfile.RU
        : citizenship === "uz"
          ? AnnotationProfile.UZ
          : AnnotationProfile.OTHER;
    const manifest: SourceManifest = {
      documentId,
      documentTypeCode: code,
      profile,
      versionId: row.id,
      version,
      sourceKind: AnnotationSourceKind.ORIGINAL,
      pages: [],
    };
    for (const file of row.files) {
      const bytes = await this.storage
        .read(file.storageKey, ANNOTATION_SOURCE_LIMIT)
        .catch(() => {
          throw new ConflictException("Annotation source cannot be read");
        });
      const info = await inspectAnnotationSource(bytes, file.mimeType);
      if (
        (file.sha256 && file.sha256 !== info.sha256) ||
        file.sizeBytes !== info.sizeBytes
      )
        throw new ConflictException("Annotation source hash changed");
      for (const page of info.pages)
        manifest.pages.push({
          ...page,
          id: `${file.id}:${page.pageNumber}`,
          fileId: file.id,
          sha256: info.sha256,
          sizeBytes: info.sizeBytes,
          frame: "UPRIGHT_PIXELS_V1",
          renderDpi: 200,
          mimeType: file.mimeType,
          storageKey: file.storageKey,
        });
      if (manifest.pages.length > MAX_PAGES)
        throw new PayloadTooLargeException("Too many annotation pages");
    }
    return manifest;
  }
  async publicDto(
    manifest: SourceManifest,
    principal: AuthPrincipal,
  ): Promise<AnnotationSourceDto> {
    // Stored annotation snapshots retain provenance after originals become
    // unavailable. Keep that metadata visible without minting fresh capabilities.
    let available = true;
    try {
      await this.assertRetained(this.prisma, manifest, principal);
    } catch (error) {
      if (
        !(
          error instanceof ConflictException ||
          error instanceof NotFoundException
        )
      )
        throw error;
      available = false;
    }
    const urls = new Map<string, string>();
    const pages = [];
    for (const page of manifest.pages) {
      if (available && !urls.has(page.fileId))
        urls.set(
          page.fileId,
          await this.storage.previewUrl(
            page.storageKey,
            `source-${page.fileId}`,
            300,
          ),
        );
      const { storageKey: _key, ...rest } = page;
      void _key;
      pages.push({ ...rest, previewUrl: urls.get(page.fileId) ?? "" });
    }
    return { ...manifest, available, pages };
  }
  async assertRetained(
    tx: Prisma.TransactionClient,
    manifest: SourceManifest,
    principal: AuthPrincipal,
  ): Promise<void> {
    const row = await this.version(
      manifest.documentId,
      manifest.version,
      principal,
      tx,
    );
    this.assertEligible(row);
    const ids = new Set(manifest.pages.map((p) => p.fileId));
    if (
      row.id !== manifest.versionId ||
      !ids.size ||
      ids.size !== row.files.length
    )
      throw new ConflictException("Annotation source was deleted or changed");
    for (const id of ids) {
      const file = row.files.find((f) => f.id === id),
        page = manifest.pages.find((p) => p.fileId === id)!;
      if (
        !file ||
        file.deletedAt ||
        file.storageKey !== page.storageKey ||
        file.sizeBytes !== page.sizeBytes ||
        (file.sha256 && file.sha256 !== page.sha256)
      )
        throw new ConflictException("Annotation source was deleted or changed");
    }
  }
  private assertEligible(
    row: Awaited<ReturnType<AnnotationSourceService["version"]>>,
  ): void {
    const job = row.job;
    const jobEligible =
      job === null ||
      (job?.cleanupPending === false &&
        (["SUCCEEDED", "QUEUED", "RUNNING"].includes(job.status) ||
          (job.status === "FAILED" &&
            (job.errorCode === null || typeof job.errorCode === "string") &&
            job.errorCode !== "UPLOAD_FAILED")));
    if (
      row.cleanupPending !== false ||
      !["IN_REVIEW", "APPROVED", "SIGNED"].includes(row.status) ||
      (row.document.currentVersion !== row.version &&
        !["APPROVED", "SIGNED"].includes(row.status)) ||
      (row.submission !== null && row.submission?.status !== "SUCCEEDED") ||
      !jobEligible ||
      !row.files.length ||
      row.files.some((file) => file.deletedAt !== null)
    )
      throw new ConflictException("Annotation source is unavailable");
  }
  async verifyBytes(
    manifest: SourceManifest,
    principal: AuthPrincipal,
  ): Promise<void> {
    await this.assertRetained(this.prisma, manifest, principal);
    const seen = new Set<string>();
    for (const page of manifest.pages) {
      if (seen.has(page.fileId)) continue;
      seen.add(page.fileId);
      const bytes = await this.storage
        .read(page.storageKey, ANNOTATION_SOURCE_LIMIT)
        .catch(() => {
          throw new ConflictException("Annotation source cannot be read");
        });
      if (
        bytes.length !== page.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== page.sha256
      )
        throw new ConflictException("Annotation source hash changed");
    }
  }
}
