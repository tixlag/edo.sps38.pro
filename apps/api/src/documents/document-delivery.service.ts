import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
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
import { formatDateForErp, shouldOmitPositionUid } from "./document-contract";
import {
  captureErpDeliveryResponse,
  type ErpDeliveryResponse,
} from "./erp-delivery-response";

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
    });
    if (!row) throw new ConflictException("Document has no ERP delivery");
    await this.send(row.id, principal.uuid, correlationId, principal);
    return this.reads.version(documentId, version);
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
        include: { version: { include: { fields: true } } },
      });
      if (principal) {
        const doc = await tx.document.findUniqueOrThrow({
          where: { id: row.version.documentId },
        });
        if (doc.candidateId)
          await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${doc.candidateId} FOR UPDATE`;
        if (
          !(await tx.document.findFirst({
            where: { id: doc.id, ...this.access.documentWhere(principal) },
          }))
        )
          throw new ConflictException("Document access has changed");
      }
      if (
        row.transport &&
        !["base64-v1", "multipart-v2"].includes(row.transport)
      )
        throw new ConflictException("ERP transport is unsupported");
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
          leaseUntil: new Date(
            Date.now() +
              (row.transport === "multipart-v2" ? v2Timeout + 60000 : 180000),
          ),
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
    const v2 = attempt.row.transport === "multipart-v2";
    try {
      const secret = this.config.get<string>("ERP_DOCUMENTS_TOKEN");
      if (!secret) throw new Error("ERP_NOT_CONFIGURED");
      if (!attempt.row.version.approvedStorageKey)
        throw new Error("APPROVED_PDF_UNAVAILABLE");
      if (v2) {
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
            chatUid: String(payload.chatUid),
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
      } else {
        const bytes = await this.storage.read(
          attempt.row.version.approvedStorageKey,
        );
        const payload = { ...(attempt.row.payload as Prisma.JsonObject) };
        const fields = payload.documentFields;
        if (fields && typeof fields === "object" && !Array.isArray(fields)) {
          const documentFields = { ...fields };
          for (const field of attempt.row.version.fields) {
            const value = documentFields[field.name];
            if (field.kind === "date" && typeof value === "string")
              documentFields[field.name] = formatDateForErp(value);
          }
          if (
            shouldOmitPositionUid(
              documentFields.positionUid,
              attempt.row.version.positionCode1c,
            )
          )
            delete documentFields.positionUid;
          payload.documentFields = documentFields;
        }
        const response = await fetch(
          new URL(
            "candidate-documents",
            this.config.get<string>("ERP_DOCUMENTS_BASE_URL"),
          ),
          {
            method: "POST",
            redirect: "error",
            headers: {
              ...erpDocumentHeaders(this.config),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...payload,
              fileExtension: "pdf",
              fileBase64: bytes.toString("base64"),
            }),
            signal: AbortSignal.timeout(60000),
          },
        );
        const username = this.config.get<string>("ERP_USERNAME") ?? "";
        const password = this.config.get<string>("ERP_PASSWORD") ?? "";
        erpResponse = await captureErpDeliveryResponse(response, [
          secret,
          username,
          password,
          Buffer.from(`${username}:${password}`).toString("base64"),
        ]);
        if (!response.ok) throw new Error(`ERP_HTTP_${response.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      errorCode =
        /^(ERP_NOT_CONFIGURED|APPROVED_PDF_UNAVAILABLE|APPROVED_ARTIFACT_[A-Z_]+|ERP_METADATA_TOO_LARGE|ERP_MULTIPART_TOO_LARGE|ERP_HTTP_\d{3})$/.test(
          message,
        )
          ? message
          : "ERP_DELIVERY_UNCONFIRMED";
      retryable = v2 && errorCode === "ERP_DELIVERY_UNCONFIRMED";
    }
    const nextAttemptAt =
      errorCode &&
      retryable &&
      v2 &&
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
        data: { finishedAt: new Date(), errorCode, ...(erpResponse ?? {}) },
      });
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
        await this.storage.delete(file.storageKey);
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
