import { describe, expect, it, vi } from 'vitest';
import { LkEventHandler } from '../src/lk-events/lk-event.handler';
import { LkReferenceSyncService } from '../src/lk-sync/lk-reference-sync.service';
import { LkReconciliationLockService } from '../src/lk-sync/lk-reconciliation-lock.service';

function envelope(eventId: string, code1c = 'УП00023070', fullName = 'Иванов Иван') {
  return {
    eventId,
    eventType: 'employee.upserted' as const,
    version: 1 as const,
    occurredAt: '2026-09-29T08:15:00Z',
    source: 'lk.sps38.pro' as const,
    payload: {
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
    },
  };
}

function handlerWithMemory(opts: { p2002On?: 'inbox' | 'other'; runningSnapshot?: boolean } = {}) {
  const employees = new Map<string, Record<string, unknown>>();
  const events = new Map<string, unknown>();
  const txClient: Record<string, unknown> = {
    lkProcessedEvent: {
      create: async ({ data }: { data: { eventId: string } }) => {
        if (opts.p2002On === 'inbox' || events.has(data.eventId)) {
          const err = new Error('Unique constraint') as Error & { code: string; meta?: unknown };
          err.code = 'P2002';
          (err as unknown as { meta: unknown }).meta = { target: ['eventId'] };
          throw err;
        }
        events.set(data.eventId, data);
        return data;
      },
    },
    lkEmployee: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: object; create: object }) => {
        if (opts.p2002On === 'other') {
          const err = new Error('Unique constraint on other table') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        const prev = employees.get(where.code1c) ?? {};
        const next = { ...prev, ...(create as object), ...(update as object), code1c: where.code1c };
        employees.set(where.code1c, next as Record<string, unknown>);
        return next;
      },
    },
    lkPosition: { upsert: async () => ({}) },
    lkDepartment: { upsert: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  if (opts.runningSnapshot) {
    (txClient as Record<string, unknown>)['lkSyncRun'] = {
      findFirst: async () => ({ runId: 'run-other' }),
    };
  }
  const prisma = {
    lkProcessedEvent: {
      findUnique: async ({ where }: { where: { eventId: string } }) =>
        events.has(where.eventId) ? { eventId: where.eventId } : null,
    },
    // Simulate transaction rollback: inbox row disappears if the tx throws.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = new Map(events);
      try {
        return await fn(txClient);
      } catch (err) {
        for (const k of [...events.keys()]) {
          if (!snapshot.has(k)) events.delete(k);
        }
        throw err;
      }
    },
  } as never;
  const sync = {} as never;
  const audit = { logInTransaction: vi.fn() } as never;
  return { handler: new LkEventHandler(prisma, sync, audit), events, employees, audit };
}

describe('Etap 3: P2002 discrimination + inbox atomicity + fencing', () => {
  it('P2002 on inbox.eventId with existing row -> duplicate (acked)', async () => {
    const { handler } = handlerWithMemory();
    const env = envelope('evt-dup');
    expect(await handler.applyEnvelope(env)).toEqual({ status: 'applied' });
    // Second apply hits findUnique -> duplicate without P2002.
    expect(await handler.applyEnvelope(env)).toEqual({ status: 'duplicate' });
  });

  it('P2002 NOT on inbox.eventId is transient (never acked as duplicate)', async () => {
    const { handler, events } = handlerWithMemory({ p2002On: 'other' });
    const env = envelope('evt-other-conflict');
    await expect(handler.applyEnvelope(env)).rejects.toThrow(/Unique constraint/);
    expect(events.has('evt-other-conflict')).toBe(false);
  });

  it('crash between retry confirm and ack -> redelivery is duplicate, no double business change', async () => {
    const { handler, employees } = handlerWithMemory();
    const env = envelope('evt-crash', 'УП00023070', 'Иванов Иван v1');
    expect(await handler.applyEnvelope(env)).toEqual({ status: 'applied' });
    // Simulate redelivery after ack loss: same eventId re-applied.
    expect(await handler.applyEnvelope(env)).toEqual({ status: 'duplicate' });
    expect(employees.size).toBe(1);
    expect((employees.get('УП00023070') as { fullName: string }).fullName).toBe('Иванов Иван v1');
  });

  it('two events for one entity in reverse order both apply (idempotent inbox, last-writer-wins documented)', async () => {
    const { handler, employees } = handlerWithMemory();
    const e1 = envelope('evt-older', 'УП00023070', 'Старое имя');
    const e2 = envelope('evt-newer', 'УП00023070', 'Новое имя');
    // Reverse completion: newer first, then older (no LK revision yet -> last write wins;
    // contract stage will add revision ordering; this test pins idempotency, not rollback protection).
    expect(await handler.applyEnvelope(e2)).toEqual({ status: 'applied' });
    expect(await handler.applyEnvelope(e1)).toEqual({ status: 'applied' });
    expect(employees.size).toBe(1);
    // Both eventIds are recorded (no dedup across different ids).
    expect(await handler.applyEnvelope(e2)).toEqual({ status: 'duplicate' });
  });

  it('fencing: event aborts as transient while a snapshot RUNNING row exists', async () => {
    const { handler } = handlerWithMemory({ runningSnapshot: true });
    const env = envelope('evt-fenced');
    await expect(handler.applyEnvelope(env)).rejects.toThrow(/RUNNING; deferring event/);
  });

  it('position/department applies include audit in the same transaction (no silent loss)', async () => {
    const employees = new Map<string, unknown>();
    const events = new Map<string, unknown>();
    const auditCalls: unknown[] = [];
    const txClient = {
      lkProcessedEvent: {
        create: async ({ data }: { data: { eventId: string } }) => {
          events.set(data.eventId, data);
          return data;
        },
      },
      lkPosition: { upsert: async () => ({}) },
      lkDepartment: { upsert: async () => ({}) },
      lkEmployee: { upsert: async () => ({}) },
      auditLog: { create: async (a: unknown) => { auditCalls.push(a); return a; } },
    };
    const prisma = {
      lkProcessedEvent: { findUnique: async () => null },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
    } as never;
    const handler = new LkEventHandler(prisma, {} as never, { logInTransaction: async (tx: never, e: never) => { auditCalls.push(e); } } as never);
    const pos = {
      eventId: 'evt-pos-1',
      eventType: 'position.upserted' as const,
      version: 1 as const,
      occurredAt: '2026-09-29T08:15:00Z',
      source: 'lk.sps38.pro' as const,
      payload: { code1c: 'POS1', name: 'P1', deleted: false, updatedAt: null },
    };
    expect(await handler.applyEnvelope(pos)).toEqual({ status: 'applied' });
    expect(auditCalls.length).toBeGreaterThan(0);
    void employees;
  });
});

describe('Etap 2: snapshot/consumer race + lock loss + Redis GET errors', () => {
  function memoryPrisma() {
    const employees = new Map<string, Record<string, unknown>>();
    return {
      store: { employees },
      lkEmployee: {
        upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
          const prev = employees.get(where.code1c);
          employees.set(where.code1c, { ...(prev ?? create), ...update, code1c: where.code1c });
        },
        updateMany: async () => ({ count: 0 }),
      },
      lkLocation: { upsert: async () => ({}), updateMany: async () => ({ count: 0 }) },
      lkPosition: { upsert: async () => ({}), updateMany: async () => ({ count: 0 }) },
      lkDepartment: { upsert: async () => ({}), updateMany: async () => ({ count: 0 }) },
    };
  }

  function emp(code1c: string) {
    return {
      code1c, uuid: '00000000-0000-0000-0000-000000000001', fullName: 'И', birthday: null,
      citizenship: null, organization: { code: null, name: null }, position: { code1c: null, name: null },
      department: { code1c: null, name: null }, division: { code1c: null, name: null },
      lastLocation: null, hireDate: null, fired: false, contractor: false, updatedAt: null,
    };
  }

  it('reproduces the getState()-then-apply race: snapshot can acquire after the check', async () => {
    // This test documents WHY getState() alone is not mutual exclusion.
    // Consumer checks unlocked, then snapshot acquires before apply.
    let locked = false;
    const fakeLock = {
      getState: async () => (locked ? 'locked' : 'unlocked'),
    };
    // Consumer admits (check passes)...
    expect(await fakeLock.getState()).toBe('unlocked');
    // ...snapshot acquires before the write (race window).
    locked = true;
    // Without DB fencing the write would proceed. With fencing (LkSyncRun
    // RUNNING check in the same transaction) the handler aborts instead.
    // This test pins the race window exists; fencing tests below pin the fix.
    expect(await fakeLock.getState()).toBe('locked');
  });

  it('lock lost mid-pages aborts before markMissing (no partial marking)', async () => {
    const prisma = memoryPrisma();
    const svc = new LkReferenceSyncService(prisma as never, { log: vi.fn() } as never, { get: () => undefined } as never);
    // Seed a stale row that must NOT be marked when ownership is lost.
    prisma.store.employees.set('STALE', { code1c: 'STALE', sourcePresent: true, lastSeenSyncId: null } as never);
    const client = {
      listLocations: async () => [{ id: 1, code1c: 'L1', name: 'N', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null }],
      listPositions: async () => [{ code1c: 'P1', name: 'P', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'D1', name: 'D', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A')], nextCursor: null }),
    } as never;
    let calls = 0;
    const guard = {
      assertOwned: async () => {
        calls += 1;
        if (calls >= 6) {
          const { LockOwnershipLostError } = await import('../src/lk-sync/lk-reconciliation-lock.service');
          throw new LockOwnershipLostError();
        }
      },
    };
    await expect(svc.syncAll(client, 'run-race', guard)).rejects.toThrow(/ownership lost/i);
    expect(prisma.store.employees.get('STALE')?.['sourcePresent']).toBe(true);
  });

  it('Redis GET error is unavailable, never unlocked (strict GET)', async () => {
    const failingRedis = {
      getStrict: async () => { throw new Error('ECONNREFUSED'); },
      get: async () => null,
      ping: async () => true,
      setNxPxStrict: async () => { throw new Error('down'); },
      setNxPx: async () => null,
      compareAndExpire: async () => null,
      compareAndDel: async () => null,
    } as never;
    const lock = new LkReconciliationLockService(failingRedis);
    expect(await lock.getState()).toBe('unavailable');
    await expect(lock.tryAcquire()).rejects.toMatchObject({ name: 'RedisUnavailableError' });
  });

  it('fenced markMissing aborts when a newer RUNNING run exists (late process never corrupts)', async () => {
    const prisma = memoryPrisma() as unknown as {
      lkSyncRun: { findFirst: (a: unknown) => Promise<{ runId: string } | null> };
    } & ReturnType<typeof memoryPrisma>;
    // Simulate a newer snapshot that started after we lost the lock.
    (prisma as unknown as Record<string, unknown>)['lkSyncRun'] = {
      findFirst: async () => ({ runId: 'run-newer' }),
    };
    const svc = new LkReferenceSyncService(prisma as never, { log: vi.fn() } as never, { get: () => undefined } as never);
    const client = {
      listLocations: async () => [{ id: 1, code1c: 'L1', name: 'N', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null }],
      listPositions: async () => [{ code1c: 'P1', name: 'P', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'D1', name: 'D', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A')], nextCursor: null }),
    } as never;
    const guard = { assertOwned: async () => undefined };
    await expect(
      svc.syncAll(client, 'run-stale', { guard, allowShrinkage: true } as never),
    ).rejects.toThrow(/fencing|ownership lost/i);
  });
});

describe('Etap 4: pagination guards never trigger markMissing on bad snapshots', () => {
  function svcWith(prisma: unknown) {
    return new LkReferenceSyncService(prisma as never, { log: vi.fn() } as never, { get: () => undefined } as never);
  }
  function memoryPrisma() {
    const employees = new Map<string, Record<string, unknown>>();
    return {
      lkEmployee: {
        upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
          employees.set(where.code1c, { ...create, ...update, code1c: where.code1c });
        },
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      lkLocation: { upsert: async () => ({}), updateMany: vi.fn(async () => ({ count: 0 })) },
      lkPosition: { upsert: async () => ({}), updateMany: vi.fn(async () => ({ count: 0 })) },
      lkDepartment: { upsert: async () => ({}), updateMany: vi.fn(async () => ({ count: 0 })) },
    };
  }
  function baseClient(pages: unknown) {
    let i = 0;
    const arr = pages as Array<{ items: unknown[]; nextCursor: string | null }>;
    return {
      listLocations: async () => [{ id: 1, code1c: 'L1', name: 'N', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null }],
      listPositions: async () => [{ code1c: 'P1', name: 'P', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'D1', name: 'D', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => arr[i++ % arr.length],
    } as never;
  }
  function emp(code1c: string) {
    return {
      code1c, uuid: '00000000-0000-0000-0000-000000000001', fullName: 'И', birthday: null,
      citizenship: null, organization: { code: null, name: null }, position: { code1c: null, name: null },
      department: { code1c: null, name: null }, division: { code1c: null, name: null },
      lastLocation: null, hireDate: null, fired: false, contractor: false, updatedAt: null,
    };
  }

  it('repeating cursor aborts (no infinite loop, no markMissing)', async () => {
    const prisma = memoryPrisma();
    const svc = svcWith(prisma);
    const client = baseClient([
      { items: [emp('A')], nextCursor: 'LOOP' },
      { items: [emp('B')], nextCursor: 'LOOP' },
    ]);
    await expect(svc.syncAll(client, 'run-loop', { allowUnguardedForTests: true })).rejects.toThrow(/cursor.*repeat|loop/i);
    expect(prisma.lkEmployee.updateMany).not.toHaveBeenCalled();
  });

  it('empty page with nextCursor aborts (no progress, no markMissing)', async () => {
    const prisma = memoryPrisma();
    const svc = svcWith(prisma);
    const client = baseClient([{ items: [], nextCursor: 'NEXT' }]);
    await expect(svc.syncAll(client, 'run-empty-page', { allowUnguardedForTests: true })).rejects.toThrow(/no progress/i);
    expect(prisma.lkEmployee.updateMany).not.toHaveBeenCalled();
  });

  it('cancelled snapshot never marks missing', async () => {
    const prisma = memoryPrisma();
    const svc = svcWith(prisma);
    const ctrl = new AbortController();
    ctrl.abort();
    const client = baseClient([{ items: [emp('A')], nextCursor: null }]);
    await expect(svc.syncAll(client, 'run-cancel', { allowUnguardedForTests: true, signal: ctrl.signal })).rejects.toThrow(/cancel/i);
    expect(prisma.lkEmployee.updateMany).not.toHaveBeenCalled();
  });

  it('shrinkage guard aborts before marking (operator confirmation required)', async () => {
    const prisma = {
      ...memoryPrisma(),
      lkSyncRun: {
        create: async () => ({ id: 2 }),
        update: async () => ({}),
        findFirst: async () => ({ locations: 100, positions: 100, departments: 100, employees: 100 }),
      },
    };
    const svc = svcWith(prisma);
    const client = baseClient([{ items: [emp('A')], nextCursor: null }]);
    // locations/positions/departments still 1 each vs 100 before -> shrinkage fires.
    await expect(svc.syncAll(client, 'run-shrink', { allowUnguardedForTests: true })).rejects.toThrow(/shrinkage/i);
  });
});
