import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import type { AuthPrincipal } from "../auth/auth-principal";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  canRetryDocumentOcr,
  canStartDocumentOcr,
} from "../ocr/ocr-retry-policy";
import { DocumentAccessService } from "./document-access.service";
import { DocumentReadService } from "./document-read.service";

@Injectable()
export class DocumentOcrRetryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
    private readonly reads: DocumentReadService,
    private readonly config: ConfigService,
  ) {}

  async retry(
    documentId: string,
    number: number,
    revision: number,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    return this.enqueue(
      documentId,
      number,
      revision,
      principal,
      correlationId,
      "retry",
    );
  }

  async start(
    documentId: string,
    number: number,
    revision: number,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    return this.enqueue(
      documentId,
      number,
      revision,
      principal,
      correlationId,
      "start",
    );
  }

  private async enqueue(
    documentId: string,
    number: number,
    revision: number,
    principal: AuthPrincipal,
    correlationId: string,
    action: "start" | "retry",
  ) {
    await this.prisma.$transaction(async (tx) => {
      const initial = await tx.document.findUnique({
        where: { id: documentId },
      });
      if (initial?.candidateId)
        await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${initial.candidateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`;
      const doc = await tx.document.findFirst({
        where: { id: documentId, ...this.access.documentReviewWhere(principal) },
      });
      if (!doc) throw new NotFoundException("Document not found");
      if (
        this.config.get("OCR_MODE") !== "external" ||
        this.config.get("OCR_WORKER_ENABLED") === "false"
      )
        throw new ServiceUnavailableException("OCR_NOT_CONFIGURED");
      const version = await tx.documentVersion.findUnique({
        where: { documentId_version: { documentId, version: number } },
        include: {
          document: { include: { documentType: true } },
          job: true,
          files: true,
          submission: true,
        },
      });
      if (
        !version ||
        version.revision !== revision ||
        !(action === "start"
          ? canStartDocumentOcr(version, true)
          : canRetryDocumentOcr(version, true))
      )
        throw new ConflictException(
          "OCR action is unavailable for this version",
        );
      const previous = version.job;
      const job =
        action === "start"
          ? await tx.ocrJob.create({
              data: {
                versionId: version.id,
                candidateId: version.document.candidateId!,
                idempotencyKey: `submission:${version.submission!.id}`,
                fingerprint: version.submission!.fingerprint,
                correlationId,
                status: "QUEUED",
              },
            })
          : version.job!;
      // Reuse a failed job so duplicate RabbitMQ deliveries still claim only
      // one attempt through its lease. Initial starts create it under the lock.
      if (action === "retry") {
        const changed = await tx.ocrJob.updateMany({
          where: { id: job.id, status: job.status, cleanupPending: false },
          data: {
            status: "QUEUED",
            attempts: 0,
            errorCode: null,
            leaseToken: null,
            leaseUntil: null,
            correlationId,
          },
        });
        if (changed.count !== 1)
          throw new ConflictException("OCR job has changed");
      }
      const status = version.submission ? "IN_REVIEW" : "OCR_PENDING";
      await tx.documentVersion.update({
        where: { id: version.id },
        data: {
          status,
          revision: { increment: 1 },
          ocrRaw: Prisma.DbNull,
          ocrSource: null,
        },
      });
      await tx.document.update({ where: { id: documentId }, data: { status } });
      await tx.ocrIssue.deleteMany({ where: { versionId: version.id } });
      if (action === "retry") {
        await tx.ocrRegion.deleteMany({
          where: { file: { versionId: version.id } },
        });
        await tx.documentVersionField.updateMany({
          where: { versionId: version.id },
          data: { originalValue: null, ocrText: null },
        });
      }
      await tx.documentVersionOcrField.deleteMany({
        where: { versionId: version.id },
      });
      const dispatch = {
        availableAt: new Date(),
        publishedAt: null,
        leaseToken: null,
        leaseUntil: null,
      };
      await tx.ocrOutbox.upsert({
        where: { jobId: job.id },
        create: { jobId: job.id, ...dispatch },
        update: dispatch,
      });
      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action:
          action === "start"
            ? "DOCUMENT_OCR_REQUESTED"
            : "DOCUMENT_OCR_RETRIED",
        entityType: "Document",
        entityId: documentId,
        correlationId,
        before: {
          version: number,
          status: previous?.status ?? null,
          errorCode: previous?.errorCode ?? null,
          attempts: previous?.attempts ?? 0,
        },
        after: { version: number, jobId: job.id, status: "QUEUED" },
      });
    });
    return this.reads.version(documentId, number);
  }
}
