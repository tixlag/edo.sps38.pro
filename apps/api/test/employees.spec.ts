import { describe, expect, it } from 'vitest';
import { EmployeesService } from '../src/employees/employees.service';

// No runtime seed fallback: DB errors propagate (5xx), empty DB returns [].
// Demo content exists only via `db:seed`.
describe('EmployeesService (no seed fallback)', () => {
  it('returns empty list when DB is empty', async () => {
    const svc = new EmployeesService({
      employee: {
        findMany: async () => [],
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
        findUnique: async () => null,
      },
    } as never);
    await expect(svc.list()).rejects.toThrow('no db');
  });

  it('returns null for unknown id without seed lookup', async () => {
    const svc = new EmployeesService({
      employee: {
        findMany: async () => [],
        findUnique: async () => null,
      },
    } as never);
    await expect(svc.getById('emp-toktogulov')).resolves.toBeNull();
  });
});
