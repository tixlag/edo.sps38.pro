import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
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
  isPreviousDocumentValid,
  needsNewIgDocument,
} from "./reemployment-document-policy";
import { StorageService } from "../storage/storage.service";

function hasActiveCandidateUpload(doc: {
  currentVersion: number;
  status: string;
  versions?: Array<{
    version: number;
    status: string;
    submission?: { id: string } | null;
  }>;
} | null | undefined): boolean {
  if (!doc) return false;
  if (doc.currentVersion > 0 && doc.status !== "DRAFT") return true;
  return !!doc.versions?.some(
    (v) => v.submission !== null || (v.version >= 1 && v.status !== "DRAFT"),
  );
}

@Injectable()
export class CandidatePreviousDocumentsSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
    @Optional() private readonly ownHistory?: OwnDocumentHistoryService,
    @Optional() private readonly storage?: StorageService,
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
    const rawCandidates = [
      ...result.items.map((doc) => ({
        ...doc,
        originalErpId: doc.id,
        verifiedOwner: true,
        originalFiles: null,
        malformedExpiry: false,
      })),
      ...edoHistory.map((doc) => ({
        ...doc,
        originalErpId: null,
      })),
    ];
    const seenIds = new Map<string, number>();
    const candidates = rawCandidates.map((doc) => {
      const count = (seenIds.get(doc.id) ?? 0) + 1;
      seenIds.set(doc.id, count);
      return count > 1 ? { ...doc, id: `${doc.id}#${count}` } : doc;
    });
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
                    personUid!,
                    (doc as any).originalErpId ?? (doc as any).id,
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

    const createdStorageKeys: string[] = [];
    const preparedLinkDocuments = new Map<
      string,
      {
        targetDocId: string;
        docTypeId: string;
        vFiles: Array<{
          ordinal: number;
          storageKey: string;
          filename: string;
          mimeType: string;
          sizeBytes: number;
          sha256: string;
          pageCount: number;
        }>;
      }
    >();

    if (
      isIg &&
      ((this.prisma as any).document || (this.prisma as any).candidate) &&
      (this.prisma as any).documentType
    ) {
      for (const doc of allDocuments) {
        const expiresAt = doc.expiresAt
          ? new Date(`${doc.expiresAt}T00:00:00Z`)
          : null;
        const isDocInvalid =
          doc.isInvalid === true ||
          (doc.fields &&
            typeof doc.fields === "object" &&
            !Array.isArray(doc.fields) &&
            doc.fields.isInvalid === true);
        const needsLinking =
          doc.documentUid &&
          needsNewIgDocument(doc.documentUid) &&
          doc.verifiedOwner &&
          doc.originalAvailable &&
          doc.verifiedOriginal &&
          (!expiresAt || !isPreviousDocumentExpired(expiresAt)) &&
          !isDocInvalid;

        if (!needsLinking) continue;

        const docCreatedKeys: string[] = [];
        try {
          const docType = await (this.prisma as any).documentType.findFirst({
            where: { erpUid: doc.documentUid, catalogSyncedAt: { not: null } },
          });
          if (!docType) continue;

          const existingDoc = (this.prisma as any).document
            ? await (this.prisma as any).document.findUnique({
                where: {
                  candidateId_documentTypeId: {
                    candidateId: id,
                    documentTypeId: docType.id,
                  },
                },
                include: {
                  versions: {
                    select: {
                      id: true,
                      version: true,
                      status: true,
                      submission: { select: { id: true } },
                    },
                  },
                },
              })
            : null;
          if (hasActiveCandidateUpload(existingDoc)) {
            continue;
          }

          const prepToken = randomUUID();
          let vFiles: Array<{
            ordinal: number;
            storageKey: string;
            filename: string;
            mimeType: string;
            sizeBytes: number;
            sha256: string;
            pageCount: number;
          }> = [];

          if (doc.originalFiles && doc.originalFiles.length > 0) {
            for (let idx = 0; idx < doc.originalFiles.length; idx++) {
              const f = doc.originalFiles[idx];
              const filename = f.filename || `${docType.code}.pdf`;
              const fileIdOrOrdinal = f.id || `${idx + 1}`;
              const storageFilename = `${fileIdOrOrdinal}-${filename}`;
              const targetKey = this.storage
                ? this.storage.keyFor(prepToken, 1, storageFilename)
                : `documents/${prepToken}/v1/${storageFilename}`;
              if (this.storage) {
                docCreatedKeys.push(targetKey);
                createdStorageKeys.push(targetKey);
                await this.storage.copy(
                  f.storageKey,
                  targetKey,
                  AbortSignal.timeout(30000),
                );
              }
              vFiles.push({
                ordinal: idx,
                storageKey: targetKey,
                filename,
                mimeType: f.mimeType || "application/pdf",
                sizeBytes: f.sizeBytes,
                sha256: f.sha256 ?? "",
                pageCount: f.pageCount || 1,
              });
            }
          } else {
            const rawId = (doc.originalErpId ?? doc.id).split("#")[0];
            const originalData = await this.erp.personOriginal(
              row.code1c!,
              personUid!,
              rawId,
            );
            const bytes = originalData.bytes;
            const mimeType = originalData.mimeType || "application/pdf";
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const sizeBytes = bytes.length;
            const ext =
              mimeType.includes("jpeg") || mimeType.includes("jpg")
                ? "jpg"
                : mimeType.includes("png")
                  ? "png"
                  : "pdf";
            const filename = `${docType.code}.${ext}`;
            const storageFilename = `1-${filename}`;
            const targetKey = this.storage
              ? this.storage.keyFor(prepToken, 1, storageFilename)
              : `documents/${prepToken}/v1/${storageFilename}`;
            if (this.storage) {
              docCreatedKeys.push(targetKey);
              createdStorageKeys.push(targetKey);
              await this.storage.uploadBuffer(targetKey, bytes, mimeType);
            }
            vFiles = [
              {
                ordinal: 0,
                storageKey: targetKey,
                filename,
                mimeType,
                sizeBytes,
                sha256,
                pageCount: 1,
              },
            ];
          }

          if (vFiles.length > 0) {
            preparedLinkDocuments.set(doc.id, {
              targetDocId: existingDoc?.id ?? prepToken,
              docTypeId: docType.id,
              vFiles,
            });
          }
        } catch {
          if (this.storage && docCreatedKeys.length > 0) {
            for (const key of docCreatedKeys) {
              await this.safeDeleteIfUnreferenced(key);
              const idx = createdStorageKeys.indexOf(key);
              if (idx !== -1) createdStorageKeys.splice(idx, 1);
            }
          }
          doc.verifiedOriginal = false;
        }
      }
    }

    const usedStorageKeys = new Set<string>();
    try {
      await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id} FOR UPDATE`;
      const current = await tx.candidate.findFirst({
        where: { id, ...(p ? this.access.candidateWhere(p) : {}) },
      });
      if (
        !current ||
        candidateReviewGroup(current) !== candidateReviewGroup(row) ||
        (current.personUid && personUid && current.personUid !== personUid) ||
        current.code1c !== row.code1c ||
        current.erpUid !== row.erpUid
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      if (isIg && !current.personUid && personUid) {
        await tx.candidate.update({
          where: { id },
          data: { personUid },
        });
        current.personUid = personUid;
      }
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
        if (seen.has(doc.id)) continue;
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
        const isDocInvalid =
          isInvalid === true ||
          (doc.fields &&
            typeof doc.fields === "object" &&
            !Array.isArray(doc.fields) &&
            doc.fields.isInvalid === true);
        const knownValid = !isIg || !isDocInvalid;
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
          isPreviousDocumentValid(
            {
              documentUid: doc.documentUid,
              expiresAt,
              fields,
              originalAvailable: doc.originalAvailable,
              originalVerified: doc.verifiedOriginal,
              sourceId: doc.id,
              knownValid,
            },
            isIg,
          );
        if (
          isIg &&
          doc.documentUid &&
          needsNewIgDocument(doc.documentUid) &&
          preparedLinkDocuments.has(doc.id)
        ) {
          const prep = preparedLinkDocuments.get(doc.id)!;
          if ((tx as any).document && (tx as any).documentVersion) {
            const existingDoc = await tx.document.findUnique({
              where: {
                candidateId_documentTypeId: {
                  candidateId: id,
                  documentTypeId: prep.docTypeId,
                },
              },
              include: {
                versions: {
                  select: {
                    id: true,
                    version: true,
                    status: true,
                    submission: { select: { id: true } },
                  },
                },
              },
            });
            const hasUpload = hasActiveCandidateUpload(existingDoc);
            if (
              !existingDoc ||
              (!hasUpload &&
                existingDoc.currentVersion === 0 &&
                (!existingDoc.versions || existingDoc.versions.length === 0))
            ) {
              const targetDoc = await tx.document.upsert({
                where: {
                  candidateId_documentTypeId: {
                    candidateId: id,
                    documentTypeId: prep.docTypeId,
                  },
                },
                create: {
                  id: prep.targetDocId,
                  candidateId: id,
                  documentTypeId: prep.docTypeId,
                  reviewGroup: "IG",
                  currentVersion: 1,
                  status: "IN_REVIEW",
                },
                update: {
                  reviewGroup: "IG",
                  currentVersion: 1,
                  status: "IN_REVIEW",
                },
              });

              await tx.documentVersion.upsert({
                where: {
                  documentId_version: {
                    documentId: targetDoc.id,
                    version: 1,
                  },
                },
                create: {
                  documentId: targetDoc.id,
                  version: 1,
                  status: "IN_REVIEW",
                  storageKey: prep.vFiles[0].storageKey,
                  mimeType: prep.vFiles[0].mimeType,
                  sizeBytes: prep.vFiles[0].sizeBytes,
                  ocrSource: "PREVIOUS_LINK",
                  ocrRaw: {
                    sourceId: doc.id,
                    documentUid: doc.documentUid,
                    source: doc.originalFiles ? "EDO" : "ERP",
                    deliveredHistorically: doc.originalFiles ? true : undefined,
                  },
                  files: { create: prep.vFiles },
                },
                update: {},
              });

              for (const f of prep.vFiles) {
                usedStorageKeys.add(f.storageKey);
              }

              await this.audit.logInTransaction(tx, {
                actorId: "system:previous-document",
                action: "DOCUMENT_FIELDS_UPDATED",
                entityType: "Document",
                entityId: targetDoc.id,
                correlationId,
                after: {
                  version: 1,
                  status: "IN_REVIEW",
                  linkedFrom: doc.id,
                  documentUid: doc.documentUid,
                },
              });
            }
          }
        }
        const confirmedInvalid =
          old?.status === "CONFIRMED" &&
          (!doc.originalAvailable ||
            (isIg && !doc.verifiedOriginal) ||
            isDocInvalid ||
            (expiresAt !== null && isPreviousDocumentExpired(expiresAt)) ||
            (isIg &&
              (!doc.documentUid || needsNewIgDocument(doc.documentUid))));
        const nextStatus =
          old?.status === "CONFIRMED" && !knownValid && !isDocInvalid
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

    const unusedKeys = createdStorageKeys.filter(
      (key) => !usedStorageKeys.has(key),
    );
    if (this.storage && unusedKeys.length > 0) {
      for (const key of unusedKeys) {
        await this.safeDeleteIfUnreferenced(key);
      }
    }
    createdStorageKeys.length = 0;
  } catch (txErr) {
    if (this.storage && createdStorageKeys.length > 0) {
      for (const key of createdStorageKeys) {
        await this.safeDeleteIfUnreferenced(key);
      }
    }
    throw txErr;
  }
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

  private async safeDeleteIfUnreferenced(key: string): Promise<void> {
    if (!this.storage) return;
    let isReferenced = true;
    try {
      if ((this.prisma as any).documentVersion) {
        const row = await (this.prisma as any).documentVersion.findFirst({
          where: {
            OR: [
              { storageKey: key },
              { files: { some: { storageKey: key } } },
            ],
          },
          select: { id: true },
        });
        isReferenced = !!row;
      } else {
        isReferenced = true;
      }
    } catch {
      isReferenced = true;
    }
    if (!isReferenced) {
      await this.storage.delete(key).catch(() => undefined);
    }
  }
}
