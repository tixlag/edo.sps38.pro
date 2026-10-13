import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/auth-principal';
import { resolveLocationScope } from '../auth/access-rules';
import type { MeResponseDto } from './dto/me-response.dto';

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  async get(principal?: AuthPrincipal): Promise<MeResponseDto> {
    if (!principal) throw new UnauthorizedException('Missing principal');
    // Identity comes from the verified JWT. Never match people by name or create a case.
    let employee = principal.code1c
      ? await this.prisma.lkEmployee.findUnique({ where: { code1c: principal.code1c } })
      : null;
    if (!employee) {
      const matches = await this.prisma.lkEmployee.findMany({ where: { uuid: principal.uuid }, take: 2 });
      if (matches.length === 1) employee = matches[0];
    }
    return {
      uuid: principal.uuid,
      code1c: principal.code1c,
      fullName: employee?.fullName ?? null,
      positionName: employee?.positionName ?? null,
      departmentName: employee?.departmentName ?? null,
      organizationName: employee?.organizationName ?? null,
      permissions: principal.accessRules,
      locationScope: resolveLocationScope(principal),
    };
  }
}
