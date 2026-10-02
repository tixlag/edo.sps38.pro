import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DbFencingService, FencingConflictError } from '../src/lk-sync/lk-fencing.service';
import { LockOwnershipLostError } from '../src/lk-sync/lk-reconciliation-lock.service';
import { LkEventHandler } from '../src/lk-events/lk-event.handler';

/**
 * Fencing proof on REAL isolated MariaDB (InnoDB row locks), two independent
 * connections + barriers. NEVER runs against shared/local LK infrastructure:
 * it requires EDO_TEST_DATABASE_URL pointing at the disposable test server
 * (127.0.0.1:3308/edo) and refuses anything else. Without it the suite skips.
 *
 * Each test asserts FINAL FIELDS, presence flags, lastSeenSyncId, inbox and
 * audit — not just that a guard method was called.
 */
function disposableDbUrl(): string | null {
  const u = process.env.EDO_TEST_DATABASE_URL ?? '';
  if (!u) return null;
  if (!/^mysql:\/\/[^@/]+@127\.0\.0\.1:3308\/edo(\?|$)/.test(u)) {
    throw new Error(
      'Refusing: EDO_TEST_DATABASE_URL must be the disposable test server (mysql://…@127.0.0.1:3308/edo)',
    );
  }
  return u;
}

const URL = disposableDbUrl();
const PREFIX = `FZ${Date.now().toString(36).toUpperCase()}`;

let prismaA: PrismaClient | null = null;
let prismaB: PrismaClient | null = null;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeAll(async () => {
  if (!URL) return;
  prismaA = new PrismaClient({ datasourceUrl: URL });
  prismaB = new PrismaClient({ datasourceUrl: URL });
  await prismaA.$queryRaw`SELECT 1`;
  await prismaA.$executeRaw`UPDATE lk_sync_state SET activeRunId = NULL, heartbeatAt = NULL WHERE id = 1`;
});

afterAll(async () => {
  if (!prismaA || !prismaB) return;
  try {
    await prismaA.lkEmployee.deleteMany({ where: { code1c: { startsWith: PREFIX } } });
    await prismaA.lkProcessedEvent.deleteMany({ where: { eventId: { startsWith: `${PREFIX}-` } } });
    await prismaA.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
    await prismaA.$executeRaw`UPDATE lk_sync_state SET activeRunId = NULL, heartbeatAt = NULL WHERE id = 1`;
  } finally {
    await prismaA.$disconnect().catch(() => undefined);
    await prismaB.$disconnect().catch(() => undefined);
  }
});

function fencingOf(p: PrismaClient) {
  return new DbFencingService(p as never);
}

function empPayload(code1c: string, fullName: string) {
  return {
    code1c,
    uuid: '00000000-0000-0000-0000-000000000001',
    fullName,
    birthday: null,
    citizenship: null,
    organization: { code: null, name: null },
    position: { code1c: null, name: null },
    department: { code1c: null, name: null },
    division: { code1c: null, name: null },
    lastLocation: null,
    hireDate: null,
    fired: false,
    contractor: false,
    updatedAt: null,
  };
}

describe.skipIf(!URL)('LK fencing on real MariaDB (row-lock serialization)', () => {
  it('event admitted first wins: snapshot acquire blocks until the event commits', async () => {
    const A = prismaA!;
    const B = prismaB!;
    const code = `${PREFIX}-E1`;
    const evt = `${PREFIX}-evt-e1`;
    const gateEntered = deferred();
    const releaseEvent = deferred();

    const eventTx = (async () => {
      const fencing = fencingOf(A);
      await A.$transaction(async (tx) => {
        await fencing.assertEventMayWrite(tx as never, evt);
        gateEntered.resolve();
        await withTimeout(releaseEvent.promise, 15000, 'test barrier');
        await (tx as unknown as { lkProcessedEvent: { create: (a: unknown) => Promise<unknown> } }).lkProcessedEvent.create({
          data: { eventId: evt, eventType: 'employee.upserted', version: 1, occurredAt: new Date(), entityCode: code },
        });
        await (tx as unknown as { lkEmployee: { upsert: (a: unknown) => Promise<unknown> } }).lkEmployee.upsert({
          where: { code1c: code },
          update: { fullName: 'Event One', syncedAt: new Date(), sourcePresent: true },
          create: { code1c: code, uuid: 'u', fullName: 'Event One', fired: false, contractor: false, syncedAt: new Date(), sourcePresent: true },
        });
      });
    })();
    await withTimeout(gateEntered.promise, 15000, 'event gate');

    // Snapshot acquire must BLOCK on the row lock (not fail, not slip through).
    let acquired: { generation: bigint } | null = null;
    const acquireP = (async () => {
      acquired = await fencingOf(B).acquireDb(`${PREFIX}-run-s1`);
    })();
    await new Promise((r) => setTimeout(r, 800));
    expect(acquired).toBeNull();
    releaseEvent.resolve();
    await withTimeout(Promise.all([eventTx, acquireP]), 20000, 'event commit + acquire');
    expect(acquired).not.toBeNull();

    // Final state: the admitted event won linearizably; snapshot owns fencing after.
    const row = await A.lkEmployee.findUnique({ where: { code1c: code } });
    expect(row?.fullName).toBe('Event One');
    const inbox = await A.lkProcessedEvent.findUnique({ where: { eventId: evt } });
    expect(inbox?.eventId).toBe(evt);
    const state = await A.$queryRaw<Array<{ activeRunId: string | null }>>`SELECT activeRunId FROM lk_sync_state WHERE id = 1`;
    expect(state[0]?.activeRunId).toBe(`${PREFIX}-run-s1`);
    // Cleanup this run for the next test.
    await B.$executeRaw`UPDATE lk_sync_state SET activeRunId = NULL, heartbeatAt = NULL WHERE id = 1`;
    await B.lkSyncRun.deleteMany({ where: { runId: { startsWith: PREFIX } } });
  }, 30000);

  it('snapshot admitted first wins: late event blocks, then aborts as transient with no inbox row', async () => {
    const A = prismaA!;
    const code = `${PREFIX}-E2`;
    const evt = `${PREFIX}-evt-e2`;
    const fencing = fencingOf(A);
    const { generation } = await fencing.acquireDb(`${PREFIX}-run-s2`);
    expect(typeof generation).toBe('bigint');

    // End-to-end through the real handler: must reject, never poison, never inbox.
    const handler = new LkEventHandler(A as never, {} as never, { logInTransaction: async () => undefined } as never, fencing as never);
    await expect(
      handler.applyEnvelope({
        eventId: evt,
        eventType: 'employee.upserted',
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'lk.sps38.pro',
        payload: empPayload(code, 'Late Event'),
      }),
    ).rejects.toBeInstanceOf(FencingConflictError);
    expect(await A.lkProcessedEvent.findUnique({ where: { eventId: evt } })).toBeNull();
    expect(await A.lkEmployee.findUnique({ where: { code1c: code } })).toBeNull();
    // No audit row for the aborted event.
    expect(await A.auditLog.count({ where: { entityId: code } })).toBe(0);
    await fencing.releaseDb(`${PREFIX}-run-s2`, 'FINISHED', { locations: 0, positions: 0, departments: 0, employees: 0 });
  }, 30000);

  it('steal: stale holder page-write and mark abort; successor data stands', async () => {
    const A = prismaA!;
    const B = prismaB!;
    const code = `${PREFIX}-E3`;
    // Seed a row as the successor snapshot would see it.
    await A.lkEmployee.create({
      data: { code1c: code, uuid: 'u', fullName: 'Successor Value', fired: false, contractor: false, sourcePresent: true, lastSeenSyncId: `${PREFIX}-run-new` },
    });
    const fencingA = fencingOf(A);
    const { generation: genA } = await fencingA.acquireDb(`${PREFIX}-run-stale`);
    // Successor steals under its (test-provisioned) lock: unconditional reset + bump.
    await B.$executeRaw`UPDATE lk_sync_state SET activeRunId = ${`${PREFIX}-run-new`}, generation = generation + 1, heartbeatAt = ${new Date()} WHERE id = 1`;

    // Stale holder page write must abort (fields + lastSeenSyncId untouched).
    await expect(
      A.$transaction(async (tx) => {
        await fencingA.assertSnapshotMayWrite(tx as never, `${PREFIX}-run-stale`, genA);
        await (tx as unknown as { lkEmployee: { upsert: (a: unknown) => Promise<unknown> } }).lkEmployee.upsert({
          where: { code1c: code },
          update: { fullName: 'Stale Overwrite', lastSeenSyncId: `${PREFIX}-run-stale`, syncedAt: new Date() },
          create: { code1c: code, uuid: 'u', fullName: 'Stale Overwrite', fired: false, contractor: false, syncedAt: new Date() },
        });
      }),
    ).rejects.toBeInstanceOf(LockOwnershipLostError);
    const row = await A.lkEmployee.findUnique({ where: { code1c: code } });
    expect(row?.fullName).toBe('Successor Value');
    expect(row?.lastSeenSyncId).toBe(`${PREFIX}-run-new`);

    // Stale holder marking attempt aborts the whole marking transaction.
    await expect(
      A.$transaction(async (tx) => {
        await fencingA.assertSnapshotMayWrite(tx as never, `${PREFIX}-run-stale`, genA);
        await (tx as unknown as { lkEmployee: { updateMany: (a: unknown) => Promise<unknown> } }).lkEmployee.updateMany({
          where: { lastSeenSyncId: { not: `${PREFIX}-run-stale` } },
          data: { sourcePresent: false },
        });
      }),
    ).rejects.toBeInstanceOf(LockOwnershipLostError);
    expect((await A.lkEmployee.findUnique({ where: { code1c: code } }))?.sourcePresent).toBe(true);
    await B.$executeRaw`UPDATE lk_sync_state SET activeRunId = NULL, heartbeatAt = NULL WHERE id = 1`;
  }, 30000);

  it('orphaned generation does not block events forever; next sync steals it', async () => {
    const A = prismaA!;
    const B = prismaB!;
    const code = `${PREFIX}-E4`;
    const evt = `${PREFIX}-evt-e4`;
    // Simulate a crashed holder: active run with an ancient heartbeat.
    await A.$executeRaw`UPDATE lk_sync_state SET activeRunId = ${`${PREFIX}-run-dead`}, generation = generation + 1, heartbeatAt = ${new Date(Date.now() - 600_000)} WHERE id = 1`;
    const fencing = fencingOf(A);
    // Event proceeds (orphan), writes inbox + projection in one tx.
    const handler = new LkEventHandler(A as never, {} as never, { logInTransaction: async () => undefined } as never, fencing as never);
    await expect(
      handler.applyEnvelope({
        eventId: evt,
        eventType: 'employee.upserted',
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'lk.sps38.pro',
        payload: empPayload(code, 'Orphan Window'),
      }),
    ).resolves.toEqual({ status: 'applied' });
    // Next sync steals the orphaned generation (holds its own lock in production).
    const stolen = await fencingOf(B).acquireDb(`${PREFIX}-run-next`);
    expect(stolen.stolen).toBe(true);
    // And the orphaned holder can no longer write (generation moved on).
    const deadGen = (await A.$queryRaw<Array<{ generation: bigint }>>`SELECT generation FROM lk_sync_state WHERE id = 1`)[0]!.generation - 1n;
    await expect(
      A.$transaction(async (tx) => {
        await fencing.assertSnapshotMayWrite(tx as never, `${PREFIX}-run-dead`, deadGen);
      }),
    ).rejects.toBeInstanceOf(LockOwnershipLostError);
    await B.$executeRaw`UPDATE lk_sync_state SET activeRunId = NULL, heartbeatAt = NULL WHERE id = 1`;
  }, 30000);
});
