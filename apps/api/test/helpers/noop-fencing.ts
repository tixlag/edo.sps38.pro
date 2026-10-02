import type { SnapshotCounts } from '../../src/lk-sync/lk-reference-sync.service';
import type { SnapshotFencing } from '../../src/lk-sync/lk-fencing.service';

/**
 * Explicit fencing test double for pure-logic unit tests (memory mocks).
 * Permissive by construction AND by call-site choice — production never uses
 * it (Nest wires DbFencingService). Fencing-specific behavior is covered by
 * dedicated specs with strict doubles / the real service on isolated MariaDB.
 */
export function noopFencing(): SnapshotFencing {
  return {
    acquireDb: async () => ({ generation: 0n, stolen: false }),
    heartbeatDb: async () => undefined,
    releaseDb: async () => undefined,
    assertEventMayWrite: async () => undefined,
    assertSnapshotMayWrite: async () => undefined,
    getLastFinishedCounts: async (): Promise<SnapshotCounts | null> => null,
  };
}

/** Fencing double that rejects every write (snapshot owns the generation). */
export function blockingFencing(runId = 'run-other'): SnapshotFencing {
  const noop = noopFencing();
  return {
    ...noop,
    assertEventMayWrite: async () => {
      const { FencingConflictError } = await import('../../src/lk-sync/lk-fencing.service');
      throw new FencingConflictError(runId);
    },
  };
}
