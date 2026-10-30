import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { AuthPrincipal } from "../auth/auth-principal";
import { hasAccessRule, resolveLocationScope } from "../auth/access-rules";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { canReviewGroup, reviewGroupWhere } from "../documents/review-group";

/** Signing is independent from review and audit capabilities. Review only widens recipient scope. */
export function signingCandidateWhere(
  principal: AuthPrincipal,
): Prisma.CandidateWhereInput {
  if (!hasAccessRule(principal.accessRules, EdoAccessRule.SIGNING))
    throw new ForbiddenException("Нет права подписания документов");
  const scope = resolveLocationScope(principal);
  if (scope.all) return {};
  const alternatives: Prisma.CandidateWhereInput[] = [];
  if (scope.locationIds.length)
    alternatives.push({ locationId: { in: scope.locationIds } });
  if (canReviewGroup(principal, "RU"))
    alternatives.push(reviewGroupWhere("RU"));
  if (canReviewGroup(principal, "IG"))
    alternatives.push(reviewGroupWhere("IG"));
  return alternatives.length ? { OR: alternatives } : { id: { in: [] } };
}

export function ownContractWhere(
  principal: AuthPrincipal,
): Prisma.SigningContractWhereInput {
  if (!principal.code1c)
    throw new ForbiddenException("В сессии ЛК отсутствует код сотрудника");
  return {
    recipientCode1c: principal.code1c,
    status: { in: ["WAITING_EMPLOYEE", "COMPLETED", "DECLINED"] },
  };
}
