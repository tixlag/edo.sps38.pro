import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { OcrService } from "../ocr/ocr.service";
import type { StagedUpload } from "./document-upload.service";
import type { UploadAcceptedDto } from "./dto/document.dto";
import { DocumentReadService } from "./document-read.service";

@Injectable()
export class DocumentIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ocr: OcrService,
    private readonly audit: AuditService,
    private readonly reads: DocumentReadService,
  ) {}

  ensureAvailable(): void {
    if (!this.ocr.isAvailable())
      throw new ServiceUnavailableException("OCR_NOT_CONFIGURED");
  }

  async upload(
    chatUuid: string,
    key: string | undefined,
    upload: StagedUpload,
    correlationId: string,
  ): Promise<UploadAcceptedDto> {
    this.ensureAvailable();
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException(
        "Idempotency-Key is required (1–128 printable ASCII characters)",
      );
    const type = await this.prisma.documentType.findUnique({
      where: { code: upload.documentTypeCode },
    });
    if (!type) throw new BadRequestException("Unknown documentTypeCode");
    if (
      upload.locationId !== undefined &&
      !(await this.prisma.lkLocation.findFirst({
        where: { locationId: upload.locationId, deleted: false },
      }))
    ) {
      throw new BadRequestException("Unknown or deleted locationId");
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          type: type.code,
          locationId: upload.locationId ?? null,
          files: upload.files.map(
            ({ filename, mimeType, sha256, pageCount }) => ({
              filename,
              mimeType,
              sha256,
              pageCount,
            }),
          ),
        }),
      )
      .digest("hex");
    const correlation = correlationId.slice(0, 64);
    const token = randomUUID();
    const reserved = await this.reserve(
      chatUuid,
      key,
      fingerprint,
      type.id,
      upload,
      correlation,
      token,
    );
    if (reserved.reused) {
      if (reserved.job.status === "UPLOADING")
        throw new ConflictException(
          "Upload is still in progress; retry this Idempotency-Key later",
        );
      if (reserved.job.errorCode === "UPLOAD_FAILED")
        throw new ConflictException(
          "Upload failed; submit again with a new Idempotency-Key",
        );
      return reserved.accepted;
    }
    const signal = AbortSignal.timeout(120_000);
    try {
      for (const file of reserved.files) {
        const staged = upload.files[file.ordinal];
        await this.storage.upload(
          file.storageKey,
          staged.path,
          staged.mimeType,
          staged.sizeBytes,
          signal,
        );
      }
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.ocrJob.updateMany({
          where: {
            id: reserved.job.id,
            status: "UPLOADING",
            leaseToken: token,
          },
          data: { status: "QUEUED", leaseToken: null, leaseUntil: null },
        });
        if (changed.count !== 1)
          throw new ConflictException("Upload lease expired");
        await tx.documentVersion.update({
          where: { id: reserved.job.versionId },
          data: { status: "OCR_PENDING" },
        });
        await tx.document.updateMany({
          where: {
            id: reserved.accepted.documentId,
            currentVersion: { lt: reserved.accepted.version },
          },
          data: {
            currentVersion: reserved.accepted.version,
            status: "OCR_PENDING",
          },
        });
        await tx.ocrOutbox.create({ data: { jobId: reserved.job.id } });
        await this.audit.logInTransaction(tx, {
          actorId: "lk-service",
          action: "DOCUMENT_UPLOADED",
          entityType: "Document",
          entityId: reserved.accepted.documentId,
          correlationId: correlation,
          after: {
            version: reserved.accepted.version,
            jobId: reserved.job.id,
            fileCount: reserved.files.length,
          },
        });
      });
      return reserved.accepted;
    } catch {
      await this.failUpload(reserved.job.id, token, correlation);
      throw new ServiceUnavailableException("UPLOAD_FAILED");
    }
  }

  private async reserve(
    chatUuid: string,
    key: string,
    fingerprint: string,
    typeId: string,
    upload: StagedUpload,
    correlationId: string,
    token: string,
  ) {
    // Prisma's emulated upsert can race on a new chat; retry only DB uniqueness/deadlock conflicts.
    for (let retry = 0; ; retry++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const candidate = await tx.candidate.upsert({
            where: { chatUuid },
            update: {},
            create: { chatUuid, locationId: upload.locationId ?? null },
          });
          await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${candidate.id} FOR UPDATE`;
          const existing = await tx.ocrJob.findUnique({
            where: {
              candidateId_idempotencyKey: {
                candidateId: candidate.id,
                idempotencyKey: key,
              },
            },
            include: { version: true },
          });
          if (existing) {
            if (existing.fingerprint !== fingerprint)
              throw new ConflictException(
                "Idempotency-Key already used with different content",
              );
            return {
              reused: true,
              job: existing,
              files: [],
              accepted: {
                candidateId: candidate.id,
                documentId: existing.version.documentId,
                version: existing.version.version,
                jobId: existing.id,
              },
            };
          }
          if (
            upload.locationId !== undefined &&
            candidate.locationId !== upload.locationId
          ) {
            await tx.candidate.update({
              where: { id: candidate.id },
              data: { locationId: upload.locationId },
            });
          }
          const doc = await tx.document.upsert({
            where: {
              candidateId_documentTypeId: {
                candidateId: candidate.id,
                documentTypeId: typeId,
              },
            },
            update: {},
            create: {
              candidateId: candidate.id,
              documentTypeId: typeId,
              currentVersion: 0,
            },
          });
          const last = await tx.documentVersion.aggregate({
            where: { documentId: doc.id },
            _max: { version: true },
          });
          const number = (last._max.version ?? 0) + 1;
          const files = upload.files.map((f) => ({
            id: f.id,
            ordinal: f.ordinal,
            storageKey: this.storage.keyFor(doc.id, number, f.id),
            filename: f.filename,
            mimeType: f.mimeType,
            sizeBytes: f.sizeBytes,
            sha256: f.sha256,
            pageCount: f.pageCount,
          }));
          const version = await tx.documentVersion.create({
            data: {
              documentId: doc.id,
              version: number,
              status: "UPLOADED",
              storageKey: files[0].storageKey,
              files: { create: files },
            },
          });
          const job = await tx.ocrJob.create({
            data: {
              candidateId: candidate.id,
              versionId: version.id,
              idempotencyKey: key,
              fingerprint,
              leaseToken: token,
              leaseUntil: new Date(Date.now() + 600_000),
              correlationId,
            },
          });
          await this.audit.logInTransaction(tx, {
            actorId: "lk-service",
            action: "DOCUMENT_UPLOAD_STARTED",
            entityType: "Document",
            entityId: doc.id,
            correlationId,
            after: {
              version: number,
              jobId: job.id,
              candidateId: candidate.id,
            },
          });
          return {
            reused: false,
            job,
            files,
            accepted: {
              candidateId: candidate.id,
              documentId: doc.id,
              version: number,
              jobId: job.id,
            },
          };
        });
      } catch (error) {
        if (
          retry < 2 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2034"].includes(error.code)
        )
          continue;
        throw error;
      }
    }
  }

  async failUpload(
    jobId: string,
    token: string,
    correlationId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.ocrJob.findUnique({
        where: { id: jobId },
        include: { version: true },
      });
      if (!job) return;
      const changed = await tx.ocrJob.updateMany({
        where: { id: jobId, status: "UPLOADING", leaseToken: token },
        data: {
          status: "FAILED",
          errorCode: "UPLOAD_FAILED",
          cleanupPending: true,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      if (!changed.count) return;
      await tx.documentVersion.update({
        where: { id: job.versionId },
        data: { status: "OCR_FAILED" },
      });
      await this.audit.logInTransaction(tx, {
        action: "DOCUMENT_OCR_COMPLETED",
        entityType: "Document",
        entityId: job.version.documentId,
        correlationId,
        after: { version: job.version.version, errorCode: "UPLOAD_FAILED" },
      });
    });
  }

  async link(chatUuid: string, code1c: string, correlationId: string) {
    const candidate = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE chatUuid = ${chatUuid} FOR UPDATE`;
      const row = await tx.candidate.findUnique({ where: { chatUuid } });
      if (!row) throw new NotFoundException("Candidate not found");
      if (row.code1c && row.code1c !== code1c)
        throw new ConflictException(
          "Candidate already linked to another code1c",
        );
      if (row.code1c === code1c) return row;
      const updated = await tx.candidate.update({
        where: { id: row.id },
        data: { code1c },
      });
      await this.audit.logInTransaction(tx, {
        actorId: "lk-service",
        action: "CANDIDATE_LINKED",
        entityType: "Candidate",
        entityId: row.id,
        correlationId: correlationId.slice(0, 64),
        before: { code1c: row.code1c },
        after: { code1c },
      });
      return updated;
    });
    return this.reads.candidateDto(candidate);
  }
}
