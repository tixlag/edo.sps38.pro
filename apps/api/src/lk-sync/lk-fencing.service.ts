import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LockOwnershipLostError, ReconciliationInProgressError } from './lk-reconciliation-lock.service';
import type { SnapshotCounts } from './lk-reference-sync.service';

export const LK_FENCING_LEASE_MS = 90_000;

/** A snapshot holds the fencing generation; another snapshot is active. */
export class SnapshotActiveError extends ReconciliationInProgressError {
  constructor(holder: string, ageMs: number) {
    super(`Another LK snapshot holds the fencing generation (run ${holder}, heartbeat ${Math.round(ageMs / 1000)}s ago)`);
    this.name = 'SnapshotActiveError';
  }
}

/** An event arrived while a snapshot owns the fencing generation (transient). */
export class FencingConflictError extends Error {
  constructor(runId: string) {
    super(`LK snapshot ${runId} owns the fencing generation; deferring event write (transient)`);
    this.name = 'FencingConflictError';
  }
}

/** Coordination tables unreachable or misconfigured (fail closed, never ignore). */
export class FencingUnavailableError extends Error {
  constructor(detail: string) {
    super(`LK fencing coordination unavailable (fail closed): ${detail}`);
    this.name = 'FencingUnavailableError';
  }
}

export interface SnapshotFencing {
  acquireDb(runId: string): Promise<{ generation: bigint; stolen: boolean }>;
  heartbeatDb(runId: string): Promise<void>;
  releaseDb(
    runId: string,
    status: 'FINISHED' | 'FAILED',
    counts?: SnapshotCounts | null,
    error?: { category: string; detail: string },
  ): Promise<void>;
  assertEventMayWrite(tx: unknown, eventId: string): Promise<void>;
  assertSnapshotMayWrite(tx: unknown, runId: string, generation: bigint): Promise<void>;
  getLastFinishedCounts(): Promise<SnapshotCounts | null>;
}

interface StateRow {
  activeRunId: string | null;
  generation: bigint;
  heartbeatAt: Date | null;
}

/**
 * DB fencing gate on MariaDB/InnoDB (the real serialization point).
 *
 * Every LK-projection write runs in a SHORT transaction that first takes
 * `SELECT ... FOR UPDATE` on the `lk_sync_state` singleton row:
 * - event applies require `activeRunId IS NULL`. A row-level lock means a
 *   concurrent snapshot `acquireDb` blocks until the event commits (the event
 *   won) or the event blocks until the snapshot start commits and then sees
 *   the active run (the snapshot won) — linearizable either way. A stale
 *   heartbeat (> lease) counts as an orphaned run and does not block; the
 *   next `lk:sync` steals it while holding the Redis lock.
 * - snapshot page/mark writes require `activeRunId = own runId AND
 *   generation = acquired generation`. A steal bumps the generation, so a
 *   stale holder that lost the Redis lock can no longer write fields,
 *   `lastSeenSyncId`, or marks — not just `markMissing`.
 *
 * No transaction spans HTTP pagination: acquire/heartbeat/release and each
 * page/mark step are separate short transactions. Coordination SQL errors
 * always propagate (transient for events, fatal for snapshots) — they are
 * never downgraded to "probably a mock, allow the write".
 */
@Injectable()
export class DbFencingService implements SnapshotFencing {
  private readonly logger = new Logger(DbFencingService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async readStateTx(tx: { $queryRaw: (q: TemplateStringsArray) => Promise<StateRow[]> }): Promise<StateRow> {
    let rows: StateRow[];
    try {
      rows = await tx.$queryRaw`SELECT activeRunId, generation, heartbeatAt FROM lk_sync_state WHERE id = 1 FOR UPDATE`;
    } catch (err) {
      throw new FencingUnavailableError(safeDbDetail(err));
    }
    const row = rows[0];
    if (!row) throw new FencingUnavailableError('lk_sync_state singleton row is missing (migration 0005 not applied?)');
    return row;
  }

  async acquireDb(runId: string): Promise<{ generation: bigint; stolen: boolean }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await this.readStateTx(tx as never);
        const age = row.heartbeatAt ? Date.now() - row.heartbeatAt.getTime() : Number.POSITIVE_INFINITY;
        const stale = row.activeRunId == null || age > LK_FENCING_LEASE_MS;
        if (!stale && row.activeRunId) throw new SnapshotActiveError(row.activeRunId, age);
        const stolen = row.activeRunId != null;
        if (stolen) this.logger.warn(`LK fencing: stealing stale generation from run ${row.activeRunId} (heartbeat ${Math.round(age / 1000)}s ago)`);
        const next = row.generation + 1n;
        await (tx as unknown as { $executeRaw: (q: TemplateStringsArray, ...a: unknown[]) => Promise<unknown> }).$executeRaw`
          UPDATE lk_sync_state SET activeRunId = ${runId}, generation = ${next}, heartbeatAt = ${new Date()} WHERE id = 1`;
        await (tx as unknown as { lkSyncRun: { create: (a: unknown) => Promise<unknown> } }).lkSyncRun.create({
          data: { runId, status: 'RUNNING' },
        });
        return { generation: next, stolen };
      });
    } catch (err) {
      if (err instanceof SnapshotActiveError || err instanceof FencingUnavailableError) throw err;
      throw new FencingUnavailableError(safeDbDetail(err));
    }
  }

  async heartbeatDb(runId: string): Promise<void> {
    try {
      const n = await this.prisma.$executeRaw`UPDATE lk_sync_state SET heartbeatAt = ${new Date()} WHERE id = 1 AND activeRunId = ${runId}`;
      if (Number(n) !== 1) throw new LockOwnershipLostError(`LK fencing heartbeat: run ${runId} no longer owns the generation`);
    } catch (err) {
      if (err instanceof LockOwnershipLostError) throw err;
      throw new FencingUnavailableError(safeDbDetail(err));
    }
  }

  async releaseDb(
    runId: string,
    status: 'FINISHED' | 'FAILED',
    counts?: SnapshotCounts | null,
    error?: { category: string; detail: string },
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const t = tx as unknown as {
          lkSyncRun: { update: (a: unknown) => Promise<unknown> };
          $executeRaw: (q: TemplateStringsArray, ...a: unknown[]) => Promise<unknown>;
        };
        await t.lkSyncRun.update({
          where: { runId },
          data: {
            status,
            finishedAt: new Date(),
            ...(counts
              ? { locations: counts.locations, positions: counts.positions, departments: counts.departments, employees: counts.employees }
              : {}),
            ...(error ? { errorCategory: error.category, errorMessage: error.detail.slice(0, 256) } : {}),
          },
        });
        await t.$executeRaw`UPDATE lk_sync_state SET activeRunId = NULL, heartbeatAt = NULL WHERE id = 1 AND activeRunId = ${runId}`;
      });
    } catch (err) {
      throw new FencingUnavailableError(safeDbDetail(err));
    }
  }

  async assertEventMayWrite(tx: unknown, eventId: string): Promise<void> {
    const row = await this.readStateTx(tx as never);
    if (row.activeRunId == null) return;
    const age = row.heartbeatAt ? Date.now() - row.heartbeatAt.getTime() : Number.POSITIVE_INFINITY;
    if (age > LK_FENCING_LEASE_MS) {
      // Orphaned run (holder dead/stuck past the lease): do not block the
      // event forever. The next lk:sync steals the generation under the Redis
      // lock; until then the event write is the freshest known state.
      this.logger.warn(`LK fencing: event ${eventId} proceeds despite orphaned run ${row.activeRunId} (heartbeat ${Math.round(age / 1000)}s ago)`);
      return;
    }
    throw new FencingConflictError(row.activeRunId);
  }

  async assertSnapshotMayWrite(tx: unknown, runId: string, generation: bigint): Promise<void> {
    const row = await this.readStateTx(tx as never);
    if (row.activeRunId !== runId || row.generation !== generation) {
      throw new LockOwnershipLostError(
        `LK fencing: run ${runId} lost the generation (active=${row.activeRunId ?? 'none'}, gen=${row.generation.toString()})`,
      );
    }
  }

  async getLastFinishedCounts(): Promise<SnapshotCounts | null> {
    try {
      const last = await this.prisma.lkSyncRun.findFirst({
        where: { status: 'FINISHED' },
        orderBy: { finishedAt: 'desc' },
      });
      if (!last) return null;
      return { locations: last.locations, positions: last.positions, departments: last.departments, employees: last.employees };
    } catch (err) {
      throw new FencingUnavailableError(safeDbDetail(err));
    }
  }
}

/**
 * Safe error detail for coordination failures and the sync ledger.
 * Prisma errors contribute only their code (values may carry identifiers);
 * other errors contribute a truncated message. Never full payloads.
 */
export function safeDbDetail(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e?.code === 'string') return `Prisma ${e.code}`;
  const msg = typeof e?.message === 'string' ? e.message : String(err);
  return msg.slice(0, 160);
}

/** Map any sync failure to a safe ledger error (category + sanitized detail). */
export function toLedgerError(err: unknown): { category: string; detail: string } {
  const e = err as { name?: string; code?: string; message?: string };
  // Prisma/ORM errors contribute ONLY their code: messages may echo query
  // arguments (identifiers). Our own error classes carry messages constructed
  // by us (counts/runIds/reasons, never payloads), safe to truncate.
  if (typeof e?.code === 'string') return { category: 'DB', detail: `Prisma ${e.code}` };
  if (e?.name === 'ShrinkageGuardError') return { category: 'SHRINKAGE', detail: (e.message ?? '').slice(0, 256) };
  if (e?.name === 'SnapshotAbortedError') return { category: 'CANCELLED', detail: (e.message ?? '').slice(0, 256) };
  if (e?.name === 'LockOwnershipLostError') return { category: 'FENCING', detail: (e.message ?? '').slice(0, 256) };
  if (e?.name === 'SnapshotActiveError' || e?.name === 'ReconciliationInProgressError') {
    return { category: 'BUSY', detail: (e.message ?? '').slice(0, 256) };
  }
  return { category: 'FAILED', detail: (e?.message ?? String(err)).slice(0, 256) };
}
