import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Candidate } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { resolveLocationScope } from "../auth/access-rules";
import { candidateGroupAccessWhere, canReviewGroup } from "./review-group";

@Injectable()
export class DocumentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  candidateWhere(principal: AuthPrincipal): Prisma.CandidateWhereInput {
    const scope = resolveLocationScope(principal);
    const group = candidateGroupAccessWhere(principal);
    const location = scope.all ? {} : { locationId: { in: scope.locationIds } };
    return Object.keys(group).length
      ? scope.all
        ? group
        : { AND: [location, group] }
      : location;
  }

  documentWhere(principal: AuthPrincipal): Prisma.DocumentWhereInput {
    const scope = resolveLocationScope(principal);
    const location: Prisma.DocumentWhereInput = scope.all
      ? {}
      : {
          OR: [
            { candidate: { locationId: { in: scope.locationIds } } },
            { employee: { locationId: { in: scope.locationIds } } },
          ],
        };
    const group = candidateGroupAccessWhere(principal);
    if (!Object.keys(group).length) return location;
    // The employee relation can widen location access, never candidate-group access.
    return {
      AND: [
        location,
        {
          OR: [
            { candidate: group },
            ...(canReviewGroup(principal, "RU") ? [{ candidateId: null }] : []),
          ],
        },
      ],
    };
  }

  async candidate(id: string, principal: AuthPrincipal): Promise<Candidate> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id, ...this.candidateWhere(principal) },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");
    return candidate;
  }

  documentReviewWhere(principal: AuthPrincipal): Prisma.DocumentWhereInput {
    const document = this.documentWhere(principal);
    const group = candidateGroupAccessWhere(principal, true);
    // Both review groups impose no additional restriction. An empty relation
    // branch inside OR is omitted by Prisma and would leave only candidateId
    // IS NULL, denying every candidate document to full-access reviewers.
    if (!Object.keys(group).length) return document;
    return {
      AND: [
        document,
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
