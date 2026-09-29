import { describe, expect, it, vi } from 'vitest';
import { LkReferenceSyncService } from '../src/lk-sync/lk-reference-sync.service';

function memoryPrisma() {
  const employees = new Map<string, Record<string, unknown>>();
  const locations = new Map<string, Record<string, unknown>>();
  const positions = new Map<string, Record<string, unknown>>();
  const departments = new Map<string, Record<string, unknown>>();
  return {
    store: { employees, locations, positions, departments },
    lkEmployee: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = employees.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        employees.set(where.code1c, next);
        return next;
      },
    },
    lkLocation: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = locations.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        locations.set(where.code1c, next);
        return next;
      },
    },
    lkPosition: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = positions.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        positions.set(where.code1c, next);
        return next;
      },
    },
    lkDepartment: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const prev = departments.get(where.code1c);
        const next = { ...(prev ?? create), ...update, code1c: where.code1c };
        departments.set(where.code1c, next);
        return next;
      },
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

    const result = await svc.syncAll(client);
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
      listLocations: async () => [],
      listPositions: async () => [],
      listDepartments: async () => [],
      listEmployeesPage: async () => ({ items: [emp('A', { fullName: 'Петров' })], nextCursor: null }),
    } as never;

    await svc.syncAll(client);
    await svc.syncAll(client);
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

    await svc.syncAll(client);
    expect(prisma.store.employees.get('A')?.['fired']).toBe(true);
    expect(prisma.store.locations.get('LOC')?.['deleted']).toBe(true);
    expect(prisma.store.positions.get('POS')?.['deleted']).toBe(true);
    expect(prisma.store.departments.get('DEP')?.['deleted']).toBe(true);
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
