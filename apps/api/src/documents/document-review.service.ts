import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { DocumentAccessService } from "./document-access.service";
import { DocumentReadService } from "./document-read.service";
import type { ApprovedArtifact } from "./approved-artifact";
import { DocumentPdfService } from "./document-pdf.service";
import { IG_PASSPORT_LATIN_FIELDS, isForeignPassport } from "./review-group";
import { ErpWorkspaceClient, type ErpIdentity } from "./erp-workspace.client";
import { isIgRecipient, matchesIgRecipient } from "./ig-recipient";
import { DocumentExpirationService } from "../expiration/document-expiration.service";
import {
  formatDateForErp,
  shouldOmitPositionUid,
  textValue,
  typedValue,
  validateFields,
} from "./document-contract";

const editsSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .refine((v) => !["__proto__", "constructor", "prototype"].includes(v)),
    z.union([z.string().max(16_384), z.boolean()]).nullable(),
  )
  .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 200);

@Injectable()
export class DocumentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
    private readonly reads: DocumentReadService,
    private readonly pdf: DocumentPdfService,
    @Optional() private readonly erp?: ErpWorkspaceClient,
    @Optional() private readonly expiration?: DocumentExpirationService,
  ) {}

  async edit(
    documentId: string,
    number: number,
    revision: number,
    fields: unknown,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    const parsed = editsSchema.safeParse(fields);
    if (!parsed.success)
      throw new BadRequestException("Invalid document fields");
    return this.change(
      documentId,
      number,
      revision,
      principal,
      correlationId,
      parsed.data,
    );
  }

  async approve(
    documentId: string,
    number: number,
    revision: number,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    await this.access.document(documentId, principal);
    const version = await this.prisma.documentVersion.findUnique({
      where: { documentId_version: { documentId, version: number } },
      include: {
        fields: true,
        submission: true,
        document: { include: { candidate: true } },
      },
    });
    if (
      !version ||
      version.status !== "IN_REVIEW" ||
      version.revision !== revision
    )
      throw new ConflictException("Document version or revision has changed");
    if (!version.submission)
      return this.change(
        documentId,
        number,
        revision,
        principal,
        correlationId,
      );
    validateFields(
      version.fields,
      Object.fromEntries(
        version.fields.map((f) => [f.name, typedValue(f.value, f.kind)]),
      ),
    );
    let identity: ErpIdentity | undefined;
    const candidate = version.document?.candidate;
    if (candidate && isIgRecipient(candidate) && candidate.code1c) {
      try {
        identity = await this.erp?.identity(candidate.code1c);
      } catch {
        /* park delivery until identity is available */
      }
    }
    const artifact = await this.pdf.prepare(version.id, revision);
    const key = artifact.key;
    try {
      await this.change(
        documentId,
        number,
        revision,
        principal,
        correlationId,
        undefined,
        artifact,
        undefined,
        identity,
      );
    } catch (error) {
      const current = await this.prisma.documentVersion.findUnique({
        where: { id: version.id },
      });
      if (current?.approvedStorageKey !== key)
        await this.pdf.discard(version.id, key);
      throw error;
    }
    return this.reads.version(documentId, number);
  }

  async reject(
    documentId: string,
    number: number,
    revision: number,
    reason: string,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    return this.change(
      documentId,
      number,
      revision,
      principal,
      correlationId,
      undefined,
      undefined,
      reason,
    );
  }

  private async change(
    documentId: string,
    number: number,
    revision: number,
    principal: AuthPrincipal,
    correlationId: string,
    edits?: Record<string, string | boolean | null>,
    artifact?: ApprovedArtifact,
    rejectionReason?: string,
    identity?: ErpIdentity,
  ) {
    const approvedKey = artifact?.key;
    await this.prisma.$transaction(
      async (tx) => {
        // Lock candidate first, matching ingestion's lock order. Recheck scope inside the transaction.
        const initial = await tx.document.findUnique({
          where: { id: documentId },
        });
        if (initial?.candidateId)
          await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${initial.candidateId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`;
        const doc = await tx.document.findFirst({
          where: {
            id: documentId,
            ...this.access.documentReviewWhere(principal),
          },
        });
        if (!doc) {
          // Reuse the same 404 for inaccessible documents.
          throw new NotFoundException("Document not found");
        }
        const version = await tx.documentVersion.findUnique({
          where: { documentId_version: { documentId, version: number } },
          include: {
            fields: true,
            submission: true,
            job: true,
            document: { include: { documentType: true, candidate: true } },
          },
        });
        if (
          !version ||
          doc.currentVersion !== number ||
          version.status !== "IN_REVIEW" ||
          version.revision !== revision
        ) {
          throw new ConflictException(
            "Document version or review revision has changed",
          );
        }
        if (
          approvedKey &&
          (version.pendingApprovalStorageKey !== approvedKey ||
            !version.approvalLeaseUntil ||
            version.approvalLeaseUntil <= new Date())
        )
          throw new ConflictException("Approval lease expired");
        if (edits && version.submission) {
          const definitions = isForeignPassport(version.document)
            ? [
                ...version.fields,
                ...["number", ...IG_PASSPORT_LATIN_FIELDS]
                  .filter(
                    (name) =>
                      !version.fields.some((field) => field.name === name),
                  )
                  .map((name) => ({
                    name,
                    kind: "text",
                    required: name === "number",
                    ordinal: 0,
                  })),
              ]
            : version.fields;
          validateFields(definitions, edits);
        }
        if (
          !edits &&
          !rejectionReason &&
          version.document &&
          isForeignPassport(version.document) &&
          !version.fields
            .find((field) => field.name === "number")
            ?.value?.trim()
        ) {
          throw new BadRequestException("Номер паспорта обязателен");
        }
        const reviewedAt = new Date();
        const changed = await tx.documentVersion.updateMany({
          where: {
            id: version.id,
            revision,
            status: "IN_REVIEW",
            ...(approvedKey
              ? {
                  pendingApprovalStorageKey: approvedKey,
                  approvalLeaseUntil: { gt: new Date() },
                  approvedStorageKey: null,
                }
              : {}),
          },
          data: {
            revision: { increment: 1 },
            ...(edits
              ? {}
              : {
                  status: rejectionReason ? "RETURNED" : "APPROVED",
                  reviewedAt,
                  reviewedBy: principal.uuid,
                  ...(rejectionReason
                    ? { rejectionReason, cleanupPending: true }
                    : { approvedAt: reviewedAt, approvedBy: principal.uuid }),
                  ...(approvedKey
                    ? {
                        approvedStorageKey: approvedKey,
                        approvedMimeType: artifact!.mimeType,
                        approvedFilename: artifact!.filename,
                        approvedExtension: artifact!.extension,
                        approvedSizeBytes: artifact!.sizeBytes,
                        approvedSha256: artifact!.sha256,
                        approvedPageCount: artifact!.pageCount,
                        approvedPreparation: artifact!.preparation,
                        pendingApprovalStorageKey: null,
                        approvalLeaseUntil: null,
                      }
                    : {}),
                }),
          },
        });
        if (changed.count !== 1)
          throw new ConflictException("Review revision has changed");
        if (edits) {
          const names = new Set([
            ...version.fields.map((f) => f.name),
            ...Object.keys(edits),
          ]);
          if (names.size > 200)
            throw new BadRequestException("At most 200 document fields");
          for (const [name, value] of Object.entries(edits)) {
            await tx.documentVersionField.upsert({
              where: { versionId_name: { versionId: version.id, name } },
              create: {
                versionId: version.id,
                name,
                originalValue: null,
                value: textValue(value),
                editedBy: principal.uuid,
              },
              update: { value: textValue(value), editedBy: principal.uuid },
            });
          }
          const allFields = {
            ...Object.fromEntries(version.fields.map((f) => [f.name, f.value])),
            ...edits,
          };
          await this.expiration?.syncDocumentExpiresAt(tx, documentId, version.id, allFields);
        } else {
          if (
            version.job &&
            ["UPLOADING", "QUEUED", "RUNNING"].includes(version.job.status)
          ) {
            await tx.ocrJob.updateMany({
              where: {
                id: version.job.id,
                status: { in: ["UPLOADING", "QUEUED", "RUNNING"] },
              },
              data: {
                status: "CANCELLED",
                leaseToken: null,
                leaseUntil: null,
                cleanupPending: false,
                errorCode: null,
              },
            });
          }
          await tx.document.update({
            where: { id: documentId },
            data: { status: rejectionReason ? "RETURNED" : "APPROVED" },
          });
          if (!rejectionReason) {
            const allFields = Object.fromEntries(
              version.fields.map((f) => [f.name, f.value]),
            );
            await this.expiration?.syncDocumentExpiresAt(
              tx,
              documentId,
              version.id,
              allFields,
            );
          }
          if (approvedKey) {
            const uid = version.document.documentType?.erpUid;
            const candidate = version.document.candidate;
            const chatUid = candidate?.chatUuid;
            const ig = !!candidate && isIgRecipient(candidate);
            const validPerson =
              !!candidate && matchesIgRecipient(candidate, identity);
            const documentFields = Object.fromEntries(
              version.fields
                .filter(
                  (f) =>
                    !isForeignPassport(version.document) ||
                    !IG_PASSPORT_LATIN_FIELDS.some((name) => name === f.name),
                )
                .map((f) => {
                  const value = typedValue(f.value, f.kind);
                  const erpValue =
                    typeof value === "string" && !value.trim()
                      ? ""
                      : (value ?? (f.kind === "boolean" ? false : ""));
                  return [
                    f.name,
                    artifact!.transport === "base64-v1" &&
                    f.kind === "date" &&
                    typeof erpValue === "string"
                      ? formatDateForErp(erpValue)
                      : erpValue,
                  ];
                }),
            );
            if (
              shouldOmitPositionUid(
                documentFields.positionUid,
                version.positionCode1c,
              )
            )
              delete documentFields.positionUid;
            await tx.erpDocumentDelivery.create({
              data: {
                versionId: version.id,
                transport: artifact!.transport,
                status:
                  uid && (ig ? validPerson : !!chatUid)
                    ? "PENDING"
                    : "WAITING_CONTRACT",
                ...(ig && !validPerson
                  ? {
                      errorCode: identity
                        ? "ERP_PERSON_IDENTITY_MISMATCH"
                        : "ERP_PERSON_IDENTITY_UNAVAILABLE",
                    }
                  : {}),
                payload: {
                  documentUid: uid,
                  ...(ig
                    ? validPerson
                      ? {
                          recipientType: "person",
                          personUid: identity!.personUid,
                          code1c: identity!.code1C,
                        }
                      : {}
                    : { chatUid }),
                  documentFields,
                },
              },
            });
          }
        }
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: edits
            ? "DOCUMENT_FIELDS_UPDATED"
            : rejectionReason
              ? "DOCUMENT_RETURNED"
              : "DOCUMENT_APPROVED",
          entityType: "Document",
          entityId: documentId,
          correlationId: correlationId.slice(0, 64),
          before: {
            version: number,
            revision,
            fields: version.fields.map(({ name, value }) => ({ name, value })),
          },
          after: {
            version: number,
            revision: revision + 1,
            ...(edits
              ? { fields: edits }
              : {
                  status: rejectionReason ? "RETURNED" : "APPROVED",
                  rejectionReason,
                  reviewedAt: reviewedAt.toISOString(),
                  reviewedBy: principal.uuid,
                }),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return this.reads.version(documentId, number);
  }
}
