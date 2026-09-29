import { describe, expect, it } from 'vitest';
import { EmployeesService } from '../src/employees/employees.service';

// Prisma is bypassed: service falls back to deterministic seed when DB is down.
describe('EmployeesService (seed fallback)', () => {
  it('lists seed employees', async () => {
    const svc = new EmployeesService({
      employee: {
        findMany: async () => {
          throw new Error('no db');
        },
        findUnique: async () => null,
      },
    } as never);
    const { items, total } = await svc.list();
    expect(total).toBe(items.length);
    expect(items.length).toBeGreaterThan(0);
  });
});
