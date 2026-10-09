import { describe, expect, it, vi } from 'vitest';
import { DashboardService } from '../src/dashboard/dashboard.service';

describe('DashboardService', () => {
  it('returns database counts in the Pencil-shaped payload without synthetic activity', async () => {
    const prisma = {
      employee: { groupBy: vi.fn().mockResolvedValue([{ status: 'BLOCKED', _count: { _all: 2 } }]), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      document: { groupBy: vi.fn().mockResolvedValue([]) },
      task: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const dto = await new DashboardService(prisma as never).get({
      uuid: 'dashboard-user', code1c: null, sid: null, deviceId: null,
      accessRules: { '20000': [], '20007': ['98'] }, expiresAt: null,
    });
    expect(dto.kpis).toHaveLength(6);
    expect(dto.weekly).toHaveLength(7);
    expect(dto.stages.length).toBeGreaterThan(0);
    expect(dto.activity).toEqual([]);
    expect(dto.source).toBe('database');
    expect(dto.kpis.find(kpi => kpi.key === 'stuck')?.value).toBe('2');
    expect(prisma.employee.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { locationId: { in: [98] } } }));
  });
});
