import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { AuthPrincipal } from "../auth/auth-principal";
import { hasAccessRule } from "../auth/access-rules";
import { EdoAccessRule } from "../auth/edo-access-rule";

export type ReviewGroup = "RU" | "IG";

export function candidateReviewGroup(candidate: {
  chatUuid: string | null;
  citizenship: string | null;
}): ReviewGroup {
  return candidate.chatUuid?.trim() ||
    candidate.citizenship?.trim().toLowerCase() === "ru"
    ? "RU"
    : "IG";
}

export function reviewGroupWhere(
  group: ReviewGroup,
): Prisma.CandidateWhereInput {
  return group === "RU"
    ? { OR: [{ chatUuid: { not: null } }, { citizenship: "ru" }] }
    : {
        AND: [
          { chatUuid: null },
          { OR: [{ citizenship: null }, { citizenship: { not: "ru" } }] },
        ],
      };
}

export function canReviewGroup(
  principal: AuthPrincipal,
  group: ReviewGroup,
): boolean {
  return hasAccessRule(
    principal.accessRules,
    group === "RU"
      ? EdoAccessRule.DOCUMENT_REVIEW_RU
      : EdoAccessRule.DOCUMENT_REVIEW_IG,
  );
}

export function requireReviewGroup(
  principal: AuthPrincipal,
  group: ReviewGroup,
): void {
  if (!canReviewGroup(principal, group))
    throw new ForbiddenException(
      "Missing required EDO review group access rule",
    );
}

/** Audit keeps its independent read permission. It never grants review actions. */
export function candidateGroupAccessWhere(
  principal: AuthPrincipal,
  reviewOnly = false,
): Prisma.CandidateWhereInput {
  if (
    !reviewOnly &&
    hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW)
  )
    return {};
  const ru = canReviewGroup(principal, "RU"),
    ig = canReviewGroup(principal, "IG");
  if (ru && ig) return {};
  if (ru || ig) return reviewGroupWhere(ru ? "RU" : "IG");
  return { id: { in: [] } };
}
