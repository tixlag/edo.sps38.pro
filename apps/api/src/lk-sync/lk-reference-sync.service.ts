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

export interface SnapshotCounts {
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
 * Reconciliation marking (marker-only full-snapshot strategy):
 * - every row seen during a full snapshot is stamped with lastSeenSyncId;
 * - after ALL four endpoints succeed, rows with
 *   `lastSeenSyncId IS NULL OR lastSeenSyncId <> <runId>` are marked:
 *   refs -> deleted=true, employees -> sourcePresent=false (never fired);
 * - no code1c lists are kept in memory (marker-only, safe for large staff);
 * - a partially failed snapshot never marks missing rows;
 * - an endpoint returning 0 rows skips marking for that table (safety guard).
 * - MUST run with the live RabbitMQ consumer paused via the distributed
 *   reconciliation lock (see LkReconciliationLockService and run-sync.ts):
 *   queue buffers events, snapshot runs, then the consumer replays buffered
 *   events. Parallel online sync + consumer is NOT safe (no reliable LK
 *   entity revision).
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
    const loc = await this.syncLocations(c, runId);
    const pos = await this.syncPositions(c, runId);
    const dep = await this.syncDepartments(c, runId);
    const emp = await this.syncEmployees(c, runId);
    await this.markMissing(runId, {
      locations: loc.count,
      positions: pos.count,
      departments: dep.count,
      employees: emp.count,
    });
    await this.audit.log({
      action: 'LK_REFERENCE_SYNCED',
      entityType: 'LkReference',
      entityId: 'all',
      after: {
        locations: loc.count,
        positions: pos.count,
        departments: dep.count,
        employees: emp.count,
        syncId: runId,
      },
    });
    return {
      locations: loc.count,
      positions: pos.count,
      departments: dep.count,
      employees: emp.count,
    };
  }

  async syncLocations(client?: LkEdoClient, syncId?: string): Promise<{ count: number }> {
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
    return { count: items.length };
  }

  async syncPositions(client?: LkEdoClient, syncId?: string): Promise<{ count: number }> {
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
    return { count: items.length };
  }

  async syncDepartments(client?: LkEdoClient, syncId?: string): Promise<{ count: number }> {
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
    return { count: items.length };
  }

  async syncEmployees(
    client?: LkEdoClient,
    syncId?: string,
    limit = 500,
  ): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    let cursor: string | null | undefined = undefined;
    let total = 0;
    for (;;) {
      const page = await c.listEmployeesPage(limit, cursor ?? null);
      for (const emp of page.items) {
        await this.upsertEmployee(emp, syncId);
        total += 1;
      }
      // Advance the in-memory cursor only after the page was fully written.
      // A crash restarts the whole employee snapshot from the start; this is
      // safe because upserts are idempotent and a fresh syncRunId is used.
      // markMissing runs only after the full pass succeeds.
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return { count: total };
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

  /**
   * Marker-only reconciliation: mark every row NOT stamped with the current
   * runId (including legacy NULL rows — SQL `<>` alone would miss them).
   * Prisma: `{ OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }] }`
   * compiles to `lastSeenSyncId IS NULL OR lastSeenSyncId <> runId`.
   */
  private async markMissing(runId: string, counts: SnapshotCounts): Promise<void> {
    // Reference data absent from a successful snapshot -> soft deleted.
    if (counts.locations > 0) {
      await (this.prisma.lkLocation.updateMany as (a: never) => Promise<unknown>)({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { deleted: true },
      } as never);
    } else {
      // Snapshot returned zero locations: do not wipe the table on a
      // potentially truncated response; operator must investigate.
      this.logger.warn('Snapshot returned 0 locations; skipping mark-missing for locations');
    }
    if (counts.positions > 0) {
      await (this.prisma.lkPosition.updateMany as (a: never) => Promise<unknown>)({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { deleted: true },
      } as never);
    } else {
      this.logger.warn('Snapshot returned 0 positions; skipping mark-missing for positions');
    }
    if (counts.departments > 0) {
      await (this.prisma.lkDepartment.updateMany as (a: never) => Promise<unknown>)({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { deleted: true },
      } as never);
    } else {
      this.logger.warn('Snapshot returned 0 departments; skipping mark-missing for departments');
    }
    // Employees absent from snapshot -> technically not present, never `fired`.
    if (counts.employees > 0) {
      await (this.prisma.lkEmployee.updateMany as (a: never) => Promise<unknown>)({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { sourcePresent: false },
      } as never);
    } else {
      this.logger.warn('Snapshot returned 0 employees; skipping mark-missing for employees');
    }
  }
}
