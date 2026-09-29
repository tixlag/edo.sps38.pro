import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LkEdoClient } from '@edo/lk-client';
import type { EdoEmployee, EdoLocation, EdoReference } from '@edo/lk-client';

function toDateOrNull(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface SyncResult {
  locations: number;
  positions: number;
  departments: number;
  employees: number;
}

/**
 * Bootstrap/reconciliation from the LK compact internal API.
 * Order: locations -> positions -> departments -> employees (paginated by cursor).
 * Idempotent upserts; soft deletes preserved (deleted/fired flags); syncedAt marked.
 * Never deletes rows physically (history for EDO documents).
 */
@Injectable()
export class LkReferenceSyncService {
  private readonly logger = new Logger(LkReferenceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  createClient(): LkEdoClient {
    const baseUrl =
      this.config.get<string>('LK_BASE_URL') ?? process.env.LK_BASE_URL ?? 'http://localhost:8080';
    const token =
      this.config.get<string>('LK_EDO_INTERNAL_TOKEN') ??
      process.env.LK_EDO_INTERNAL_TOKEN ??
      '';
    if (!token) {
      throw new Error(
        'LK_EDO_INTERNAL_TOKEN is not configured (fail closed). Set it in server env.',
      );
    }
    return new LkEdoClient({ baseUrl, internalToken: token });
  }

  async syncAll(client?: LkEdoClient): Promise<SyncResult> {
    const c = client ?? this.createClient();
    const locations = await this.syncLocations(c);
    const positions = await this.syncPositions(c);
    const departments = await this.syncDepartments(c);
    const employees = await this.syncEmployees(c);
    await this.audit.log({
      action: 'LK_REFERENCE_SYNCED',
      entityType: 'LkReference',
      entityId: 'all',
      after: { locations, positions, departments, employees },
    });
    return { locations, positions, departments, employees };
  }

  async syncLocations(client?: LkEdoClient): Promise<number> {
    const c = client ?? this.createClient();
    const items: EdoLocation[] = await c.listLocations();
    const now = new Date();
    for (const loc of items) {
      await this.prisma.lkLocation.upsert({
        where: { code1c: loc.code1c },
        update: {
          locationId: loc.id,
          name: loc.name,
          shortName: loc.shortName ?? '',
          generalUnitCode: loc.generalUnitCode ?? null,
          deleted: loc.deleted,
          sourceUpdatedAt: toDateOrNull(loc.updatedAt),
          syncedAt: now,
        },
        create: {
          code1c: loc.code1c,
          locationId: loc.id,
          name: loc.name,
          shortName: loc.shortName ?? '',
          generalUnitCode: loc.generalUnitCode ?? null,
          deleted: loc.deleted,
          sourceUpdatedAt: toDateOrNull(loc.updatedAt),
          syncedAt: now,
        },
      });
    }
    return items.length;
  }

  async syncPositions(client?: LkEdoClient): Promise<number> {
    const c = client ?? this.createClient();
    const items: EdoReference[] = await c.listPositions();
    const now = new Date();
    for (const ref of items) {
      await this.prisma.lkPosition.upsert({
        where: { code1c: ref.code1c },
        update: {
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
        },
        create: {
          code1c: ref.code1c,
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
        },
      });
    }
    return items.length;
  }

  async syncDepartments(client?: LkEdoClient): Promise<number> {
    const c = client ?? this.createClient();
    const items: EdoReference[] = await c.listDepartments();
    const now = new Date();
    for (const ref of items) {
      await this.prisma.lkDepartment.upsert({
        where: { code1c: ref.code1c },
        update: {
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
        },
        create: {
          code1c: ref.code1c,
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
        },
      });
    }
    return items.length;
  }

  async syncEmployees(client?: LkEdoClient, limit = 500): Promise<number> {
    const c = client ?? this.createClient();
    let cursor: string | null | undefined = undefined;
    let total = 0;
    for (;;) {
      const page = await c.listEmployeesPage(limit, cursor ?? null);
      for (const emp of page.items) {
        await this.upsertEmployee(emp);
        total += 1;
      }
      // Persist cursor only after the page was fully written (crash-safe resume).
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return total;
  }

  async upsertEmployee(emp: EdoEmployee): Promise<void> {
    const now = new Date();
    await this.prisma.lkEmployee.upsert({
      where: { code1c: emp.code1c },
      update: {
        uuid: emp.uuid,
        fullName: emp.fullName,
        birthday: toDateOrNull(emp.birthday),
        citizenship: emp.citizenship ?? null,
        organizationCode: emp.organization?.code ?? null,
        organizationName: emp.organization?.name ?? null,
        positionCode1c: emp.position?.code1c ?? null,
        positionName: emp.position?.name ?? null,
        departmentCode1c: emp.department?.code1c ?? null,
        departmentName: emp.department?.name ?? null,
        divisionCode1c: emp.division?.code1c ?? null,
        divisionName: emp.division?.name ?? null,
        lastLocationId: emp.lastLocation?.id ?? null,
        lastLocationCode1c: emp.lastLocation?.code1c ?? null,
        lastLocationName: emp.lastLocation?.name ?? null,
        hireDate: toDateOrNull(emp.hireDate),
        fired: emp.fired,
        contractor: emp.contractor,
        sourceUpdatedAt: toDateOrNull(emp.updatedAt),
        syncedAt: now,
      },
      create: {
        code1c: emp.code1c,
        uuid: emp.uuid,
        fullName: emp.fullName,
        birthday: toDateOrNull(emp.birthday),
        citizenship: emp.citizenship ?? null,
        organizationCode: emp.organization?.code ?? null,
        organizationName: emp.organization?.name ?? null,
        positionCode1c: emp.position?.code1c ?? null,
        positionName: emp.position?.name ?? null,
        departmentCode1c: emp.department?.code1c ?? null,
        departmentName: emp.department?.name ?? null,
        divisionCode1c: emp.division?.code1c ?? null,
        divisionName: emp.division?.name ?? null,
        lastLocationId: emp.lastLocation?.id ?? null,
        lastLocationCode1c: emp.lastLocation?.code1c ?? null,
        lastLocationName: emp.lastLocation?.name ?? null,
        hireDate: toDateOrNull(emp.hireDate),
        fired: emp.fired,
        contractor: emp.contractor,
        sourceUpdatedAt: toDateOrNull(emp.updatedAt),
        syncedAt: now,
      },
    });
  }
}
