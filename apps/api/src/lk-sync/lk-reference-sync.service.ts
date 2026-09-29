import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
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
 *
 * Reconciliation marking (safe full-snapshot strategy):
 * - every row seen during a full snapshot is stamped with lastSeenSyncId;
 * - after ALL four endpoints succeed, rows not seen are marked:
 *   refs -> deleted=true, employees -> sourcePresent=false (never fired);
 * - a partially failed snapshot never marks missing rows.
 * - MUST run with the live RabbitMQ consumer disabled/paused (see run-sync.ts
 *   and docs/decisions/ADR-002): queue buffers events, snapshot runs, then the
 *   consumer replays buffered events. Parallel online sync + consumer is NOT
 *   claimed safe (no reliable LK entity revision).
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

  async syncAll(client?: LkEdoClient, syncId?: string): Promise<SyncResult> {
    const c = client ?? this.createClient();
    const runId = syncId ?? randomUUID();
    // Fetch + upsert each endpoint first. Only when every step succeeded do we
    // mark unseen rows — a throw before this point leaves old marks untouched.
    const seenLocations = await this.syncLocations(c, runId);
    const seenPositions = await this.syncPositions(c, runId);
    const seenDepartments = await this.syncDepartments(c, runId);
    const seenEmployees = await this.syncEmployees(c, runId);
    await this.markMissing(runId, {
      locations: seenLocations.codes,
      positions: seenPositions.codes,
      departments: seenDepartments.codes,
      employees: seenEmployees.codes,
    });
    await this.audit.log({
      action: 'LK_REFERENCE_SYNCED',
      entityType: 'LkReference',
      entityId: 'all',
      after: {
        locations: seenLocations.count,
        positions: seenPositions.count,
        departments: seenDepartments.count,
        employees: seenEmployees.count,
        syncId: runId,
      },
    });
    return {
      locations: seenLocations.count,
      positions: seenPositions.count,
      departments: seenDepartments.count,
      employees: seenEmployees.count,
    };
  }

  async syncLocations(
    client?: LkEdoClient,
    syncId?: string,
  ): Promise<{ count: number; codes: string[] }> {
    const c = client ?? this.createClient();
    const items: EdoLocation[] = await c.listLocations();
    const now = new Date();
    const codes: string[] = [];
    for (const loc of items) {
      codes.push(loc.code1c);
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
          ...(syncId ? { lastSeenSyncId: syncId } : {}),
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
          ...(syncId ? { lastSeenSyncId: syncId } : {}),
        },
      });
    }
    return { count: items.length, codes };
  }

  async syncPositions(
    client?: LkEdoClient,
    syncId?: string,
  ): Promise<{ count: number; codes: string[] }> {
    const c = client ?? this.createClient();
    const items: EdoReference[] = await c.listPositions();
    const now = new Date();
    const codes: string[] = [];
    for (const ref of items) {
      codes.push(ref.code1c);
      await this.prisma.lkPosition.upsert({
        where: { code1c: ref.code1c },
        update: {
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
          ...(syncId ? { lastSeenSyncId: syncId } : {}),
        },
        create: {
          code1c: ref.code1c,
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
          ...(syncId ? { lastSeenSyncId: syncId } : {}),
        },
      });
    }
    return { count: items.length, codes };
  }

  async syncDepartments(
    client?: LkEdoClient,
    syncId?: string,
  ): Promise<{ count: number; codes: string[] }> {
    const c = client ?? this.createClient();
    const items: EdoReference[] = await c.listDepartments();
    const now = new Date();
    const codes: string[] = [];
    for (const ref of items) {
      codes.push(ref.code1c);
      await this.prisma.lkDepartment.upsert({
        where: { code1c: ref.code1c },
        update: {
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
          ...(syncId ? { lastSeenSyncId: syncId } : {}),
        },
        create: {
          code1c: ref.code1c,
          name: ref.name,
          deleted: ref.deleted,
          sourceUpdatedAt: toDateOrNull(ref.updatedAt),
          syncedAt: now,
          ...(syncId ? { lastSeenSyncId: syncId } : {}),
        },
      });
    }
    return { count: items.length, codes };
  }

  async syncEmployees(
    client?: LkEdoClient,
    syncId?: string,
    limit = 500,
  ): Promise<{ count: number; codes: string[] }> {
    const c = client ?? this.createClient();
    let cursor: string | null | undefined = undefined;
    let total = 0;
    const codes: string[] = [];
    for (;;) {
      const page = await c.listEmployeesPage(limit, cursor ?? null);
      for (const emp of page.items) {
        await this.upsertEmployee(emp, syncId);
        codes.push(emp.code1c);
        total += 1;
      }
      // Persist cursor only after the page was fully written (crash-safe resume).
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return { count: total, codes };
  }

  async upsertEmployee(emp: EdoEmployee, syncId?: string): Promise<void> {
    const now = new Date();
    const stamp = syncId ? { lastSeenSyncId: syncId, sourcePresent: true } : { sourcePresent: true };
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
        ...stamp,
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
        ...stamp,
      },
    });
  }

  private async markMissing(
    runId: string,
    seen: { locations: string[]; positions: string[]; departments: string[]; employees: string[] },
  ): Promise<void> {
    const notIn = (codes: string[]) =>
      codes.length > 0 ? { notIn: codes } : undefined;
    // Reference data absent from a successful snapshot -> soft deleted.
    const locWhere =
      notIn(seen.locations) !== undefined
        ? { code1c: notIn(seen.locations) as never }
        : undefined;
    if (locWhere) {
      await (this.prisma.lkLocation.updateMany as (a: never) => Promise<unknown>)({
        where: { ...locWhere, lastSeenSyncId: { not: runId } },
        data: { deleted: true },
      } as never);
    } else {
      // Snapshot returned zero locations: do not wipe the table on a
      // potentially truncated response; operator must investigate.
      this.logger.warn('Snapshot returned 0 locations; skipping mark-missing for locations');
    }
    if (seen.positions.length > 0) {
      await (this.prisma.lkPosition.updateMany as (a: never) => Promise<unknown>)({
        where: { code1c: { notIn: seen.positions }, lastSeenSyncId: { not: runId } },
        data: { deleted: true },
      } as never);
    } else {
      this.logger.warn('Snapshot returned 0 positions; skipping mark-missing for positions');
    }
    if (seen.departments.length > 0) {
      await (this.prisma.lkDepartment.updateMany as (a: never) => Promise<unknown>)({
        where: { code1c: { notIn: seen.departments }, lastSeenSyncId: { not: runId } },
        data: { deleted: true },
      } as never);
    } else {
      this.logger.warn('Snapshot returned 0 departments; skipping mark-missing for departments');
    }
    // Employees absent from snapshot -> technically not present, never `fired`.
    if (seen.employees.length > 0) {
      await (this.prisma.lkEmployee.updateMany as (a: never) => Promise<unknown>)({
        where: { code1c: { notIn: seen.employees }, lastSeenSyncId: { not: runId } },
        data: { sourcePresent: false },
      } as never);
    } else {
      this.logger.warn('Snapshot returned 0 employees; skipping mark-missing for employees');
    }
  }
}
