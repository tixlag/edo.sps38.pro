import { createHash } from "node:crypto";
import { candidateReviewGroup } from "./review-group";

/** Qualified local keys separate identical ERP IDs belonging to different people. */
export function ownerQualifiedSourceId(
  sourceId: string,
  personUid: string | null,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sourceId, personUid]))
    .digest("hex")
    .slice(0, 32);
  return `${sourceId.slice(0, 216)}#owner:${digest}`;
}
export function previousDocumentOwnerMatches(
  doc: {
    sourceId: string;
    sourceErpId?: string | null;
    sourcePersonUid?: string | null;
  },
  personUid?: string | null,
): boolean {
  if (
    (doc.sourceErpId ?? doc.sourceId).startsWith("candidate|") &&
    !doc.sourcePersonUid
  )
    return true;
  const owner = personUid ?? null;
  return (
    (doc.sourcePersonUid ?? null) === owner &&
    (owner !== null || /#owner:[a-f0-9]{32}$/.test(doc.sourceId))
  );
}

export function previousDocumentAccessible(
  doc: {
    sourceId: string;
    sourceErpId?: string | null;
    sourcePersonUid?: string | null;
    sourceCandidatePersonUid?: string | null;
    originalAvailable?: boolean;
  },
  candidate: {
    reviewGroup?: "RU" | "IG" | null;
    personUid?: string | null;
    chatUuid: string | null;
    citizenship: string | null;
  },
): boolean {
  if (candidateReviewGroup(candidate) === "IG")
    return previousDocumentOwnerMatches(doc, candidate.personUid);
  if (
    (doc.sourceErpId ?? doc.sourceId).startsWith("candidate|") &&
    !doc.sourcePersonUid
  )
    return true;
  const ownerKnown =
    !!doc.sourcePersonUid || /#owner:[a-f0-9]{32}$/.test(doc.sourceId);
  return (
    ownerKnown &&
    (doc.sourceCandidatePersonUid ?? null) === (candidate.personUid ?? null) &&
    // Without a current local person link, only a live ERP snapshot can
    // expose the person-owned row. An archived row still belongs to history.
    (doc.originalAvailable !== false ||
      previousDocumentOwnerMatches(doc, candidate.personUid))
  );
}
