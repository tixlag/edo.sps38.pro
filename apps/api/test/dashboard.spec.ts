import { describe, expect, it, vi } from 'vitest';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { DocumentAccessService } from '../src/documents/document-access.service';
import type { AuthPrincipal } from '../src/auth/auth-principal';

const scopedPrincipal = {
  uuid: 'dashboard-user', code1c: null, sid: null, deviceId: null,
  accessRules: { '20000': [], '20007': ['98'] }, expiresAt: null,
} as unknown as AuthPrincipal;

function mockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    employee: { groupBy: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    document: { groupBy: vi.fn().mockResolvedValue([]) },
    task: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

describe('DashboardService', () => {
  it('returns database counts in the Pencil-shaped payload without synthetic activity', async () => {
    const prisma = mockPrisma({
      employee: { groupBy: vi.fn().mockResolvedValue([{ status: 'BLOCKED', _count: { _all: 2 } }]), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    });
    const dto = await new DashboardService(prisma as never).get(scopedPrincipal);
    expect(dto.kpis).toHaveLength(7);
    expect(dto.weekly).toHaveLength(7);
    expect(dto.stages.length).toBeGreaterThan(0);
    expect(dto.activity).toEqual([]);
    expect(dto.source).toBe('database');
    expect(dto.kpis.find(kpi => kpi.key === 'stuck')?.value).toBe('2');
    expect(prisma.employee.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { locationId: { in: [98] } } }));
  });

  it('counts queue/rework by Document.status and tags every KPI with a group', async () => {
    const prisma = mockPrisma({
      employee: { groupBy: vi.fn().mockResolvedValue([{ status: 'IN_REVIEW', _count: { _all: 3 } }]), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      document: { groupBy: vi.fn().mockResolvedValue([
        { status: 'IN_REVIEW', _count: { _all: 5 } },
        { status: 'RETURNED', _count: { _all: 1 } },
      ]) },
    });
    const dto = await new DashboardService(prisma as never).get(scopedPrincipal);
    const byKey = Object.fromEntries(dto.kpis.map(kpi => [kpi.key, kpi]));
    expect(byKey.queue.value).toBe('5');
    expect(byKey.in_review.value).toBe('3');
    expect(byKey.rework.value).toBe('1');
    for (const kpi of dto.kpis) {
      expect(['review', 'signing', 'general']).toContain(kpi.group);
    }
    expect(byKey.queue.group).toBe('review');
    expect(byKey.in_review.group).toBe('review');
    expect(byKey.rework.group).toBe('review');
    expect(byKey.expired.group).toBe('review');
    expect(byKey.signing.group).toBe('signing');
    expect(byKey.hired.group).toBe('signing');
    expect(byKey.stuck.group).toBe('general');
  });

  it('denies empty location scope explicitly instead of falling back to all', async () => {
    const prisma = mockPrisma();
    const denied = {
      uuid: 'no-scope-user', code1c: null, sid: null, deviceId: null,
      accessRules: { '20000': [] }, expiresAt: null,
    } as unknown as AuthPrincipal;
    const dto = await new DashboardService(prisma as never).get(denied);
    expect(prisma.employee.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { id: '__denied__' } }));
    expect(prisma.document.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { id: '__denied__' } }));
    for (const kpi of dto.kpis) {
      expect(kpi.value).toBe('0');
    }
  });

  it('uses the same document scope filter as DocumentAccessService reads', async () => {
    const prisma = mockPrisma();
    await new DashboardService(prisma as never).get(scopedPrincipal);
    const access = new DocumentAccessService(null as never);
    expect(prisma.document.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: access.documentWhere(scopedPrincipal) }),
    );
  });
});
