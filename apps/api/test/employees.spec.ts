import { describe, expect, it } from 'vitest';
import { EmployeesService } from '../src/employees/employees.service';

// No runtime seed fallback: DB errors propagate (5xx), empty DB returns [].
// Demo content exists only via `db:seed`.
// Object scope is backend-enforced via locationId (see EmployeesService).
describe('EmployeesService (no seed fallback)', () => {
  it('returns empty list when DB is empty', async () => {
    const svc = new EmployeesService({
      employee: {
        findMany: async () => [],
        count: async () => 0,
        findUnique: async () => null,
      },
    } as never);
    const { items, total } = await svc.list();
    expect(total).toBe(0);
    expect(items).toEqual([]);
  });

  it('propagates DB errors (no demo fallback)', async () => {
    const svc = new EmployeesService({
      employee: {
        findMany: async () => {
          throw new Error('no db');
        },
        count: async () => {
          throw new Error('no db');
        },
        findUnique: async () => null,
      },
    } as never);
    await expect(svc.list()).rejects.toThrow('no db');
  });

  it('returns null for unknown id without seed lookup', async () => {
    const svc = new EmployeesService({
      employee: {
        findMany: async () => [],
        count: async () => 0,
        findUnique: async () => null,
      },
    } as never);
    await expect(svc.getById('emp-toktogulov')).resolves.toBeNull();
  });
});

describe('EmployeesService (location scope)', () => {
  const rows = [
    { id: 'a', fullName: 'A', country: null, position: null, status: 'INVITED', stage: null, createdAt: new Date(), updatedAt: new Date(), locationId: 98 },
    { id: 'b', fullName: 'B', country: null, position: null, status: 'INVITED', stage: null, createdAt: new Date(), updatedAt: new Date(), locationId: 999 },
    { id: 'c', fullName: 'C', country: null, position: null, status: 'INVITED', stage: null, createdAt: new Date(), updatedAt: new Date(), locationId: null },
  ];
  function scopedSvc() {
    return new EmployeesService({
      employee: {
        findMany: async ({ where }: { where?: { locationId?: { in: number[] } } }) => {
          if (!where?.locationId) return rows;
          return rows.filter((r) => r.locationId != null && (where.locationId as { in: number[] }).in.includes(r.locationId));
        },
        count: async ({ where }: { where?: { locationId?: { in: number[] } } }) => {
          if (!where?.locationId) return rows.length;
          return rows.filter((r) => r.locationId != null && (where.locationId as { in: number[] }).in.includes(r.locationId)).length;
        },
        findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      },
    } as never);
  }
  const scopedPrincipal = {
    uuid: 'u',
    code1c: null,
    sid: null,
    deviceId: null,
    accessRules: { '20000': [], '20007': ['98'] },
    expiresAt: null,
  };
  const fullPrincipal = {
    uuid: 'u',
    code1c: null,
    sid: null,
    deviceId: null,
    accessRules: { '20009': [] },
    expiresAt: null,
  };
  const noScopePrincipal = {
    uuid: 'u',
    code1c: null,
    sid: null,
    deviceId: null,
    accessRules: { '20000': [] },
    expiresAt: null,
  };

  it('scoped user sees only allowed list + scoped total (no bypass via totals)', async () => {
    const svc = scopedSvc();
    const { items, total } = await svc.list(scopedPrincipal);
    expect(items.map((i) => i.id)).toEqual(['a']);
    expect(total).toBe(1);
  });

  it('scoped user cannot read чужую карточку or NULL-object rows', async () => {
    const svc = scopedSvc();
    expect(await svc.getById('a', scopedPrincipal)).not.toBeNull();
    expect(await svc.getById('b', scopedPrincipal)).toBeNull();
    expect(await svc.getById('c', scopedPrincipal)).toBeNull();
  });

  it('full access sees all including NULL-object rows', async () => {
    const svc = scopedSvc();
    const { total } = await svc.list(fullPrincipal);
    expect(total).toBe(3);
    expect(await svc.getById('c', fullPrincipal)).not.toBeNull();
  });

  it('no scope -> empty list and no card access', async () => {
    const svc = scopedSvc();
    const { items, total } = await svc.list(noScopePrincipal);
    expect(items).toEqual([]);
    expect(total).toBe(0);
    expect(await svc.getById('a', noScopePrincipal)).toBeNull();
  });
});
