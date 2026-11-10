import type { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { MIGRATION_UID } from "../ocr/ocr-profile";
import { requiredApplicable } from "./document-contract";
import {
  EMPLOYMENT_PATENT_UID,
  isEaeuCitizenship,
  isPreviousDocumentExpired,
  needsNewIgDocument,
} from "./reemployment-document-policy";

export function usablePreviousUids(
  previous: {
    documentUid: string | null;
    expiresAt: Date | null;
    fields: Prisma.JsonValue;
  }[],
  isIg = true,
): string[] {
  return previous
    .filter(
      (doc) =>
        !!doc.documentUid &&
        (!isIg || !needsNewIgDocument(doc.documentUid)) &&
        (!doc.expiresAt || !isPreviousDocumentExpired(doc.expiresAt)) &&
        !(
          doc.fields &&
          typeof doc.fields === "object" &&
          !Array.isArray(doc.fields) &&
          doc.fields.isInvalid === true
        ),
    )
    .map((doc) => doc.documentUid!.toLowerCase());
}

type CompletionDocument = {
  documentTypeId: string | null;
  status: string;
  currentVersion: number;
  versions: {
    version: number;
    status: string;
    ocrSource?: string | null;
    ocrRaw?: Prisma.JsonValue | null;
    delivery: {
      status: string;
      transport: string;
      attempts: {
        receiptValidated: boolean;
        errorCode: string | null;
        finishedAt: Date | null;
      }[];
    } | null;
  }[];
};

export function igRequiredDocumentsComplete(
  required: { id: string; erpUid: string | null }[],
  documents: CompletionDocument[],
  previousUids: string[],
) {
  const confirmed = new Set(previousUids.map((uid) => uid.toLowerCase()));
  return (
    required.length > 0 &&
    required.every((type) => {
      const current = documents.find((doc) => doc.documentTypeId === type.id);
      if (current && current.status !== "DRAFT") {
        const version = current.versions.find(
          (v) => v.version === current.currentVersion,
        );
        if (
          !version ||
          !["APPROVED", "SIGNED"].includes(current.status) ||
          !["APPROVED", "SIGNED"].includes(version.status)
        ) {
          return false;
        }

        const isConfirmedReused =
          version.ocrSource === "PREVIOUS_LINK" &&
          ((version.ocrRaw as Record<string, unknown> | null)?.source === "ERP" ||
            (version.ocrRaw as Record<string, unknown> | null)?.deliveredHistorically === true);
        if (isConfirmedReused) {
          return true;
        }

        const delivery = version.delivery;
        const attempt = delivery?.attempts[0];
        return (
          delivery?.status === "SENT" &&
          delivery.transport === "multipart-v2" &&
          !!attempt?.receiptValidated &&
          !!attempt.finishedAt &&
          !attempt.errorCode
        );
      }
      return (
        !!type.erpUid &&
        !needsNewIgDocument(type.erpUid) &&
        confirmed.has(type.erpUid.toLowerCase())
      );
    })
  );
}

/** The caller holds the candidate row lock and writes audit in the same transaction. */
export async function tryCompleteIgEmployment(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  candidateId: string,
  actorId: string,
  correlationId: string,
) {
  const state = await tx.igEmploymentState.findFirst({
    where: { currentCandidateId: candidateId },
    include: { currentCandidate: true },
  });
  const candidate = state?.currentCandidate;
  if (
    !candidate ||
    (candidate.igCompletedAt && candidate.igCompletionVerified) ||
    !candidate.positionCode ||
    !candidate.citizenship ||
    candidate.citizenship.toLowerCase() === "ru"
  )
    return;
  const [catalog, documents, previous] = await Promise.all([
    tx.documentType.findMany({
      where: { catalogSyncedAt: { not: null } },
      include: {
        positions: true,
        stageRules: {
          include: { positions: true, projects: true, countries: true },
        },
      },
    }),
    tx.document.findMany({
      where: { candidateId },
      select: {
        documentTypeId: true,
        status: true,
        currentVersion: true,
        versions: {
          select: {
            version: true,
            status: true,
            ocrSource: true,
            ocrRaw: true,
            delivery: {
              select: {
                status: true,
                transport: true,
                attempts: {
                  orderBy: { startedAt: "desc" },
                  take: 1,
                  select: {
                    receiptValidated: true,
                    finishedAt: true,
                    errorCode: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    tx.candidatePreviousDocument.findMany({
      where: {
        candidateId,
        status: "CONFIRMED",
        originalAvailable: true,
        originalVerified: true,
      },
    }),
  ]);
  const required = catalog.filter((type) =>
    requiredApplicable(
      type,
      candidate.positionCode!,
      candidate.citizenship!,
      candidate.sexKnown &&
        (candidate.sex === "male" || candidate.sex === "female")
        ? candidate.sex
        : null,
      candidate.projectCode,
    ),
  );
  const requiredUids = new Set(
    required.map((type) => type.erpUid?.toLowerCase()),
  );
  const patentExpected = !isEaeuCitizenship(candidate.citizenship);
  if (
    !requiredUids.has(MIGRATION_UID) ||
    (patentExpected && !requiredUids.has(EMPLOYMENT_PATENT_UID))
  ) {
    if (!candidate.igRequirementsConflict) {
      await tx.candidate.update({
        where: { id: candidateId },
        data: { igRequirementsConflict: true },
      });
      await audit.logInTransaction(tx, {
        actorId,
        action: "DATA_IMPORTED",
        entityType: "Candidate",
        entityId: candidateId,
        correlationId: correlationId.slice(0, 64),
        after: { reason: "ERP_IG_REQUIREMENTS_CONFLICT" },
      });
    }
    return;
  }
  if (candidate.igRequirementsConflict)
    await tx.candidate.update({
      where: { id: candidateId },
      data: { igRequirementsConflict: false },
    });
  const previousUids = usablePreviousUids(previous);
  if (!igRequiredDocumentsComplete(required, documents, previousUids)) return;
  await tx.candidate.update({
    where: { id: candidateId },
    data: { igCompletedAt: new Date(), igCompletionVerified: true },
  });
  await audit.logInTransaction(tx, {
    actorId,
    action: "DATA_IMPORTED",
    entityType: "Candidate",
    entityId: candidateId,
    correlationId: correlationId.slice(0, 64),
    after: { status: "IG_EMPLOYMENT_COMPLETED" },
  });
}
