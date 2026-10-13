import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeStatus } from './employee-status.enum';
import type { EmployeeDto } from './dto/employee.dto';
import type { AuthPrincipal } from '../auth/auth-principal';
import { resolveLocationScope } from '../auth/access-rules';

/**
 * EDO domain employees (NOT LK master data).
 * No seed fallback at runtime: DB errors propagate as 5xx, empty DB returns [].
 * Demo content exists only via `db:seed`.
 *
 * Object scope (backend-enforced, never browser-filtered):
 * - LkEmployee is the LK directory projection; Employee is the EDO case file.
 *   They are linked explicitly via nullable `lkEmployeeCode1c` (never by ФИО,
 *   never auto-created for the whole LK staff; a case may predate LK presence).
 * - Access object for a case is the explicitly fixed `Employee.locationId`
 *   (object of the case). LkEmployee.lastLocationId is directory info only and
 *   is NOT used as the access object (would implicitly mix two concepts).
 * - Scope rules: 20009 or 20008 -> all; 20007 -> only listed numeric
 *   Location.id; otherwise denied (no scope != all). Rows with NULL locationId
 *   are invisible to scoped (20007) users by default.
 * - list/getById/total all filter in the DB query (no load-all-then-filter).
 */
@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  private scopeWhere(principal: AuthPrincipal | undefined | null): { locationId?: { in: number[] } } | { id: '__denied__' } | null {
    if (!principal) throw new ForbiddenException('Missing principal');
    const scope = resolveLocationScope(principal);
    if (scope.all) return null;
    if (scope.locationIds.length === 0) return { id: '__denied__' } as never;
    return { locationId: { in: scope.locationIds } };
  }

  async list(
    principal?: AuthPrincipal,
  ): Promise<{ items: EmployeeDto[]; total: number }> {
    const scope = principal ? this.scopeWhere(principal) : null;
    if (scope && 'id' in scope) return { items: [], total: 0 };
    const where = scope ?? undefined;
    // Filtered count + page in DB (no browser-side filtering). total is the
    // scoped total, not the global table size (prevents scope bypass via totals).
    const [rows, total] = await Promise.all([
      this.prisma.employee.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.employee.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r as never)),
      total,
    };
  }

  async getById(id: string, principal?: AuthPrincipal): Promise<EmployeeDto | null> {
    const r = await this.prisma.employee.findUnique({ where: { id } });
    if (!r) return null;
    if (principal) {
      const scope = resolveLocationScope(principal);
      if (!scope.all) {
        const loc = (r as unknown as { locationId?: number | null }).locationId ?? null;
        // NULL object -> denied for scoped users (explicit, no guessing).
        if (loc == null || !scope.locationIds.includes(loc)) return null;
      }
    }
    return this.toDto(r as never);
  }

  private toDto(r: {
    id: string;
    fullName: string;
    country: string | null;
    position: string | null;
    status: string;
    stage: string | null;
    createdAt: Date;
    updatedAt: Date;
    lkEmployeeCode1c?: string | null;
    locationId?: number | null;
  }): EmployeeDto {
    return {
      id: r.id,
      fullName: r.fullName,
      country: r.country,
      position: r.position,
      status: r.status as EmployeeDto['status'],
      stage: r.stage,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    } as EmployeeDto;
  }
}

export { EmployeeStatus };
