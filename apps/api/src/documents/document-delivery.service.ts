import { CandidatePreviousDocumentsSyncService } from "./candidate-previous-documents-sync.service";
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { DocumentAccessService } from "./document-access.service";
import { DocumentReadService } from "./document-read.service";
import { ManualDocumentService } from "./manual-document.service";
import { DocumentPdfService } from "./document-pdf.service";
import { DocumentUploadService } from "./document-upload.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import {
  sendErpMultipart,
  MAX_DELIVERY_ATTEMPTS,
  nextDeliveryAttempt,
} from "./erp-multipart";
import { erpDocumentHeaders } from "./erp-document-auth";
import { isInvalidFileContent } from "./erp-retry-selection";
import { tryCompleteIgEmployment } from "./ig-completion";
import { isIgRecipient, matchesIgRecipient } from "./ig-recipient";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import type { ErpDeliveryResponse } from "./erp-delivery-response";

@Injectable()
export class DocumentDeliveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private readonly logger = new Logger(DocumentDeliveryService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly access: DocumentAccessService,
    private readonly reads: DocumentReadService,
    private readonly manual: ManualDocumentService,
    private readonly pdf: DocumentPdfService,
    private readonly uploads: DocumentUploadService,
    @Optional() private readonly erp?: ErpWorkspaceClient,
    @Optional() private readonly previousDocs?: CandidatePreviousDocumentsSyncService,
  ) {}
  onModuleInit(): void {
    if (this.config.get<string>("DOCUMENT_WORKER_ENABLED") === "false") return;
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.tick()
        .catch(() =>
          this.logger.warn(
            "Document maintenance unavailable; will resume later",
          ),
        )
        .finally(() => {
          this.active = undefined;
        });
    }, 5000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.active;
  }
  async request(
    documentId: string,
    version: number,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    await this.access.document(documentId, principal);
    const row = await this.prisma.erpDocumentDelivery.findFirst({
      where: { version: { documentId, version, status: "APPROVED" } },
      include: {
        version: { include: { document: { include: { candidate: true } } } },
      },
    });
    if (!row) throw new ConflictException("Document has no ERP delivery");
    // A historic version is never repeated: the document already has a newer
    // current version, and the delivery key of the old one must not be reused.
    if (row.version.document.currentVersion !== version)
      throw new ConflictException("Document version is not current");
    if (row.status === "WAITING_CONTRACT") {
      const candidate = row.version.document.candidate;
      if (!candidate?.code1c || !this.erp || !isIgRecipient(candidate))
        throw new ConflictException("ERP_PERSON_IDENTITY_UNAVAILABLE");
      const identity = await this.erp
        .identity(candidate.code1c)
        .catch(() => undefined);
      if (!matchesIgRecipient(candidate, identity))
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${candidate.id} FOR UPDATE`;
        const current = await tx.erpDocumentDelivery.findUnique({
          where: { id: row.id },
          include: {
            version: {
              include: { document: { include: { candidate: true } } },
            },
          },
        });
        const doc = current?.version.document;
        if (
          !current ||
          current.status !== "WAITING_CONTRACT" ||
          current.transport !== "multipart-v2" ||
          !doc ||
          current.version.status !== "APPROVED" ||
          doc.currentVersion !== version ||
          !doc.candidate ||
          !matchesIgRecipient(doc.candidate, identity) ||
          !(await tx.document.findFirst({
            where: {
              id: documentId,
              ...this.access.documentReviewWhere(principal),
            },
          }))
        )
          throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
        const payload = current.payload as Prisma.JsonObject;
        if (
          typeof payload.documentUid !== "string" ||
          !payload.documentUid ||
          payload.recipientType ||
          payload.personUid ||
          payload.code1c ||
          payload.chatUid
        )
          throw new ConflictException("ERP_DELIVERY_CONTRACT_INVALID");
        const changed = await tx.erpDocumentDelivery.updateMany({
          where: { id: row.id, status: "WAITING_CONTRACT" },
          data: {
            status: "PENDING",
            errorCode: null,
            payload: {
              ...payload,
              recipientType: "person",
              personUid: identity!.personUid!,
              code1c: identity!.code1C,
            },
          },
        });
        if (changed.count !== 1)
          throw new ConflictException("ERP delivery has changed");
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: "DOCUMENT_ERP_SEND_REQUESTED",
          entityType: "Document",
          entityId: documentId,
          correlationId,
          after: { version, reason: "ERP_PERSON_IDENTITY_REPAIRED" },
        });
      });
    }
    await this.repairArtifact(row.id);
    await this.send(row.id, principal.uuid, correlationId, principal);
    return this.reads.version(documentId, version);
  }
  /**
   * Rebuilds the approved artifact of a version whose delivery was rejected
   * because of an invalid file container. Only a one-file JPEG with a
   * removable trailer is rebuilt; any other document keeps its artifact and is
   * repeated as is. Failures are logged, never thrown: the repeated delivery
   * reports the real problem.
   */
  async repairArtifact(deliveryId: string): Promise<boolean> {
    try {
      const row = await this.prisma.erpDocumentDelivery.findUnique({
        where: { id: deliveryId },
        include: {
          attempts: { orderBy: { startedAt: "desc" }, take: 1 },
        },
      });
      if (!row) return false;
      const attempt = row.attempts[0];
      if (
        !isInvalidFileContent(row.errorCode, attempt?.responseBody ?? null)
      )
        return false;
      const artifact = await this.pdf.reprepareCanonical(row.versionId);
      if (!artifact) return false;
      this.logger.log(
        `Approved artifact rebuilt for delivery ${deliveryId} (${artifact.sizeBytes} bytes)`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Approved artifact rebuild failed for delivery ${deliveryId}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
      return false;
    }
  }
  async send(
    id: string,
    actorId = "document-worker",
    correlationId = "",
    principal?: AuthPrincipal,
  ): Promise<void> {
    const token = randomUUID();
    const v2Timeout = Number(
      this.config.get("ERP_DOCUMENTS_V2_TIMEOUT_MS") ?? 300000,
    );
    const attempt = await this.prisma.$transaction(async (tx) => {
      const row = await tx.erpDocumentDelivery.findUniqueOrThrow({
        where: { id },
        include: { version: { include: { fields: true, submission: true } } },
      });
      if (principal) {
        const doc = await tx.document.findUniqueOrThrow({
          where: { id: row.version.documentId },
        });
        if (doc.candidateId)
          await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${doc.candidateId} FOR UPDATE`;
        if (
          !(await tx.document.findFirst({
            where: {
              id: doc.id,
              ...this.access.documentReviewWhere(principal),
            },
          }))
        )
          throw new ConflictException("Document access has changed");
      }
      if (row.transport !== "multipart-v2")
        throw new ConflictException(
          "Legacy ERP delivery requires manual reconciliation",
        );
      if (!["PENDING", "REQUIRES_MANUAL"].includes(row.status))
        throw new ConflictException(
          "ERP delivery is unavailable or already being sent",
        );
      if (!principal && row.nextAttemptAt && row.nextAttemptAt > new Date())
        throw new ConflictException("ERP retry is not due");
      const changed = await tx.erpDocumentDelivery.updateMany({
        where: { id, status: row.status },
        data: {
          status: "SENDING",
          leaseToken: token,
          leaseUntil: new Date(Date.now() + v2Timeout + 60000),
          attemptCount: { increment: 1 },
          nextAttemptAt: null,
          errorCode: null,
        },
      });
      if (!changed.count)
        throw new ConflictException("ERP delivery has changed");
      const record = await tx.erpDocumentAttempt.create({
        data: { deliveryId: id, actorId },
      });
      await this.audit.logInTransaction(tx, {
        actorId,
        action: "DOCUMENT_ERP_SEND_REQUESTED",
        entityType: "Document",
        entityId: row.version.documentId,
        correlationId,
        after: { version: row.version.version, attemptId: record.id },
      });
      return { row, record };
    });
    let errorCode: string | null = null;
    let erpResponse: ErpDeliveryResponse | null = null;
    let retryable = false;
    try {
      const secret = this.config.get<string>("ERP_DOCUMENTS_TOKEN");
      if (!secret) throw new Error("ERP_NOT_CONFIGURED");
      if (!attempt.row.version.approvedStorageKey)
        throw new Error("APPROVED_PDF_UNAVAILABLE");
      {
        const version = attempt.row.version;
        const payload = attempt.row.payload as Prisma.JsonObject;
        if (
          !version.approvedMimeType ||
          !version.approvedExtension ||
          !version.approvedFilename ||
          !version.approvedSizeBytes ||
          !version.approvedSha256
        )
          throw new Error("APPROVED_ARTIFACT_INVALID");
        const result = await sendErpMultipart({
          storage: this.storage,
          artifact: {
            key: version.approvedStorageKey!,
            mimeType: version.approvedMimeType,
            extension: version.approvedExtension,
            filename: version.approvedFilename,
            sizeBytes: version.approvedSizeBytes,
            sha256: version.approvedSha256,
          },
          metadata: {
            documentUid: String(payload.documentUid),
            ...(typeof payload.chatUid === "string"
              ? { chatUid: payload.chatUid }
              : {}),
            ...(typeof payload.candidateUid === "string"
              ? { candidateUid: payload.candidateUid }
              : {}),
            ...(payload.recipientType === "person"
              ? {
                  recipientType: "person" as const,
                  personUid: String(payload.personUid),
                  code1c: String(payload.code1c),
                }
              : {}),
            documentFields: payload.documentFields as object,
          },
          deliveryId: id,
          url: new URL(
            "candidate-documents-v2",
            this.config.get<string>("ERP_DOCUMENTS_BASE_URL"),
          ),
          headers: erpDocumentHeaders(this.config),
          signal: AbortSignal.timeout(v2Timeout),
        });
        erpResponse = result.diagnostic;
        errorCode = result.errorCode;
        retryable = result.retryable;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      errorCode =
        /^(ERP_NOT_CONFIGURED|APPROVED_PDF_UNAVAILABLE|APPROVED_ARTIFACT_[A-Z_]+|ERP_METADATA_TOO_LARGE|ERP_MULTIPART_TOO_LARGE|ERP_HTTP_\d{3})$/.test(
          message,
        )
          ? message
          : "ERP_DELIVERY_UNCONFIRMED";
      retryable = errorCode === "ERP_DELIVERY_UNCONFIRMED";
    }
    const nextAttemptAt =
      errorCode &&
      retryable &&
      this.config.get("ERP_DOCUMENTS_V2_AUTO_RETRY") === "true" &&
      (attempt.row.attemptCount ?? 0) + 1 < MAX_DELIVERY_ATTEMPTS
        ? nextDeliveryAttempt((attempt.row.attemptCount ?? 0) + 1)
        : null;
    const status = errorCode
      ? nextAttemptAt
        ? "PENDING"
        : "REQUIRES_MANUAL"
      : "SENT";
    await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.findUnique({
        where: { id: attempt.row.version.documentId },
        select: {
          candidateId: true,
          candidate: {
            select: {
              chatUuid: true,
              citizenship: true,
              reviewGroup: true,
              code1c: true,
              personUid: true,
            },
          },
        },
      });
      if (doc?.candidateId)
        await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${doc.candidateId} FOR UPDATE`;
      const changed = await tx.erpDocumentDelivery.updateMany({
        where: { id, status: "SENDING", leaseToken: token },
        data: {
          status,
          nextAttemptAt,
          errorCode,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      if (!changed.count) return;
      await tx.erpDocumentAttempt.update({
        where: { id: attempt.record.id },
        data: {
          finishedAt: new Date(),
          errorCode,
          receiptValidated: status === "SENT",
          ...(erpResponse ?? {}),
        },
      });
      if (
        status === "SENT" &&
        doc?.candidateId &&
        doc.candidate &&
        isIgRecipient(doc.candidate)
      )
        await tryCompleteIgEmployment(
          tx,
          this.audit,
          doc.candidateId,
          actorId,
          correlationId,
        );
      await this.audit.logInTransaction(tx, {
        actorId,
        action: "DOCUMENT_ERP_SEND_COMPLETED",
        entityType: "Document",
        entityId: attempt.row.version.documentId,
        correlationId,
        after: {
          version: attempt.row.version.version,
          status,
          nextAttemptAt,
          errorCode,
          httpStatus: erpResponse?.httpStatus ?? null,
          responseTruncated: erpResponse?.responseTruncated ?? false,
          responseReadError: erpResponse?.responseReadError ?? null,
        },
      });
    });
    if (status === "SENT" && this.previousDocs && attempt.row.version.submission?.origin === "REVIEWER") {
      const owner = await this.prisma.document.findUnique({ where: { id: attempt.row.version.documentId }, select: { candidateId: true } });
      if (owner?.candidateId) {
        try { await this.previousDocs.syncPreviousDocuments(owner.candidateId, actorId, correlationId); }
        catch { this.logger.warn("Delivered document history refresh deferred"); }
      }
    }
  }
  async tick(): Promise<void> {
    const expired = await this.prisma.erpDocumentDelivery.findMany({
      where: { status: "SENDING", leaseUntil: { lt: new Date() } },
      include: { version: true },
      take: 20,
    });
    for (const row of expired) {
      const nextAttemptAt =
        row.transport === "multipart-v2" &&
        this.config.get("ERP_DOCUMENTS_V2_AUTO_RETRY") === "true" &&
        row.attemptCount < MAX_DELIVERY_ATTEMPTS
          ? nextDeliveryAttempt(row.attemptCount)
          : null;
      const status = nextAttemptAt ? "PENDING" : "REQUIRES_MANUAL";
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.erpDocumentDelivery.updateMany({
          where: { id: row.id, leaseToken: row.leaseToken, status: "SENDING" },
          data: {
            status,
            nextAttemptAt,
            errorCode: "ERP_DELIVERY_UNCONFIRMED",
            leaseToken: null,
            leaseUntil: null,
          },
        });
        if (changed.count) {
          await tx.erpDocumentAttempt.updateMany({
            where: { deliveryId: row.id, finishedAt: null },
            data: {
              finishedAt: new Date(),
              errorCode: "ERP_DELIVERY_UNCONFIRMED",
            },
          });
          await this.audit.logInTransaction(tx, {
            actorId: "document-worker",
            action: "DOCUMENT_ERP_SEND_COMPLETED",
            entityType: "Document",
            entityId: row.version.documentId,
            after: {
              version: row.version.version,
              status,
              nextAttemptAt,
              errorCode: "ERP_DELIVERY_UNCONFIRMED",
            },
          });
        }
      });
    }
    // Disabling retries also parks already-scheduled repeats. Initial PENDING
    // deliveries (attemptCount = 0) and explicit manual requests remain available.
    if (this.config.get("ERP_DOCUMENTS_V2_AUTO_RETRY") !== "true") {
      const scheduled = await this.prisma.erpDocumentDelivery.findMany({
        where: {
          status: "PENDING",
          transport: "multipart-v2",
          attemptCount: { gt: 0 },
        },
        include: { version: true },
        take: 20,
      });
      for (const row of scheduled)
        await this.prisma.$transaction(async (tx) => {
          const changed = await tx.erpDocumentDelivery.updateMany({
            where: {
              id: row.id,
              status: "PENDING",
              attemptCount: row.attemptCount,
            },
            data: { status: "REQUIRES_MANUAL", nextAttemptAt: null },
          });
          if (changed.count)
            await this.audit.logInTransaction(tx, {
              actorId: "document-worker",
              action: "DOCUMENT_ERP_SEND_COMPLETED",
              entityType: "Document",
              entityId: row.version.documentId,
              after: {
                version: row.version.version,
                status: "REQUIRES_MANUAL",
                reason: "AUTO_RETRY_DISABLED",
              },
            });
        });
    }
    // Historical v1 attempts cannot be replayed against the removed ERP endpoint.
    const legacy = await this.prisma.erpDocumentDelivery.findMany({
      where: { status: "PENDING", transport: "base64-v1" },
      include: { version: true },
      take: 20,
    });
    for (const row of legacy)
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.erpDocumentDelivery.updateMany({
          where: { id: row.id, status: "PENDING", transport: "base64-v1" },
          data: {
            status: "REQUIRES_MANUAL",
            nextAttemptAt: null,
            errorCode: "ERP_V1_RETIRED",
          },
        });
        if (changed.count)
          await this.audit.logInTransaction(tx, {
            actorId: "document-worker",
            action: "DOCUMENT_ERP_SEND_COMPLETED",
            entityType: "Document",
            entityId: row.version.documentId,
            after: {
              version: row.version.version,
              status: "REQUIRES_MANUAL",
              reason: "ERP_V1_RETIRED",
            },
          });
      });
    for (const row of await this.prisma.documentSubmission.findMany({
      where: { status: "UPLOADING", leaseUntil: { lt: new Date() } },
      take: 20,
    }))
      await this.manual.fail(row.id);
    for (const row of await this.prisma.documentVersion.findMany({
      where: {
        pendingApprovalStorageKey: { not: null },
        approvalLeaseUntil: { lt: new Date() },
      },
      take: 20,
    }))
      await this.pdf.discard(row.id, row.pendingApprovalStorageKey!);
    for (const row of await this.prisma.documentVersion.findMany({
      where: { cleanupPending: true, approvedStorageKey: null },
      include: { files: true },
      take: 20,
    })) {
      for (const file of row.files) {
        const activeRefs = await this.prisma.documentVersionFile.count({
          where: {
            storageKey: file.storageKey,
            id: { not: file.id },
            deletedAt: null,
          },
        });
        if (activeRefs === 0) {
          await this.storage.delete(file.storageKey);
        }
        await this.prisma.documentVersionFile.update({
          where: { id: file.id },
          data: { deletedAt: new Date() },
        });
      }
      await this.prisma.documentVersion.update({
        where: { id: row.id },
        data: { cleanupPending: false },
      });
    }
    await this.uploads.cleanupCache();
    for (const row of await this.prisma.erpDocumentDelivery.findMany({
      where: {
        status: "PENDING",
        transport: "multipart-v2",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      take: 5,
      orderBy: { createdAt: "asc" },
    })) {
      try {
        await this.send(row.id);
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
      }
    }
    await this.prisma.documentStreamGrant.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }
}
