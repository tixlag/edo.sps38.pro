import { describe, expect, it, vi } from 'vitest';
import { LkReferenceSyncService } from '../src/lk-sync/lk-reference-sync.service';

function memoryPrisma() {
  const employees = new Map<string, Record<string, unknown>>();
  const locations = new Map<string, Record<string, unknown>>();
  const positions = new Map<string, Record<string, unknown>>();
  const departments = new Map<string, Record<string, unknown>>();
  function applyNotIn(
    store: Map<string, Record<string, unknown>>,
    where: { code1c?: { notIn?: string[] }; lastSeenSyncId?: { not?: string } },
    data: Record<string, unknown>,
  ) {
    let count = 0;
    for (const [code, row] of store.entries()) {
      if (where.code1c?.notIn && !where.code1c.notIn.includes(code)) {
        if (where.lastSeenSyncId?.not !== undefined && row['lastSeenSyncId'] === where.lastSeenSyncId.not) {
          continue;
        }
        store.set(code, { ...row, ...data });
        count += 1;
      }
    }
    return { count };
  }
  return {
    store: { employees, locations, positions, departments },
    lkEmployee: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = employees.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        employees.set(where.code1c, next);
        return next;
      },
      updateMany: async ({ where, data }: { where: never; data: Record<string, unknown> }) =>
        applyNotIn(employees, where as never, data),
    },
    lkLocation: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = locations.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        locations.set(where.code1c, next);
        return next;
      },
      updateMany: async ({ where, data }: { where: never; data: Record<string, unknown> }) =>
        applyNotIn(locations, where as never, data),
    },
    lkPosition: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = positions.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        positions.set(where.code1c, next);
        return next;
      },
      updateMany: async ({ where, data }: { where: never; data: Record<string, unknown> }) =>
        applyNotIn(positions, where as never, data),
    },
    lkDepartment: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = departments.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        departments.set(where.code1c, next);
        return next;
      },
      updateMany: async ({ where, data }: { where: never; data: Record<string, unknown> }) =>
        applyNotIn(departments, where as never, data),
    },
  };
}

function emp(code1c: string, overrides: Record<string, unknown> = {}) {
  return {
    code1c,
    uuid: '00000000-0000-0000-0000-000000000001',
    fullName: 'Иванов Иван',
    birthday: null,
    citizenship: null,
    organization: { code: null, name: 'ООО' },
    position: { code1c: null, name: null },
    department: { code1c: null, name: null },
    division: { code1c: null, name: null },
    lastLocation: null,
    hireDate: null,
    fired: false,
    contractor: false,
    updatedAt: null,
    ...overrides,
  };
}

describe('LkReferenceSyncService', () => {
  it('imports locations/positions/departments and paginates employees', async () => {
    const prisma = memoryPrisma();
    const audit = { log: vi.fn() };
    const config = { get: () => undefined } as never;
    const svc = new LkReferenceSyncService(prisma as never, audit as never, config);

    const pages = [
      { items: [emp('A'), emp('B')], nextCursor: 'B' },
      { items: [emp('C')], nextCursor: null },
    ];
    let pageIdx = 0;
    const client = {
      listLocations: async () => [
        { id: 98, code1c: 'LOC', name: 'Объект', shortName: 'О', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => [{ code1c: 'POS', name: 'Должность', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'DEP', name: 'Отдел', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => pages[pageIdx++ % pages.length] as never,
    } as never;

    const result = await svc.syncAll(client, 'sync-1');
    expect(result).toEqual({ locations: 1, positions: 1, departments: 1, employees: 3 });
    expect(prisma.store.employees.size).toBe(3);
    expect(audit.log).toHaveBeenCalledOnce();
  });

  it('second import is idempotent and updates existing rows', async () => {
    const prisma = memoryPrisma();
    const audit = { log: vi.fn() };
    const config = { get: () => undefined } as never;
    const svc = new LkReferenceSyncService(prisma as never, audit as never, config);
    const client = {
      listLocations: async () => [
        { id: 98, code1c: 'LOC', name: 'Объект', shortName: 'О', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => [{ code1c: 'POS', name: 'Должность', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'DEP', name: 'Отдел', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A', { fullName: 'Петров' })], nextCursor: null }),
    } as never;

    await svc.syncAll(client, 'sync-1');
    await svc.syncAll(client, 'sync-2');
    expect(prisma.store.employees.size).toBe(1);
    expect(prisma.store.employees.get('A')?.['fullName']).toBe('Петров');
  });

  it('preserves fired/deleted state instead of physical delete', async () => {
    const prisma = memoryPrisma();
    const audit = { log: vi.fn() };
    const config = { get: () => undefined } as never;
    const svc = new LkReferenceSyncService(prisma as never, audit as never, config);
    const client = {
      listLocations: async () => [
        { id: 98, code1c: 'LOC', name: 'Объект', shortName: 'О', generalUnitCode: null, deleted: true, updatedAt: null },
      ],
      listPositions: async () => [{ code1c: 'POS', name: 'Должность', deleted: true, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'DEP', name: 'Отдел', deleted: true, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A', { fired: true })], nextCursor: null }),
    } as never;

    await svc.syncAll(client, 'sync-1');
    expect(prisma.store.employees.get('A')?.['fired']).toBe(true);
    expect(prisma.store.locations.get('LOC')?.['deleted']).toBe(true);
    expect(prisma.store.positions.get('POS')?.['deleted']).toBe(true);
    expect(prisma.store.departments.get('DEP')?.['deleted']).toBe(true);
  });

  it('successful full snapshot marks stale references deleted and employees sourcePresent=false', async () => {
    const prisma = memoryPrisma();
    const audit = { log: vi.fn() };
    const config = { get: () => undefined } as never;
    const svc = new LkReferenceSyncService(prisma as never, audit as never, config);
    const full = {
      listLocations: async () => [
        { id: 1, code1c: 'LOC1', name: 'Один', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null },
        { id: 2, code1c: 'LOC2', name: 'Два', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => [{ code1c: 'POS1', name: 'P1', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'DEP1', name: 'D1', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A'), emp('B')], nextCursor: null }),
    } as never;
    await svc.syncAll(full, 'sync-1');
    const slim = {
      listLocations: async () => [
        { id: 1, code1c: 'LOC1', name: 'Один', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => [{ code1c: 'POS1', name: 'P1', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'DEP1', name: 'D1', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A')], nextCursor: null }),
    } as never;
    await svc.syncAll(slim, 'sync-2');
    expect(prisma.store.locations.get('LOC2')?.['deleted']).toBe(true);
    expect(prisma.store.employees.get('B')?.['sourcePresent']).toBe(false);
    // Absence never sets business `fired`.
    expect(prisma.store.employees.get('B')?.['fired']).toBe(false);
    expect(prisma.store.employees.get('A')?.['sourcePresent']).toBe(true);
  });

  it('failed partial snapshot does not mark unseen rows', async () => {
    const prisma = memoryPrisma();
    const audit = { log: vi.fn() };
    const config = { get: () => undefined } as never;
    const svc = new LkReferenceSyncService(prisma as never, audit as never, config);
    const full = {
      listLocations: async () => [
        { id: 1, code1c: 'LOC1', name: 'Один', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => [{ code1c: 'POS1', name: 'P1', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: 'DEP1', name: 'D1', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A'), emp('B')], nextCursor: null }),
    } as never;
    await svc.syncAll(full, 'sync-1');
    const failing = {
      listLocations: async () => [
        { id: 1, code1c: 'LOC1', name: 'Один', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => {
        throw new Error('LK positions outage');
      },
      listDepartments: async () => [{ code1c: 'DEP1', name: 'D1', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp('A')], nextCursor: null }),
    } as never;
    await expect(svc.syncAll(failing, 'sync-2')).rejects.toThrow(/outage/);
    // B is still present: no marking happened after the failed run.
    expect(prisma.store.employees.get('B')?.['sourcePresent']).not.toBe(false);
    expect(prisma.store.employees.has('B')).toBe(true);
  });

  it('fails closed without service token', () => {
    const prisma = memoryPrisma();
    const audit = { log: vi.fn() };
    const config = { get: () => undefined } as never;
    const svc = new LkReferenceSyncService(prisma as never, audit as never, config);
    // No env token and no client -> must throw, not silently skip.
    expect(() => svc.createClient()).toThrow();
  });
});
