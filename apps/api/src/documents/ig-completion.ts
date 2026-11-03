import type { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { MIGRATION_UID } from "../ocr/ocr-profile";
import { requiredApplicable } from "./document-contract";
import {
  EMPLOYMENT_PATENT_UID,
  isPreviousDocumentExpired,
  needsNewIgDocument,
} from "./reemployment-document-policy";

export function usablePreviousUids(
  previous: {
    documentUid: string | null;
    expiresAt: Date | null;
    fields: Prisma.JsonValue;
  }[],
): string[] {
  return previous
    .filter(
      (doc) =>
        !!doc.documentUid &&
        !needsNewIgDocument(doc.documentUid) &&
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

export function igRequiredDocumentsComplete(
  required: { id: string; erpUid: string | null }[],
  documents: { documentTypeId: string | null; status: string }[],
  previousUids: string[],
) {
  const uids = new Set(required.map((t) => t.erpUid?.toLowerCase()));
  if (!uids.has(MIGRATION_UID) || !uids.has(EMPLOYMENT_PATENT_UID))
    return false;
  const confirmed = new Set(previousUids.map((uid) => uid.toLowerCase()));
  return (
    required.length > 0 &&
    required.every((type) => {
      const current = documents.find((doc) => doc.documentTypeId === type.id);
      if (current) return ["APPROVED", "SIGNED"].includes(current.status);
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
    candidate.igCompletedAt ||
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
      select: { documentTypeId: true, status: true },
    }),
    tx.candidatePreviousDocument.findMany({
      where: { candidateId, status: "CONFIRMED", originalAvailable: true },
    }),
  ]);
  const required = catalog.filter(
    (type) =>
      needsNewIgDocument(type.erpUid) ||
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
  const previousUids = usablePreviousUids(previous);
  if (!igRequiredDocumentsComplete(required, documents, previousUids)) return;
  await tx.candidate.update({
    where: { id: candidateId },
    data: { igCompletedAt: new Date() },
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
