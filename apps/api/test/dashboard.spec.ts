import { describe, expect, it, vi } from 'vitest';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { DocumentAccessService } from '../src/documents/document-access.service';
import { DocumentReadService } from '../src/documents/document-read.service';
import type { AuthPrincipal } from '../src/auth/auth-principal';

const scopedPrincipal = {
  uuid: 'dashboard-user', code1c: null, sid: null, deviceId: null,
  accessRules: { '20000': [], '20002': [], '20003': [], '20007': ['98'] }, expiresAt: null,
} as unknown as AuthPrincipal;

const principalWith = (accessRules: Record<string, string[]>) =>
  ({ uuid: 'matrix-user', code1c: null, sid: null, deviceId: null, accessRules, expiresAt: null }) as unknown as AuthPrincipal;

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

  it.each([
    ['bare ACCESS sees general only', { '20000': [] }, ['stuck']],
    ['DOCUMENT_REVIEW sees review + general', { '20000': [], '20002': [], '20007': ['98'] }, ['queue', 'in_review', 'rework', 'expired', 'stuck']],
    ['SIGNING sees signing + general', { '20000': [], '20003': [], '20007': ['98'] }, ['signing', 'hired', 'stuck']],
    ['review + signing sees all', { '20000': [], '20002': [], '20003': [], '20007': ['98'] }, ['queue', 'in_review', 'rework', 'expired', 'signing', 'hired', 'stuck']],
    ['FULL_ACCESS sees all', { '20009': [] }, ['queue', 'in_review', 'rework', 'expired', 'signing', 'hired', 'stuck']],
    // Key presence grants (never truthiness): non-empty values grant too.
    ['non-empty rule values still grant', { '20000': ['98'], '20002': ['98'], '20003': ['98'], '20007': ['98'] }, ['queue', 'in_review', 'rework', 'expired', 'signing', 'hired', 'stuck']],
  ])('filters KPIs server-side by rights: %s', async (_title, rules, keys) => {
    const dto = await new DashboardService(mockPrisma() as never).get(principalWith(rules));
    expect(dto.kpis.map(kpi => kpi.key).sort()).toEqual([...keys].sort());
  });

  it('keeps the KpiDto shape (key/label/value/hint/group) after filtering', async () => {
    for (const rules of [{ '20000': [] }, { '20000': [], '20002': [], '20007': ['98'] }, { '20009': [] }] as Record<string, string[]>[]) {
      const dto = await new DashboardService(mockPrisma() as never).get(principalWith(rules));
      expect(dto.kpis.length).toBeGreaterThan(0);
      for (const kpi of dto.kpis) {
        expect(typeof kpi.key).toBe('string');
        expect(typeof kpi.label).toBe('string');
        expect(typeof kpi.value).toBe('string');
        expect(typeof kpi.hint).toBe('string');
        expect(['review', 'signing', 'general']).toContain(kpi.group);
      }
    }
  });

  it('lists RETURNED documents through the same scope as the rework KPI counts', async () => {
    const access = new DocumentAccessService(null as never);
    const findMany = vi.fn(async (args: { select?: unknown }) => {
      if (args.select) return [{ id: 'd1' }];
      return [{
        id: 'd1', status: 'RETURNED', currentVersion: 1,
        documentType: { code: 'PASSPORT', title: 'Паспорт', erpUid: null },
        candidate: { id: 'c1', chatUuid: 'chat', code1c: null },
        versions: [{ version: 1, revision: 1, delivery: null }],
      }];
    });
    const reads = new DocumentReadService({ document: { findMany, groupBy: vi.fn(async () => []) }, documentType: { findMany: vi.fn(async () => []) } } as never, access, null as never);
    const page = await reads.reviewDocuments(scopedPrincipal, { limit: 50, status: 'RETURNED' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].status).toBe('RETURNED');
    const scopeWhere = access.documentWhere(scopedPrincipal);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ...scopeWhere, versions: { some: { status: 'RETURNED' } }, currentVersion: { gt: 0 } }) }),
    );
  });

  it('keeps the default review queue on IN_REVIEW', async () => {
    const access = new DocumentAccessService(null as never);
    const findMany = vi.fn(async (args: { select?: unknown }) => (args.select ? [] : []));
    const reads = new DocumentReadService({ document: { findMany } } as never, access, null as never);
    await reads.reviewDocuments(scopedPrincipal, { limit: 50 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'IN_REVIEW' }) }),
    );
  });
});
