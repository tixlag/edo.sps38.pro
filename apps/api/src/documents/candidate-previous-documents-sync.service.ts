import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { DocumentAccessService } from "./document-access.service";
import { OwnDocumentHistoryService } from "./own-document-history.service";
import {
  candidateReviewGroup,
  requireReviewGroup,
} from "./review-group";
import {
  ErpWorkspaceClient,
  previousDocumentsSchema,
} from "./erp-workspace.client";
import { tryCompleteIgEmployment } from "./ig-completion";
import {
  isPreviousDocumentExpired,
  needsNewIgDocument,
} from "./reemployment-document-policy";

@Injectable()
export class CandidatePreviousDocumentsSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
    @Optional() private readonly ownHistory?: OwnDocumentHistoryService,
  ) {}

  async syncPreviousDocuments(
    id: string,
    actorId: string,
    correlationId = "",
    preloadedRow?: any,
    p?: AuthPrincipal,
  ) {
    const row =
      preloadedRow ??
      (await this.prisma.candidate.findUnique?.({ where: { id } })) ??
      (await this.prisma.candidate.findFirst?.({ where: { id } }));
    if (!row) throw new NotFoundException("CANDIDATE_NOT_FOUND");
    const isIg = candidateReviewGroup(row) === "IG";
    let personUid = row.personUid;
    if (isIg) {
      if (!row.code1c)
        throw new ConflictException("ERP_PERSON_IDENTITY_REQUIRED");
      const identity = await this.erp.identity(row.code1c);
      if (
        identity.reviewGroup !== "IG" ||
        identity.recipientType !== "person" ||
        !identity.personUid ||
        identity.code1C !== row.code1c ||
        (row.personUid && row.personUid !== identity.personUid)
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      personUid = identity.personUid;
      row.personUid = personUid;
      if (!row.personUid) {
        await this.prisma.candidate?.update?.({
          where: { id },
          data: { personUid },
        });
      }
    }
    const historyPromise = isIg
      ? this.erp
          .employmentHistory(row.code1c!, personUid!)
          .then((history) => ({ available: true, items: history.items }))
          .catch(() => ({ available: false, items: [] }))
      : undefined;
    const result = await this.erp.request(
      isIg ? "person-documents-by-code" : "person-documents",
      previousDocumentsSchema,
      isIg
        ? { code1c: row.code1c!, personUid: personUid! }
        : { candidate: row.erpUid! },
    );
    const edoDocuments = isIg
      ? await this.prisma.document.findMany({
          where: {
            currentVersion: { gt: 0 },
            candidate: {
              id: { not: id },
              code1c: row.code1c,
              chatUuid: null,
              AND: [
                { OR: [{ citizenship: null }, { citizenship: { not: "ru" } }] },
                { OR: [{ personUid: null }, { personUid: personUid }] },
              ],
            },
          },
          include: {
            documentType: true,
            candidate: { select: { personUid: true } },
            versions: {
              include: {
                fields: true,
                files: true,
                delivery: {
                  include: {
                    attempts: { orderBy: { startedAt: "desc" }, take: 1 },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];
    const edoHistory = edoDocuments.flatMap((document) => {
      const version = document.versions.find(
        (v) => v.version === document.currentVersion,
      );
      if (!version) return [];
      const fields = Object.fromEntries(
        version.fields.map((field) => [
          field.name,
          field.kind === "boolean" && field.value !== null
            ? field.value === "true"
            : field.value,
        ]),
      );
      const expiry = fields.expiryDate;
      const parsedExpiry =
        typeof expiry === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(expiry) &&
        Number.isFinite(Date.parse(`${expiry}T00:00:00Z`)) &&
        new Date(`${expiry}T00:00:00Z`).toISOString().slice(0, 10) === expiry
          ? expiry
          : null;
      const originalAvailable = version.files.length
        ? version.files.some((file) => !file.deletedAt)
        : !!version.storageKey;
      return [
        {
          id: `edo:${document.id}:${version.id}`,
          verifiedOwner:
            document.candidate?.personUid === row.personUid &&
            ["APPROVED", "SIGNED"].includes(document.status) &&
            ["APPROVED", "SIGNED"].includes(version.status) &&
            version.delivery?.status === "SENT" &&
            version.delivery.transport === "multipart-v2" &&
            !!version.delivery.attempts[0]?.receiptValidated &&
            !!version.delivery.attempts[0]?.finishedAt &&
            !version.delivery.attempts[0]?.errorCode,
          originalFiles: version.files.filter((file) => !file.deletedAt),
          malformedExpiry:
            expiry != null &&
            (typeof expiry !== "string" || (!!expiry.trim() && !parsedExpiry)),
          documentUid: document.documentType?.erpUid ?? null,
          title: document.documentType?.title ?? "Документ",
          fields,
          expiresAt: parsedExpiry,
          originalAvailable,
          isInvalid: fields.isInvalid,
          recordDate: undefined,
          recheckStatus: originalAvailable
            ? ("REQUIRES_REVIEW" as const)
            : ("ORIGINAL_UNAVAILABLE" as const),
        },
      ];
    });
    const candidates = [
      ...result.items.map((doc) => ({
        ...doc,
        verifiedOwner: true,
        originalFiles: null,
        malformedExpiry: false,
      })),
      ...edoHistory,
    ];
    const allDocuments: ((typeof candidates)[number] & {
      verifiedOriginal: boolean;
    })[] = [];
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const batch = candidates.slice(offset, offset + 4);
      allDocuments.push(
        ...(await Promise.all(
          batch.map(async (doc) => {
            let verifiedOriginal = false;
            if (
              doc.originalAvailable &&
              doc.verifiedOwner &&
              !doc.malformedExpiry
            ) {
              try {
                if (doc.originalFiles) {
                  verifiedOriginal =
                    !!this.ownHistory &&
                    doc.originalFiles.length > 0 &&
                    (
                      await Promise.all(
                        doc.originalFiles.map((file) =>
                          this.ownHistory!.probeOriginal(
                            file.storageKey,
                            file.sizeBytes,
                            file.sha256,
                          ),
                        ),
                      )
                    ).every(Boolean);
                } else if (isIg)
                  verifiedOriginal = await this.erp.probePersonOriginal(
                    row.code1c!,
                    row.personUid!,
                    doc.id,
                  );
              } catch {
                verifiedOriginal = false;
              }
            }
            return { ...doc, verifiedOriginal };
          }),
        )),
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id} FOR UPDATE`;
      const current = await tx.candidate.findFirst({
        where: { id, ...(p ? this.access.candidateWhere(p) : {}) },
      });
      if (
        !current ||
        candidateReviewGroup(current) !== candidateReviewGroup(row) ||
        current.personUid !== row.personUid ||
        current.code1c !== row.code1c ||
        current.erpUid !== row.erpUid
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      if (p) requireReviewGroup(p, candidateReviewGroup(current));
      const oldDocuments = await tx.candidatePreviousDocument.findMany({
        where: { candidateId: id },
      });
      const oldBySource = new Map(
        oldDocuments.map((doc) => [doc.sourceId, doc]),
      );
      const seen = new Set<string>();
      let completionChanged = false;
      let completionInvalidated = false;
      for (const doc of allDocuments) {
        if (seen.has(doc.id))
          throw new ConflictException("ERP_DOCUMENT_DUPLICATE_SOURCE");
        seen.add(doc.id);
        const old = oldBySource.get(doc.id);
        if (
          old?.documentUid &&
          doc.documentUid &&
          old.documentUid !== doc.documentUid
        )
          throw new ConflictException("ERP_DOCUMENT_IDENTITY_MISMATCH");
        const oldFields =
          old?.fields &&
          typeof old.fields === "object" &&
          !Array.isArray(old.fields)
            ? old.fields
            : {};
        const isInvalid = isIg
          ? doc.isInvalid
          : doc.isInvalid !== undefined
            ? doc.isInvalid
            : oldFields.isInvalid;
        const knownValid =
          !isIg ||
          (doc.originalFiles
            ? isInvalid === undefined || isInvalid === false
            : isInvalid === false &&
              (doc.fields.isInvalid === undefined ||
                doc.fields.isInvalid === false));
        const recordDate =
          doc.recordDate !== undefined ? doc.recordDate : oldFields.recordDate;
        const fields = {
          ...doc.fields,
          ...(recordDate !== undefined ? { recordDate } : {}),
          ...(isInvalid !== undefined &&
          (doc.fields.isInvalid === undefined ||
            doc.fields.isInvalid === isInvalid)
            ? { isInvalid }
            : {}),
        } as Prisma.InputJsonObject;
        const expiresAt = doc.expiresAt
          ? new Date(`${doc.expiresAt}T00:00:00Z`)
          : null;
        const automaticallyConfirmed =
          !!doc.documentUid &&
          doc.verifiedOwner &&
          knownValid &&
          (!isIg || doc.verifiedOriginal) &&
          (!isIg || !needsNewIgDocument(doc.documentUid)) &&
          doc.originalAvailable &&
          isInvalid !== true &&
          (!expiresAt || !isPreviousDocumentExpired(expiresAt));
        const confirmedInvalid =
          old?.status === "CONFIRMED" &&
          (!doc.originalAvailable ||
            (isIg && !doc.verifiedOriginal) ||
            isInvalid === true ||
            (expiresAt !== null && isPreviousDocumentExpired(expiresAt)) ||
            (isIg &&
              (!doc.documentUid || needsNewIgDocument(doc.documentUid))));
        const nextStatus =
          old?.status === "CONFIRMED" && !knownValid && isInvalid !== true
            ? "REQUIRES_REVIEW"
            : confirmedInvalid
              ? !doc.originalAvailable || (isIg && !doc.verifiedOriginal)
                ? "ORIGINAL_UNAVAILABLE"
                : "REPLACE"
              : old?.status === "REQUIRES_REVIEW" && automaticallyConfirmed
                ? "CONFIRMED"
                : old?.status === "CONFIRMED" &&
                    (!isDeepStrictEqual(oldFields, fields) ||
                      (old.expiresAt?.getTime() ?? null) !==
                        (expiresAt?.getTime() ?? null))
                  ? automaticallyConfirmed
                    ? "CONFIRMED"
                    : "REQUIRES_REVIEW"
                  : undefined;
        if (
          isIg &&
          ((!old && automaticallyConfirmed) || nextStatus === "CONFIRMED")
        )
          completionChanged = true;
        if (
          isIg &&
          old?.status === "CONFIRMED" &&
          nextStatus &&
          nextStatus !== "CONFIRMED"
        )
          completionInvalidated = true;
        await tx.candidatePreviousDocument.upsert({
          where: {
            candidateId_sourceId: { candidateId: id, sourceId: doc.id },
          },
          create: {
            candidateId: id,
            sourceId: doc.id,
            documentUid: doc.documentUid,
            title: doc.title,
            fields,
            expiresAt,
            originalAvailable: doc.originalAvailable,
            originalVerified: isIg && doc.verifiedOriginal && knownValid,
            status: automaticallyConfirmed ? "CONFIRMED" : doc.recheckStatus,
            ...(automaticallyConfirmed
              ? {
                  reviewedBy: "system:previous-document",
                  reviewedAt: new Date(),
                }
              : {}),
          },
          update: {
            title: doc.title,
            documentUid: doc.documentUid ?? old?.documentUid ?? null,
            fields,
            expiresAt,
            originalAvailable: doc.originalAvailable,
            originalVerified: isIg && doc.verifiedOriginal && knownValid,
            ...(nextStatus
              ? {
                  status: nextStatus,
                  reviewedBy:
                    nextStatus === "CONFIRMED"
                      ? "system:previous-document"
                      : null,
                  reviewedAt: nextStatus === "CONFIRMED" ? new Date() : null,
                }
              : {}),
          },
        });
        if (!old && automaticallyConfirmed)
          await this.audit.logInTransaction(tx, {
            actorId: "system:previous-document",
            action: "DATA_IMPORTED",
            entityType: "CandidatePreviousDocuments",
            entityId: id,
            correlationId: "",
            after: { sourceId: doc.id, status: "CONFIRMED" },
          });
        if (nextStatus && old)
          await this.audit.logInTransaction(tx, {
            actorId:
              nextStatus === "CONFIRMED" ? "system:previous-document" : actorId,
            action: "DOCUMENT_FIELDS_UPDATED",
            entityType: "CandidatePreviousDocument",
            entityId: old.id,
            correlationId,
            before: { status: old.status },
            after: { status: nextStatus, source: "ERP_REVALIDATION" },
          });
      }
      for (const old of oldDocuments) {
        if (
          seen.has(old.sourceId) ||
          (!old.originalAvailable && old.status !== "CONFIRMED")
        )
          continue;
        const nextStatus =
          old.status === "CONFIRMED" ? "ORIGINAL_UNAVAILABLE" : old.status;
        if (isIg && old.status === "CONFIRMED") completionInvalidated = true;
        await tx.candidatePreviousDocument.update({
          where: { id: old.id },
          data: {
            originalAvailable: false,
            status: nextStatus,
            ...(old.status === "CONFIRMED"
              ? { reviewedBy: null, reviewedAt: null }
              : {}),
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId,
          action: "DOCUMENT_FIELDS_UPDATED",
          entityType: "CandidatePreviousDocument",
          entityId: old.id,
          correlationId,
          before: {
            status: old.status,
            originalAvailable: old.originalAvailable,
          },
          after: {
            status: nextStatus,
            originalAvailable: false,
            source: "ERP_REVALIDATION",
          },
        });
      }
      if (completionInvalidated && current.igCompletionVerified) {
        await tx.candidate.update({
          where: { id },
          data: { igCompletionVerified: false },
        });
      }
      await tx.candidate.update({
        where: { id },
        data: { previousDocumentsSyncedAt: new Date() },
      });
      if (isIg && (completionChanged || completionInvalidated))
        await tryCompleteIgEmployment(
          tx,
          this.audit,
          id,
          "system:previous-document",
          correlationId,
        );
      await this.audit.logInTransaction(tx, {
        actorId,
        action: "DATA_IMPORTED",
        entityType: "CandidatePreviousDocuments",
        entityId: id,
        correlationId,
        after: { count: allDocuments.length },
      });
    });
    const docs = await this.prisma.candidatePreviousDocument.findMany({
      where: { candidateId: id },
      orderBy: { title: "asc" },
    });
    return {
      items: docs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        documentUid: doc.documentUid,
        fields: doc.fields,
        expiresAt: doc.expiresAt?.toISOString().slice(0, 10) ?? null,
        originalAvailable: doc.originalAvailable,
        status: doc.status,
        reviewedBy: doc.reviewedBy,
        reviewedAt: doc.reviewedAt?.toISOString() ?? null,
      })),
      ...(historyPromise ? { employmentHistory: await historyPromise } : {}),
      ...(edoDocuments.length
        ? {
            edoDocuments: edoDocuments.map((doc) => ({
              id: doc.id,
              currentVersion: doc.currentVersion,
              status: doc.status,
              title: doc.documentType?.title ?? "Документ",
            })),
          }
        : {}),
    };
  }
}
