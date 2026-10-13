import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Candidate } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { resolveLocationScope } from "../auth/access-rules";

@Injectable()
export class DocumentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  candidateWhere(principal: AuthPrincipal): Prisma.CandidateWhereInput {
    const scope = resolveLocationScope(principal);
    return scope.all ? {} : { locationId: { in: scope.locationIds } };
  }

  documentWhere(principal: AuthPrincipal): Prisma.DocumentWhereInput {
    const scope = resolveLocationScope(principal);
    return scope.all
      ? {}
      : {
          OR: [
            { candidate: { locationId: { in: scope.locationIds } } },
            { employee: { locationId: { in: scope.locationIds } } },
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
