import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Candidate } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { hasAccessRule } from "../auth/access-rules";
import { resolveLocationScope } from "../auth/access-rules";
import { canReviewGroup } from "./review-group";

@Injectable()
export class DocumentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  candidateWhere(principal: AuthPrincipal): Prisma.CandidateWhereInput {
    if (hasAccessRule(principal.accessRules, EdoAccessRule.FULL_ACCESS))
      return {};
    const groups = (["RU", "IG"] as const).filter((g) =>
      canReviewGroup(principal, g),
    );
    const review: Prisma.CandidateWhereInput = { reviewGroup: { in: groups } };
    if (!hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW))
      return review;
    const scope = resolveLocationScope(principal);
    return {
      OR: [review, scope.all ? {} : { locationId: { in: scope.locationIds } }],
    };
  }

  documentWhere(principal: AuthPrincipal): Prisma.DocumentWhereInput {
    if (hasAccessRule(principal.accessRules, EdoAccessRule.FULL_ACCESS))
      return {};
    const review = this.documentReviewWhere(principal);
    if (!hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW))
      return review;
    const scope = resolveLocationScope(principal);
    const audit: Prisma.DocumentWhereInput = {
      AND: [
        scope.all
          ? {}
          : {
              OR: [
                { candidate: { locationId: { in: scope.locationIds } } },
                { employee: { locationId: { in: scope.locationIds } } },
              ],
            },
      ],
    };
    return { OR: [review, audit] };
  }

  async candidate(id: string, principal: AuthPrincipal): Promise<Candidate> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id, ...this.candidateWhere(principal) },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");
    return candidate;
  }

  documentReviewWhere(principal: AuthPrincipal): Prisma.DocumentWhereInput {
    const groups = (["RU", "IG"] as const).filter((g) =>
      canReviewGroup(principal, g),
    );
    return { reviewGroup: { in: groups } };
  }

  async document(id: string, principal: AuthPrincipal) {
    const document = await this.prisma.document.findFirst({
      where: { id, ...this.documentWhere(principal) },
    });
    if (!document) throw new NotFoundException("Document not found");
    return document;
  }

  async employee(id: string, principal: AuthPrincipal) {
    const scope = resolveLocationScope(principal);
    const employee = await this.prisma.employee.findFirst({
      where: {
        id,
        ...(scope.all ? {} : { locationId: { in: scope.locationIds } }),
      },
    });
    if (!employee) throw new NotFoundException("Employee not found");
    return employee;
  }
}
