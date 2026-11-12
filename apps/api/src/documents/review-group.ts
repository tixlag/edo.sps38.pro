import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { AuthPrincipal } from "../auth/auth-principal";
import { hasAccessRule } from "../auth/access-rules";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { PASSPORT_UID } from "../ocr/ocr-profile";

export type ReviewGroup = "RU" | "IG";
export const IG_PASSPORT_LATIN_FIELDS = [
  "lastNameLatin",
  "firstNameLatin",
  "middleNameLatin",
] as const;
export const IG_PASSPORT_OCR_NAMES: Record<string, string> = {
  pas_surname: "lastNameLatin",
  pas_name: "firstNameLatin",
  pas_patronymic: "middleNameLatin",
};

export function candidateReviewGroup(candidate: {
  reviewGroup?: ReviewGroup | null;
  chatUuid: string | null;
  citizenship: string | null;
}): ReviewGroup {
  if (candidate.reviewGroup) return candidate.reviewGroup;
  return candidate.chatUuid?.trim() ||
    candidate.citizenship?.trim().toLowerCase() === "ru"
    ? "RU"
    : "IG";
}

export function isForeignPassport(document: {
  candidate: {
    reviewGroup?: ReviewGroup | null;
    chatUuid: string | null;
    citizenship: string | null;
  } | null;
  documentType: { code: string; erpUid: string | null } | null;
}): boolean {
  const type = document.documentType;
  return (
    !!document.candidate &&
    candidateReviewGroup(document.candidate) === "IG" &&
    !!type &&
    (type.erpUid
      ? type.erpUid.toLowerCase() === PASSPORT_UID
      : type.code === "PASSPORT")
  );
}

export function reviewGroupWhere(
  group: ReviewGroup,
): Prisma.CandidateWhereInput {
  return {
    OR: [
      { reviewGroup: group },
      group === "RU"
        ? {
            reviewGroup: null,
            OR: [{ chatUuid: { not: null } }, { citizenship: "ru" }],
          }
        : {
            reviewGroup: null,
            AND: [
              { chatUuid: null },
              { OR: [{ citizenship: null }, { citizenship: { not: "ru" } }] },
            ],
          },
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
