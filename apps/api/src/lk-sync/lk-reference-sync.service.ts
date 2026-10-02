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

export interface SyncAllOptions {
  /** Fencing guard (Redis lock handle). Required in production; tests pass a fake or allowUnguarded. */
  guard?: ReconciliationGuard;
  /** Allow running without guard (unit tests only; production run-sync always passes a guard). */
  allowUnguardedForTests?: boolean;
  /** AbortSignal for cancellation (CLI timeout, shutdown). */
  signal?: AbortSignal;
  /** Overall deadline ms (default 10min). Heartbeat never holds past this. */
  deadlineMs?: number;
  /** Max employee pages (default 10000; protects against cursor loops). */
  maxPages?: number;
  /** Max shrinkage fraction vs previous successful run (default 0.3 = 30%). */
  maxShrinkage?: number;
  /** Explicit operator confirmation to allow anomalous shrinkage. */
  allowShrinkage?: boolean;
}

export class SnapshotAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotAbortedError';
  }
}

export class ShrinkageGuardError extends Error {
  readonly counts: SnapshotCounts;
  readonly previous: Partial<SnapshotCounts>;
  constructor(message: string, counts: SnapshotCounts, previous: Partial<SnapshotCounts>) {
    super(message);
    this.name = 'ShrinkageGuardError';
    this.counts = counts;
    this.previous = previous;
  }
}

/**
 * Ownership guard for a coordinated snapshot (the distributed lock handle).
 * Long syncs re-check it before each resource, between employee pages, and
 * immediately before markMissing. On loss the sync aborts with
 * LockOwnershipLostError and markMissing NEVER runs without the lock.
 */
export interface ReconciliationGuard {
  assertOwned: () => Promise<void>;
}

const SYNC_DEFAULT_DEADLINE_MS = 10 * 60 * 1000;
const SYNC_DEFAULT_MAX_PAGES = 10000;
const SYNC_DEFAULT_MAX_SHRINKAGE = 0.3;

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
 *
 * Fencing (DB-level, not just Redis GET before SQL):
 * - each syncAll creates a RUNNING LkSyncRun row (generation = autoincrement id);
 * - event applies check atomically in the same transaction that no RUNNING row
 *   exists (see LkEventHandler.assertNoRunningSnapshotTx); late admits abort as
 *   transient and redeliver after the snapshot;
 * - markMissing runs in a transaction that verifies the current run is still
 *   the latest RUNNING (no newer sync started after lock loss) AND the Redis
 *   guard still holds; otherwise it aborts with LockOwnershipLostError.
 * A bare Redis GET before SQL would race (snapshot acquires after the check);
 * fencing makes the check atomic with the write.
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

  async syncAll(
    client?: LkEdoClient,
    syncId?: string,
    guardOrOptions?: ReconciliationGuard | SyncAllOptions,
  ): Promise<SyncResult> {
    const c = client ?? this.createClient();
    const runId = syncId ?? randomUUID();
    const opts: SyncAllOptions =
      guardOrOptions && typeof (guardOrOptions as ReconciliationGuard).assertOwned === 'function'
        ? { guard: guardOrOptions as ReconciliationGuard }
        : ((guardOrOptions as SyncAllOptions | undefined) ?? {});
    const guard = opts.guard;
    if (!guard && !opts.allowUnguardedForTests) {
      throw new Error(
        'LK sync requires a ReconciliationGuard (distributed lock handle). ' +
          'Production must call via run-sync.ts which acquires the lock; ' +
          'unit tests pass allowUnguardedForTests:true explicitly.',
      );
    }
    const deadlineMs = opts.deadlineMs ?? SYNC_DEFAULT_DEADLINE_MS;
    const startedAt = Date.now();
    const checkDeadline = () => {
      if (opts.signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled (AbortSignal)');
      if (Date.now() - startedAt > deadlineMs) {
        throw new SnapshotAbortedError(`LK snapshot deadline exceeded (${deadlineMs}ms)`);
      }
    };
    const check = async () => {
      checkDeadline();
      if (guard) await guard.assertOwned();
    };
    // Durable run ledger: RUNNING at start (fencing generation), FINISHED/FAILED at end.
    // Memory mocks without lkSyncRun skip the ledger (handler unit tests).
    await this.createSyncRun(runId).catch(() => null);
    try {
      // Fetch + upsert each endpoint first. Only when every step succeeded (and
      // the lock is still owned) do we mark unseen rows — a throw before
      // markMissing leaves old marks untouched. Partial upserts are tolerable:
      // buffered Rabbit events + the next coordinated snapshot repair them.
      await check();
      const loc = await this.syncLocations(c, runId, opts.signal);
      await check();
      const pos = await this.syncPositions(c, runId, opts.signal);
      await check();
      const dep = await this.syncDepartments(c, runId, opts.signal);
      await check();
      const emp = await this.syncEmployees(c, runId, 500, guard, {
        signal: opts.signal,
        maxPages: opts.maxPages,
        deadlineMs: Math.max(1000, deadlineMs - (Date.now() - startedAt)),
      });
      // Re-verify ownership IMMEDIATELY before the destructive marking step:
      // a snapshot that lost its lock must never mark rows as missing.
      await check();
      const counts = { locations: loc.count, positions: pos.count, departments: dep.count, employees: emp.count };
      await this.checkShrinkageGuard(counts, opts);
      await this.markMissingFenced(runId, counts, guard);
      await this.finishSyncRun(runId, 'FINISHED', counts).catch(() => undefined);
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
    } catch (err) {
      const category = err instanceof ShrinkageGuardError ? 'SHRINKAGE' : err instanceof SnapshotAbortedError ? 'CANCELLED' : 'FAILED';
      await this.finishSyncRun(runId, 'FAILED', null, category, (err as Error).message.slice(0, 512)).catch(() => undefined);
      throw err;
    }
  }

  private async createSyncRun(runId: string): Promise<{ id: number } | null> {
    try {
      const prisma = this.prisma as unknown as {
        lkSyncRun?: { create: (a: unknown) => Promise<{ id: number }> };
      };
      if (!prisma.lkSyncRun?.create) return null;
      return await prisma.lkSyncRun.create({ data: { runId, status: 'RUNNING' } });
    } catch {
      return null;
    }
  }

  private async finishSyncRun(
    runId: string,
    status: 'FINISHED' | 'FAILED',
    counts: SnapshotCounts | null,
    errorCategory?: string,
    errorMessage?: string,
  ): Promise<void> {
    const prisma = this.prisma as unknown as {
      lkSyncRun?: { update: (a: unknown) => Promise<unknown> };
    };
    if (!prisma.lkSyncRun?.update) return;
    await prisma.lkSyncRun.update({
      where: { runId },
      data: {
        status,
        finishedAt: new Date(),
        ...(counts ? { locations: counts.locations, positions: counts.positions, departments: counts.departments, employees: counts.employees } : {}),
        ...(errorCategory ? { errorCategory, errorMessage: errorMessage?.slice(0, 1024) ?? null } : {}),
      },
    });
  }

  private async checkShrinkageGuard(counts: SnapshotCounts, opts: SyncAllOptions): Promise<void> {
    if (opts.allowShrinkage) return;
    const maxShrinkage = opts.maxShrinkage ?? SYNC_DEFAULT_MAX_SHRINKAGE;
    try {
      const prisma = this.prisma as unknown as {
        lkSyncRun?: { findFirst: (a: unknown) => Promise<{ locations: number; positions: number; departments: number; employees: number } | null> };
      };
      if (!prisma.lkSyncRun?.findFirst) return;
      const prev = await prisma.lkSyncRun.findFirst({
        where: { status: 'FINISHED' },
        orderBy: { finishedAt: 'desc' },
      });
      if (!prev) return;
      const shrink = (cur: number, old: number): number => (old > 0 ? (old - cur) / old : 0);
      const checks: Array<[keyof SnapshotCounts, number, number]> = [
        ['locations', counts.locations, prev.locations],
        ['positions', counts.positions, prev.positions],
        ['departments', counts.departments, prev.departments],
        ['employees', counts.employees, prev.employees],
      ];
      for (const [key, cur, old] of checks) {
        // Zero-count tables already skip marking; shrinkage guard only fires on
        // anomalous non-zero drops vs the last successful run.
        if (old > 0 && cur > 0 && shrink(cur, old) > maxShrinkage) {
          throw new ShrinkageGuardError(
            `LK snapshot shrinkage guard: ${key} dropped from ${old} to ${cur} (${Math.round(shrink(cur, old) * 100)}% > ${Math.round(maxShrinkage * 100)}%). ` +
              `Aborting before markMissing. Re-run with allowShrinkage:true after operator confirmation.`,
            counts,
            { [key]: old } as Partial<SnapshotCounts>,
          );
        }
      }
    } catch (err) {
      if (err instanceof ShrinkageGuardError) throw err;
      // Ledger unavailable (mocks) -> skip guard, zero-guard below still applies.
      return;
    }
  }

  async syncLocations(client?: LkEdoClient, syncId?: string, signal?: AbortSignal): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const items: EdoLocation[] = await c.listLocations(signal ? { signal } : undefined);
    const now = new Date();
    for (const loc of items) {
      if (signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during locations');
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

  async syncPositions(client?: LkEdoClient, syncId?: string, signal?: AbortSignal): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const items: EdoReference[] = await c.listPositions(signal ? { signal } : undefined);
    const now = new Date();
    for (const ref of items) {
      if (signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during positions');
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

  async syncDepartments(client?: LkEdoClient, syncId?: string, signal?: AbortSignal): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const items: EdoReference[] = await c.listDepartments(signal ? { signal } : undefined);
    const now = new Date();
    for (const ref of items) {
      if (signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during departments');
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
    guard?: ReconciliationGuard,
    opts?: { signal?: AbortSignal; maxPages?: number; deadlineMs?: number },
  ): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const maxPages = opts?.maxPages ?? SYNC_DEFAULT_MAX_PAGES;
    const deadlineMs = opts?.deadlineMs ?? SYNC_DEFAULT_DEADLINE_MS;
    const startedAt = Date.now();
    let cursor: string | null | undefined = undefined;
    let total = 0;
    const seenCursors = new Set<string>();
    let pages = 0;
    for (;;) {
      if (opts?.signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during employees');
      if (Date.now() - startedAt > deadlineMs) {
        throw new SnapshotAbortedError(`LK employee pagination deadline exceeded (${deadlineMs}ms)`);
      }
      if (pages >= maxPages) {
        throw new SnapshotAbortedError(`LK employee pagination exceeded ${maxPages} pages (cursor loop?)`);
      }
      if (guard) await guard.assertOwned();
      const page = await c.listEmployeesPage(limit, cursor ?? null, opts?.signal ? { signal: opts.signal } : undefined);
      // Validate page BEFORE applying: missing nextCursor is a contract error
      // (client throws), never end-of-snapshot. Detect cursor loops and no-progress.
      if (!('nextCursor' in (page as unknown as Record<string, unknown>))) {
        throw new SnapshotAbortedError('LK contract violation: employee page missing nextCursor');
      }
      pages += 1;
      for (const emp of page.items) {
        if (opts?.signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during employee upserts');
        await this.upsertEmployee(emp, syncId);
        total += 1;
      }
      // Advance the in-memory cursor only after the page was fully written.
      // A crash restarts the whole employee snapshot from the start; this is
      // safe because upserts are idempotent and a fresh syncRunId is used.
      // markMissing runs only after the full pass succeeds.
      const next = page.nextCursor;
      if (next === null) break;
      if (typeof next !== 'string' || next.length === 0) {
        throw new SnapshotAbortedError('LK contract violation: nextCursor must be non-empty string or null');
      }
      if (seenCursors.has(next)) {
        throw new SnapshotAbortedError(`LK pagination loop detected: cursor ${next.slice(0, 64)} repeated`);
      }
      seenCursors.add(next);
      if (page.items.length === 0) {
        // Empty page with non-null cursor = no progress; abort instead of looping.
        throw new SnapshotAbortedError('LK pagination made no progress (empty page with nextCursor)');
      }
      cursor = next;
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
   * Fenced marking: verifies in the DB that this run is still the latest
   * RUNNING (no newer sync started after lock loss) and the Redis guard still
   * holds, atomically before the destructive update. A late process that lost
   * ownership never marks. Memory mocks without lkSyncRun skip the generation
   * check but still enforce the Redis guard.
   */
  private async markMissingFenced(runId: string, counts: SnapshotCounts, guard?: ReconciliationGuard): Promise<void> {
    if (guard) await guard.assertOwned();
    try {
      const prisma = this.prisma as unknown as {
        lkSyncRun?: {
          findFirst: (a: unknown) => Promise<{ runId: string } | null>;
          findMany?: (a: unknown) => Promise<Array<{ runId: string }>>;
        };
      };
      if (prisma.lkSyncRun?.findFirst) {
        // Latest RUNNING must be us; a newer RUNNING means we lost fencing.
        const latest = await prisma.lkSyncRun.findFirst({
          where: { status: 'RUNNING' },
          orderBy: { id: 'desc' },
        });
        if (latest && latest.runId !== runId) {
          const { LockOwnershipLostError } = await import('./lk-reconciliation-lock.service');
          throw new LockOwnershipLostError(
            `LK fencing: newer snapshot ${latest.runId} started; aborting markMissing for ${runId}`,
          );
        }
        // Our own run must still be RUNNING (not finished/failed by a concurrent finisher).
        if (!latest || latest.runId !== runId) {
          // No RUNNING at all (ledger skipped in mocks) -> fall through to guard-only path.
          if (latest) {
            const { LockOwnershipLostError } = await import('./lk-reconciliation-lock.service');
            throw new LockOwnershipLostError(`LK fencing: run ${runId} is no longer RUNNING; aborting markMissing`);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && /fencing|ownership lost/i.test(err.message)) throw err;
      // Ledger unavailable -> guard-only path (unit-test mocks).
    }
    if (guard) await guard.assertOwned();
    await this.markMissing(runId, counts);
  }

  /**
   * Marker-only reconciliation: mark every row NOT stamped with the current
   * runId (including legacy NULL rows — SQL `<>` alone would miss them).
   * Prisma: `{ OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }] }`
   * compiles to `lastSeenSyncId IS NULL OR lastSeenSyncId <> runId`.
   * Never claims whole-snapshot atomicity: tables are updated piecemeal, but
   * markMissing itself runs only after all four endpoints succeeded AND fencing
   * (latest RUNNING is us + Redis guard) still holds. Partial snapshots never
   * mark missing.
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
