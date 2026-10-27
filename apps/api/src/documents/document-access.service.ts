import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Candidate } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { hasAccessRule, resolveLocationScope } from "../auth/access-rules";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { candidateGroupAccessWhere, canReviewGroup } from "./review-group";

@Injectable()
export class DocumentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  candidateWhere(principal: AuthPrincipal): Prisma.CandidateWhereInput {
    const group = candidateGroupAccessWhere(principal, true);
    const review =
      canReviewGroup(principal, "RU") || canReviewGroup(principal, "IG");
    const scope = resolveLocationScope(principal);
    const location = scope.all ? {} : { locationId: { in: scope.locationIds } };
    if (hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW)) {
      if (scope.all) return {};
      if (!review) return location;
      if (!Object.keys(group).length) return {};
      return scope.locationIds.length ? { OR: [group, location] } : group;
    }
    return review || scope.all ? group : { AND: [location, group] };
  }

  documentWhere(principal: AuthPrincipal): Prisma.DocumentWhereInput {
    const review =
      canReviewGroup(principal, "RU") || canReviewGroup(principal, "IG");
    const group = this.documentReviewWhere(principal);
    const scope = resolveLocationScope(principal);
    const location: Prisma.DocumentWhereInput = scope.all
      ? {}
      : {
          OR: [
            { candidate: { locationId: { in: scope.locationIds } } },
            { employee: { locationId: { in: scope.locationIds } } },
          ],
        };
    // Reviewer and audit grants are independent branches. Review removes
    // geography only for its own groups, never for the audit branch.
    if (hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW)) {
      if (scope.all) return {};
      if (!review) return location;
      if (!Object.keys(group).length) return {};
      return scope.locationIds.length ? { OR: [group, location] } : group;
    }
    return review ? group : { AND: [location, group] };
  }

  async candidate(id: string, principal: AuthPrincipal): Promise<Candidate> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id, ...this.candidateWhere(principal) },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");
    return candidate;
  }

  documentReviewWhere(principal: AuthPrincipal): Prisma.DocumentWhereInput {
    const group = candidateGroupAccessWhere(principal, true);
    if (!Object.keys(group).length) return {};
    return {
      AND: [
        {},
        {
          OR: [
            { candidate: group },
            ...(canReviewGroup(principal, "RU") ? [{ candidateId: null }] : []),
          ],
        },
      ],
    };
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
