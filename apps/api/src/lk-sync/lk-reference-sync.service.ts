import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LkEdoClient } from '@edo/lk-client';
import type { EdoEmployee, EdoLocation, EdoReference } from '@edo/lk-client';
import { DbFencingService, toLedgerError } from './lk-fencing.service';

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

/** Fenced write context: every projection write verifies it in-transaction. */
export interface FencedCtx {
  runId: string;
  generation: bigint;
  signal?: AbortSignal;
}

type TxClient = Prisma.TransactionClient;

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
 * Fencing (proven serialization on MariaDB/InnoDB, see DbFencingService):
 * - `syncAll` acquires the fencing generation first (atomic
 *   SELECT ... FOR UPDATE on the `lk_sync_state` row; concurrent acquirers
 *   block, then exactly one wins). Ledger RUNNING row + generation are
 *   created in the same short transaction — acquire errors propagate, never
 *   degrade to an unfenced run.
 * - every projection write (each resource list, each employee page, and the
 *   final marking) runs in its own SHORT transaction that first re-verifies
 *   `activeRunId = own runId AND generation = acquired generation`. A snapshot
 *   that lost ownership (steal by a successor under the Redis lock) cannot
 *   write fields, `lastSeenSyncId`, or marks afterwards — not just markMissing.
 * - event applies take the same row lock and require no active snapshot
 *   (see LkEventHandler), so either side wins linearizably; losers abort as
 *   transient. No transaction spans HTTP pagination.
 * A bare Redis GET before SQL would race (snapshot acquires after the check);
 * the row lock makes each check atomic with its write.
 */
@Injectable()
export class LkReferenceSyncService {
  private readonly logger = new Logger(LkReferenceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly fencing: DbFencingService,
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
    // Fencing acquire FIRST (short atomic transaction: state row lock +
    // RUNNING ledger row). Any failure here aborts before any projection
    // write — never a degraded unfenced run.
    const { generation } = await this.fencing.acquireDb(runId);
    const fctx: FencedCtx = { runId, generation, signal: opts.signal };
    try {
      // Fetch + upsert each endpoint first. Only when every step succeeded (and
      // the lock is still owned) do we mark unseen rows — a throw before
      // markMissing leaves old marks untouched. Partial upserts are tolerable:
      // buffered Rabbit events + the next coordinated snapshot repair them.
      await check();
      const loc = await this.syncLocations(c, fctx);
      await check();
      const pos = await this.syncPositions(c, fctx);
      await check();
      const dep = await this.syncDepartments(c, fctx);
      await check();
      const emp = await this.syncEmployees(c, fctx, 500, guard, {
        maxPages: opts.maxPages,
        deadlineMs: Math.max(1000, deadlineMs - (Date.now() - startedAt)),
      });
      const counts = { locations: loc.count, positions: pos.count, departments: dep.count, employees: emp.count };
      await this.checkShrinkageGuard(counts, opts);
      // Redis ownership re-verified IMMEDIATELY before the marking
      // transaction; the transaction itself re-verifies the DB generation, so
      // a successor that stole fencing aborts here even if Redis also lapsed.
      // (Redis loss WITHOUT a successor has no rival writer, so the marks
      // computed from this complete snapshot stay correct.)
      await check();
      await this.prisma.$transaction(async (tx) => {
        await this.fencing.assertSnapshotMayWrite(tx as never, runId, generation);
        await this.markMissingInTx(tx as unknown as TxClient, runId, counts);
      });
      await this.fencing.releaseDb(runId, 'FINISHED', counts);
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
      // Ledger release errors never mask the original failure, but an
      // unreleased generation orphans the fencing row: the next lk:sync
      // steals it under the Redis lock (documented recovery, never silent).
      const ledger = toLedgerError(err);
      await this.fencing.releaseDb(runId, 'FAILED', null, ledger).catch((releaseErr) => {
        this.logger.error(`LK sync ledger release failed (orphaned generation, next sync steals it): ${(releaseErr as Error).message.slice(0, 160)}`);
      });
      throw err;
    }
  }

  private async checkShrinkageGuard(counts: SnapshotCounts, opts: SyncAllOptions): Promise<void> {
    if (opts.allowShrinkage) return;
    const maxShrinkage = opts.maxShrinkage ?? SYNC_DEFAULT_MAX_SHRINKAGE;
    // Ledger read errors propagate (fail closed): an unreadable ledger means
    // the coordination DB is unusable, and the snapshot must not proceed to
    // destructive marking on unknown history.
    const prev = await this.fencing.getLastFinishedCounts();
    if (!prev) return;
    const shrink = (cur: number, old: number): number => (old > 0 ? (old - cur) / old : 0);
    const checks: Array<[keyof SnapshotCounts, number, number]> = [
      ['locations', counts.locations, prev.locations],
      ['positions', counts.positions, prev.positions],
      ['departments', counts.departments, prev.departments],
      ['employees', counts.employees, prev.employees],
    ];
    for (const [key, cur, old] of checks) {
      if (old > 0 && cur > 0 && shrink(cur, old) > maxShrinkage) {
        throw new ShrinkageGuardError(
          `LK snapshot shrinkage guard: ${key} dropped from ${old} to ${cur} (${Math.round(shrink(cur, old) * 100)}% > ${Math.round(maxShrinkage * 100)}%). ` +
            `Aborting before markMissing. Re-run with allowShrinkage:true after operator confirmation.`,
          counts,
          { [key]: old } as Partial<SnapshotCounts>,
        );
      }
    }
  }

  /**
   * Resource writers: HTTP fetch happens OUTSIDE any transaction; the fetched
   * rows are then written inside ONE short transaction that first re-verifies
   * the fencing generation. A stale holder that lost ownership aborts before
   * touching fields or lastSeenSyncId (not just before markMissing).
   */
  async syncLocations(
    client?: LkEdoClient,
    ctxOrSyncId?: FencedCtx | string,
    signal?: AbortSignal,
  ): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const fctx = typeof ctxOrSyncId === 'object' ? ctxOrSyncId : undefined;
    const runId = fctx?.runId ?? (typeof ctxOrSyncId === 'string' ? ctxOrSyncId : randomUUID());
    const sig = fctx?.signal ?? signal;
    const items: EdoLocation[] = await c.listLocations(sig ? { signal: sig } : undefined);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (fctx) await this.fencing.assertSnapshotMayWrite(tx as never, fctx.runId, fctx.generation);
      for (const loc of items) {
        if (sig?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during locations');
        await (tx as unknown as TxClient).lkLocation.upsert({
          where: { code1c: loc.code1c },
          update: {
            locationId: loc.id,
            name: loc.name,
            shortName: loc.shortName ?? '',
            generalUnitCode: loc.generalUnitCode ?? null,
            deleted: loc.deleted,
            sourceUpdatedAt: toDateOrNull(loc.updatedAt),
            syncedAt: now,
            lastSeenSyncId: runId,
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
            lastSeenSyncId: runId,
          },
        });
      }
    });
    return { count: items.length };
  }

  async syncPositions(
    client?: LkEdoClient,
    ctxOrSyncId?: FencedCtx | string,
    signal?: AbortSignal,
  ): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const fctx = typeof ctxOrSyncId === 'object' ? ctxOrSyncId : undefined;
    const runId = fctx?.runId ?? (typeof ctxOrSyncId === 'string' ? ctxOrSyncId : randomUUID());
    const sig = fctx?.signal ?? signal;
    const items: EdoReference[] = await c.listPositions(sig ? { signal: sig } : undefined);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (fctx) await this.fencing.assertSnapshotMayWrite(tx as never, fctx.runId, fctx.generation);
      for (const ref of items) {
        if (sig?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during positions');
        await (tx as unknown as TxClient).lkPosition.upsert({
          where: { code1c: ref.code1c },
          update: {
            name: ref.name,
            deleted: ref.deleted,
            sourceUpdatedAt: toDateOrNull(ref.updatedAt),
            syncedAt: now,
            lastSeenSyncId: runId,
          },
          create: {
            code1c: ref.code1c,
            name: ref.name,
            deleted: ref.deleted,
            sourceUpdatedAt: toDateOrNull(ref.updatedAt),
            syncedAt: now,
            lastSeenSyncId: runId,
          },
        });
      }
    });
    return { count: items.length };
  }

  async syncDepartments(
    client?: LkEdoClient,
    ctxOrSyncId?: FencedCtx | string,
    signal?: AbortSignal,
  ): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const fctx = typeof ctxOrSyncId === 'object' ? ctxOrSyncId : undefined;
    const runId = fctx?.runId ?? (typeof ctxOrSyncId === 'string' ? ctxOrSyncId : randomUUID());
    const sig = fctx?.signal ?? signal;
    const items: EdoReference[] = await c.listDepartments(sig ? { signal: sig } : undefined);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (fctx) await this.fencing.assertSnapshotMayWrite(tx as never, fctx.runId, fctx.generation);
      for (const ref of items) {
        if (sig?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during departments');
        await (tx as unknown as TxClient).lkDepartment.upsert({
          where: { code1c: ref.code1c },
          update: {
            name: ref.name,
            deleted: ref.deleted,
            sourceUpdatedAt: toDateOrNull(ref.updatedAt),
            syncedAt: now,
            lastSeenSyncId: runId,
          },
          create: {
            code1c: ref.code1c,
            name: ref.name,
            deleted: ref.deleted,
            sourceUpdatedAt: toDateOrNull(ref.updatedAt),
            syncedAt: now,
            lastSeenSyncId: runId,
          },
        });
      }
    });
    return { count: items.length };
  }

  async syncEmployees(
    client?: LkEdoClient,
    ctxOrSyncId?: FencedCtx | string,
    limit = 500,
    guard?: ReconciliationGuard,
    opts?: { signal?: AbortSignal; maxPages?: number; deadlineMs?: number },
  ): Promise<{ count: number }> {
    const c = client ?? this.createClient();
    const fctx = typeof ctxOrSyncId === 'object' ? ctxOrSyncId : undefined;
    const runId = fctx?.runId ?? (typeof ctxOrSyncId === 'string' ? ctxOrSyncId : randomUUID());
    const signal = fctx?.signal ?? opts?.signal;
    const maxPages = opts?.maxPages ?? SYNC_DEFAULT_MAX_PAGES;
    const deadlineMs = opts?.deadlineMs ?? SYNC_DEFAULT_DEADLINE_MS;
    const startedAt = Date.now();
    let cursor: string | null | undefined = undefined;
    let total = 0;
    const seenCursors = new Set<string>();
    let pages = 0;
    for (;;) {
      if (signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during employees');
      if (Date.now() - startedAt > deadlineMs) {
        throw new SnapshotAbortedError(`LK employee pagination deadline exceeded (${deadlineMs}ms)`);
      }
      if (pages >= maxPages) {
        throw new SnapshotAbortedError(`LK employee pagination exceeded ${maxPages} pages (cursor loop?)`);
      }
      if (guard) await guard.assertOwned();
      const page = await c.listEmployeesPage(limit, cursor ?? null, signal ? { signal } : undefined);
      if (!('nextCursor' in (page as unknown as Record<string, unknown>))) {
        throw new SnapshotAbortedError('LK contract violation: employee page missing nextCursor');
      }
      pages += 1;
      // One short fenced transaction per page: gate + all page upserts.
      // No HTTP inside. A stale holder aborts here, before writing fields.
      await this.prisma.$transaction(async (tx) => {
        if (fctx) await this.fencing.assertSnapshotMayWrite(tx as never, fctx.runId, fctx.generation);
        for (const emp of page.items) {
          if (signal?.aborted) throw new SnapshotAbortedError('LK snapshot cancelled during employee upserts');
          await this.upsertEmployeeInTx(tx as unknown as TxClient, emp, runId);
        }
      });
      total += page.items.length;
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
        throw new SnapshotAbortedError('LK pagination made no progress (empty page with nextCursor)');
      }
      cursor = next;
    }
    return { count: total };
  }

  async upsertEmployee(emp: EdoEmployee, syncId?: string): Promise<void> {
    await this.upsertEmployeeInTx(this.prisma as unknown as TxClient, emp, syncId);
  }

  private async upsertEmployeeInTx(tx: TxClient, emp: EdoEmployee, syncId?: string): Promise<void> {
    const now = new Date();
    const stamp = syncId ? { lastSeenSyncId: syncId, sourcePresent: true } : { sourcePresent: true };
    await tx.lkEmployee.upsert({
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
   * Marker-only reconciliation in ONE transaction: the fencing gate and all
   * four marking statements commit atomically. A successor that stole the
   * generation aborts the whole transaction — no partial marks from a stale
   * holder. (Redis loss WITHOUT a successor has no rival writer; the marks
   * computed from this complete snapshot stay correct. The Redis guard is
   * re-checked immediately before opening this transaction as a fail-fast.)
   */
  private async markMissingInTx(tx: TxClient, runId: string, counts: SnapshotCounts): Promise<void> {
    // Reference data absent from a successful snapshot -> soft deleted.
    if (counts.locations > 0) {
      await tx.lkLocation.updateMany({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { deleted: true },
      });
    } else {
      this.logger.warn('Snapshot returned 0 locations; skipping mark-missing for locations');
    }
    if (counts.positions > 0) {
      await tx.lkPosition.updateMany({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { deleted: true },
      });
    } else {
      this.logger.warn('Snapshot returned 0 positions; skipping mark-missing for positions');
    }
    if (counts.departments > 0) {
      await tx.lkDepartment.updateMany({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { deleted: true },
      });
    } else {
      this.logger.warn('Snapshot returned 0 departments; skipping mark-missing for departments');
    }
    // Employees absent from snapshot -> technically not present, never `fired`.
    if (counts.employees > 0) {
      await tx.lkEmployee.updateMany({
        where: {
          OR: [{ lastSeenSyncId: null }, { lastSeenSyncId: { not: runId } }],
        },
        data: { sourcePresent: false },
      });
    } else {
      this.logger.warn('Snapshot returned 0 employees; skipping mark-missing for employees');
    }
  }
}
