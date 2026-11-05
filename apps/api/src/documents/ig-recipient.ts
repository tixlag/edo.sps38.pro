import type { ErpIdentity } from "./erp-workspace.client";
import { candidateReviewGroup } from "./review-group";

type Candidate = {
  code1c: string | null;
  personUid: string | null;
  chatUuid: string | null;
  citizenship: string | null;
  reviewGroup?: "RU" | "IG" | null;
};
export function isIgRecipient(candidate: Candidate): boolean {
  return (candidate.reviewGroup ?? candidateReviewGroup(candidate)) === "IG";
}
export function matchesIgRecipient(
  candidate: Candidate,
  identity?: ErpIdentity,
): boolean {
  return (
    isIgRecipient(candidate) &&
    identity?.recipientType === "person" &&
    identity.reviewGroup === "IG" &&
    !!identity.personUid &&
    !!candidate.personUid &&
    !!candidate.code1c &&
    identity.personUid === candidate.personUid &&
    identity.code1C === candidate.code1c &&
    !identity.chatUuid &&
    !identity.erpUid
  );
}
