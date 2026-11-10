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
import { candidateReviewGroup, requireReviewGroup } from "./review-group";
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

function hasActiveCandidateUpload(
  doc:
    | {
        currentVersion: number;
        status: string;
        versions?: Array<{
          version: number;
          status: string;
          submission?: { id: string } | null;
        }>;
      }
    | null
    | undefined,
): boolean {
  if (!doc) return false;
  if (doc.currentVersion > 0 && doc.status !== "DRAFT") return true;
  return !!doc.versions?.some(
    (v) => v.submission !== null || (v.version >= 1 && v.status !== "DRAFT"),
  );
}

/** Stable across ERP JSON key ordering; identity and original-file revisions are included. */
function sourceFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
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
    options: {
      signal?: AbortSignal;
      assertLease?: (tx?: Prisma.TransactionClient) => Promise<void>;
    } = {},
  ) {
    const assertActive = async (tx?: Prisma.TransactionClient) => {
      options.signal?.throwIfAborted();
      await options.assertLease?.(tx);
      options.signal?.throwIfAborted();
    };
    await assertActive();
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
      const identity = await this.erp.identity(row.code1c, options.signal);
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
          .employmentHistory(row.code1c!, personUid!, options.signal)
          .then((history) => ({ available: true, items: history.items }))
          .catch(() => ({ available: false, items: [] }))
      : undefined;
    const result = await this.erp.request(
      isIg ? "person-documents-by-code" : "person-documents",
      previousDocumentsSchema,
      isIg
        ? { code1c: row.code1c!, personUid: personUid! }
        : { candidate: row.erpUid! },
      undefined,
      options.signal,
    );
    await assertActive();
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
    const allDocuments = candidates.map((doc) => ({
      ...doc,
      sourceFingerprint: sourceFingerprint({
        erpUid: row.erpUid,
        code1c: row.code1c,
        personUid,
        ...doc,
      }),
      verifiedOriginal: false,
      previouslyConfirmed: false,
      verificationCheckedAt: null as Date | null,
    }));

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

    const usedStorageKeys = new Set<string>();
    const persistDocuments = async (
      documents: typeof allDocuments,
      phase: "metadata" | "checkpoint" | "complete",
    ) => {
      await this.prisma.$transaction(async (tx) => {
        await assertActive(tx);
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
          await assertActive(tx);
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
        for (const doc of documents) {
          if (seen.has(doc.id)) continue;
          seen.add(doc.id);
          const old = oldBySource.get(doc.id);
          if (phase === "metadata") {
            doc.previouslyConfirmed = old?.status === "CONFIRMED";
            const age = old?.verificationCheckedAt
              ? Date.now() - old.verificationCheckedAt.getTime()
              : Number.POSITIVE_INFINITY;
            doc.verifiedOriginal = !!(
              old?.originalVerified &&
              old.sourceFingerprint === doc.sourceFingerprint &&
              age >= 0 &&
              age < 24 * 60 * 60 * 1000
            );
            doc.verificationCheckedAt = doc.verifiedOriginal
              ? old!.verificationCheckedAt
              : null;
          }
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
          const knownValid = !isDocInvalid;
          const recordDate =
            doc.recordDate !== undefined
              ? doc.recordDate
              : oldFields.recordDate;
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
            doc.verifiedOriginal &&
            isPreviousDocumentValid(
              {
                documentUid: doc.documentUid,
                expiresAt,
                fields,
                originalAvailable: doc.originalAvailable,
                originalVerified: doc.verifiedOriginal,
                sourceId: doc.id,
                knownValid,
                previouslyConfirmed:
                  old?.status === "CONFIRMED" || doc.previouslyConfirmed,
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
                await assertActive(tx);
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

                await assertActive(tx);
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
                      deliveredHistorically: doc.originalFiles
                        ? true
                        : undefined,
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
              !doc.verifiedOriginal ||
              isDocInvalid ||
              (expiresAt !== null && isPreviousDocumentExpired(expiresAt)) ||
              (isIg &&
                (!doc.documentUid || needsNewIgDocument(doc.documentUid))));
          const awaitingVerification =
            phase === "metadata" &&
            doc.originalAvailable &&
            !doc.verifiedOriginal &&
            knownValid &&
            !isDocInvalid;
          const knownReplacement =
            isDocInvalid ||
            (expiresAt !== null && isPreviousDocumentExpired(expiresAt)) ||
            (isIg && (!doc.documentUid || needsNewIgDocument(doc.documentUid)));
          const unchangedConfirmation =
            old?.sourceFingerprint === doc.sourceFingerprint ||
            (!old?.sourceFingerprint &&
              isDeepStrictEqual(oldFields, fields) &&
              (old?.expiresAt?.getTime() ?? null) ===
                (expiresAt?.getTime() ?? null));
          const nextStatus =
            old?.status === "CONFIRMED" && !doc.originalAvailable
              ? "ORIGINAL_UNAVAILABLE"
              : old?.status === "CONFIRMED" && knownReplacement
                ? "REPLACE"
                : awaitingVerification && old?.status === "CONFIRMED"
                  ? unchangedConfirmation
                    ? undefined
                    : "REQUIRES_REVIEW"
                  : old?.status === "CONFIRMED" && !knownValid && !isDocInvalid
                    ? "REQUIRES_REVIEW"
                    : confirmedInvalid
                      ? !doc.originalAvailable || !doc.verifiedOriginal
                        ? "ORIGINAL_UNAVAILABLE"
                        : "REPLACE"
                      : old?.status === "REQUIRES_REVIEW" &&
                          automaticallyConfirmed
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
            ((!old && automaticallyConfirmed) ||
              nextStatus === "CONFIRMED" ||
              (old?.status === "CONFIRMED" &&
                !old.originalVerified &&
                automaticallyConfirmed))
          )
            completionChanged = true;
          if (
            isIg &&
            old?.status === "CONFIRMED" &&
            ((nextStatus && nextStatus !== "CONFIRMED") ||
              (old.originalVerified && !doc.verifiedOriginal))
          )
            completionInvalidated = true;
          await assertActive(tx);
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
              originalVerified: doc.verifiedOriginal && knownValid,
              sourceFingerprint: doc.sourceFingerprint,
              verificationCheckedAt: doc.verifiedOriginal
                ? doc.verificationCheckedAt
                : null,
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
              originalVerified: doc.verifiedOriginal && knownValid,
              sourceFingerprint: doc.sourceFingerprint,
              verificationCheckedAt: doc.verifiedOriginal
                ? doc.verificationCheckedAt
                : null,
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
                nextStatus === "CONFIRMED"
                  ? "system:previous-document"
                  : actorId,
              action: "DOCUMENT_FIELDS_UPDATED",
              entityType: "CandidatePreviousDocument",
              entityId: old.id,
              correlationId,
              before: { status: old.status },
              after: { status: nextStatus, source: "ERP_REVALIDATION" },
            });
        }
        if (phase === "complete" || phase === "metadata")
          for (const old of oldDocuments) {
            if (
              seen.has(old.sourceId) ||
              (!old.originalAvailable && old.status !== "CONFIRMED")
            )
              continue;
            const nextStatus =
              old.status === "CONFIRMED" ? "ORIGINAL_UNAVAILABLE" : old.status;
            if (isIg && old.status === "CONFIRMED")
              completionInvalidated = true;
            await assertActive(tx);
            await tx.candidatePreviousDocument.update({
              where: { id: old.id },
              data: {
                originalAvailable: false,
                originalVerified: false,
                verificationCheckedAt: null,
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
          await assertActive(tx);
          await tx.candidate.update({
            where: { id },
            data: { igCompletionVerified: false },
          });
        }
        if (phase === "complete")
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
          after: { count: documents.length, phase },
        });
        await assertActive(tx);
      });
    };
    await persistDocuments(allDocuments, "metadata");
    let employmentHistory: Awaited<typeof historyPromise>;
    try {
      for (let offset = 0; offset < allDocuments.length; offset += 2) {
        const batch = allDocuments.slice(offset, offset + 2);
        const outcomes = await Promise.allSettled(
          batch.map(async (doc) => {
            await assertActive();
            if (doc.verifiedOriginal) return;
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
                    (await (async () => {
                      // A single document may contain many files; keep the per-job
                      // bound at two storage/ERP probes, including multipage originals.
                      for (const file of doc.originalFiles!) {
                        await assertActive();
                        if (
                          !(await this.ownHistory!.probeOriginal(
                            file.storageKey,
                            file.sizeBytes,
                            file.sha256,
                          ))
                        )
                          return false;
                      }
                      return true;
                    })());
                } else if (isIg)
                  verifiedOriginal = await this.erp.probePersonOriginal(
                    row.code1c!,
                    personUid!,
                    (doc as any).originalErpId ?? (doc as any).id,
                    options.signal,
                  );
                else if (row.erpUid)
                  verifiedOriginal = await this.erp.probeCandidateOriginal(
                    row.erpUid,
                    doc.originalErpId,
                    options.signal,
                  );
              } catch (error) {
                await assertActive();
                // A missing original is a completed negative check. Network and
                // upstream failures must leave this refresh retryable instead.
                if (!(error instanceof NotFoundException)) throw error;
                verifiedOriginal = false;
              }
            }
            await assertActive();
            doc.verifiedOriginal = verifiedOriginal;
            doc.verificationCheckedAt = verifiedOriginal ? new Date() : null;
            if (verifiedOriginal) await persistDocuments([doc], "checkpoint");
          }),
        );
        const failed = outcomes.find(
          (outcome) => outcome.status === "rejected",
        );
        if (failed?.status === "rejected") throw failed.reason;
      }

      if (
        isIg &&
        ((this.prisma as any).document || (this.prisma as any).candidate) &&
        (this.prisma as any).documentType
      ) {
        for (const doc of allDocuments) {
          await assertActive();
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
              where: {
                erpUid: doc.documentUid,
                catalogSyncedAt: { not: null },
              },
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
                  await assertActive();
                  docCreatedKeys.push(targetKey);
                  createdStorageKeys.push(targetKey);
                  await this.storage.copy(
                    f.storageKey,
                    targetKey,
                    options.signal
                      ? AbortSignal.any([
                          options.signal,
                          AbortSignal.timeout(30000),
                        ])
                      : AbortSignal.timeout(30000),
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
                options.signal,
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
                await assertActive();
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
          } catch (error) {
            if (this.storage && docCreatedKeys.length > 0) {
              for (const key of docCreatedKeys) {
                await this.safeDeleteIfUnreferenced(key);
                const idx = createdStorageKeys.indexOf(key);
                if (idx !== -1) createdStorageKeys.splice(idx, 1);
              }
            }
            await assertActive();
            if (!(error instanceof NotFoundException)) throw error;
            doc.verifiedOriginal = false;
            doc.verificationCheckedAt = null;
          }
        }
      }

      employmentHistory = await historyPromise;
      await assertActive();
      await persistDocuments(allDocuments, "complete");

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
      ...(historyPromise ? { employmentHistory } : {}),
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
            OR: [{ storageKey: key }, { files: { some: { storageKey: key } } }],
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
