import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { DocumentAccessService } from '../src/documents/document-access.service';
import { DocumentReviewService } from '../src/documents/document-review.service';
import type { AuthPrincipal } from '../src/auth/auth-principal';

/**
 * Mock-based repro for review item 5.2 (returned=0).
 *
 * Scenario: candidate (locationId=98) -> document uploaded (IN_REVIEW) ->
 * reviewer rejects -> Document.status + DocumentVersion.status must both
 * become RETURNED, and the dashboard rework KPI must count the document
 * exactly when the reviewer's documentWhere scope matches the case object.
 *
 * Prisma `locationId: { in: ids }` semantics are reproduced faithfully in
 * `matchesDocumentWhere` below: NULL never satisfies IN, an empty list
 * matches nothing. No shared containers are touched; everything is mocks.
 */

type FakeDoc = {
  id: string;
  status: string;
  candidate: { locationId: number | null } | null;
  employee: { locationId: number | null } | null;
};

function matchesDocumentWhere(doc: FakeDoc, where: Record<string, unknown>): boolean {
  return matchesWhere({ ...doc, candidateId: doc.candidate ? 'cand-1' : null,
    candidate: doc.candidate ? { chatUuid: 'chat', citizenship: 'ru', ...doc.candidate } : null }, where);
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Record<string, unknown>[]).every((item) => matchesWhere(row, item));
    if (key === 'OR') return (value as Record<string, unknown>[]).some((item) => matchesWhere(row, item));
    const actual = row[key];
    if (value === null || typeof value !== 'object') return actual === value;
    const filter = value as Record<string, unknown>;
    if ('in' in filter) return (filter.in as unknown[]).includes(actual);
    if ('not' in filter) return actual !== filter.not;
    return actual != null && matchesWhere(actual as Record<string, unknown>, filter);
  });
}

const principalWith = (accessRules: Record<string, string[]>) =>
  ({ uuid: 'repro-user', code1c: null, sid: null, deviceId: null, accessRules, expiresAt: null }) as unknown as AuthPrincipal;

const reviewer98 = () => principalWith({ '20000': [], '20002': [], '20007': ['98'] });
const reviewer99 = () => principalWith({ '20000': [], '20002': [], '20007': ['99'] });
const fullAccess = () => principalWith({ '20009': [] });

function reviewFixture(doc: FakeDoc) {
  // Mutable fake rows behind the mocked transaction.
  const documentRow: Record<string, unknown> = { id: doc.id, candidateId: 'cand-1', currentVersion: 1, status: 'IN_REVIEW' };
  const versionRow: Record<string, unknown> = { id: 'ver-1', status: 'IN_REVIEW', revision: 0 };
  const access = new DocumentAccessService(null as never);
  const tx = {
    $queryRaw: vi.fn(async () => []),
    document: {
      findUnique: vi.fn(async () => ({ ...documentRow })),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
        matchesDocumentWhere(doc, args.where) ? { ...documentRow } : null,
      ),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(documentRow, args.data);
        return { ...documentRow };
      }),
    },
    documentVersion: {
      findUnique: vi.fn(async () => ({
        ...versionRow,
        fields: [],
        submission: null,
        document: { documentType: null, candidate: { chatUuid: null } },
      })),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const next = { ...args.data };
        if (typeof next['revision'] === 'object') next['revision'] = (versionRow['revision'] as number) + 1;
        Object.assign(versionRow, next);
        return { count: 1 };
      }),
    },
  };
  const prisma = { $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(tx) };
  const audit = { logInTransaction: vi.fn(async () => undefined) };
  const reads = { version: vi.fn(async () => ({ documentId: doc.id, version: 1, status: versionRow['status'], revision: versionRow['revision'] })) };
  const service = new DocumentReviewService(prisma as never, access, audit as never, reads as never, {} as never);
  return { service, tx, audit, reads, documentRow, versionRow };
}

describe('5.2 repro: reject writes RETURNED to Document and version, scope decides visibility', () => {
  const doc98: FakeDoc = { id: 'doc-98', status: 'IN_REVIEW', candidate: { locationId: 98 }, employee: null };

  it('in-scope reviewer rejects: Document.status + version.status become RETURNED', async () => {
    const { service, tx, audit, documentRow, versionRow } = reviewFixture(doc98);
    const result = await service.reject('doc-98', 1, 0, 'Blurry photo', reviewer98(), 'corr-1');
    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'doc-98' }, data: { status: 'RETURNED' } }),
    );
    expect(tx.documentVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RETURNED', rejectionReason: 'Blurry photo' }) }),
    );
    expect(documentRow['status']).toBe('RETURNED');
    expect(versionRow['status']).toBe('RETURNED');
    expect(audit.logInTransaction).toHaveBeenCalled();
    const logged = audit.logInTransaction.mock.calls[0][1] as { action: string };
    expect(logged.action).toBe('DOCUMENT_RETURNED');
    expect(result.status).toBe('RETURNED');
  });

  it('out-of-scope reviewer cannot reject (scope rechecked inside the tx)', async () => {
    const { service, tx } = reviewFixture(doc98);
    await expect(service.reject('doc-98', 1, 0, 'Blurry photo', reviewer99(), 'corr-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.document.update).not.toHaveBeenCalled();
    expect(tx.documentVersion.updateMany).not.toHaveBeenCalled();
  });

  it('NULL-location case is fail-closed: invisible even to scoped reviewers, visible to FULL_ACCESS', async () => {
    const nullDoc: FakeDoc = { id: 'doc-null', status: 'IN_REVIEW', candidate: { locationId: null }, employee: null };
    const scoped = reviewFixture(nullDoc);
    await expect(scoped.service.reject('doc-null', 1, 0, 'Blurry photo', reviewer98(), 'corr-3')).rejects.toBeInstanceOf(NotFoundException);
    expect(scoped.tx.document.update).not.toHaveBeenCalled();
    const full = reviewFixture(nullDoc);
    await full.service.reject('doc-null', 1, 0, 'Blurry photo', fullAccess(), 'corr-4');
    expect(full.tx.document.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RETURNED' } }));
  });
});

describe('5.2 repro: dashboard rework KPI uses the same scope (returned=0 is scope, not a bug)', () => {
  const table: FakeDoc[] = [
    { id: 'd-inreview-98', status: 'IN_REVIEW', candidate: { locationId: 98 }, employee: null },
    { id: 'd-returned-99', status: 'RETURNED', candidate: { locationId: 99 }, employee: null },
    { id: 'd-returned-null', status: 'RETURNED', candidate: { locationId: null }, employee: null },
  ];

  function dashboardPrisma() {
    return {
      employee: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      document: {
        groupBy: vi.fn(async (args: { where: Record<string, unknown> }) => {
          const rows = table.filter((d) => matchesDocumentWhere(d, args.where));
          const counts = new Map<string, number>();
          for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
          return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
        }),
      },
      task: { findMany: vi.fn(async () => []) },
      auditLog: { findMany: vi.fn(async () => []) },
    };
  }

  const kpi = (dto: { kpis: Array<{ key: string; value: string }> }, key: string) =>
    dto.kpis.find((row) => row.key === key)?.value;

  it('reviewer of object 98 sees queue=1 but rework=0 (RETURNED docs live outside the scope)', async () => {
    const dto = await new DashboardService(dashboardPrisma() as never).get(reviewer98());
    expect(kpi(dto, 'queue')).toBe('1');
    expect(kpi(dto, 'rework')).toBe('0');
  });

  it('reviewer of objects 98+99 sees the RETURNED document (rework=1)', async () => {
    const dto = await new DashboardService(dashboardPrisma() as never).get(
      principalWith({ '20000': [], '20002': [], '20007': ['98', '99'] }),
    );
    expect(kpi(dto, 'rework')).toBe('1');
  });

  it('NULL-location RETURNED document is counted only for all-scope (20009), never for 20007', async () => {
    const scoped = await new DashboardService(dashboardPrisma() as never).get(reviewer98());
    expect(kpi(scoped, 'rework')).toBe('0');
    const full = await new DashboardService(dashboardPrisma() as never).get(fullAccess());
    expect(kpi(full, 'rework')).toBe('2');
  });
});

/**
 * PRODUCT_DECISION (candidates without locationId): NO silent fallback.
 *
 * Today a candidate/document whose case has locationId NULL is invisible to
 * every scoped (20007) reviewer and visible only to all-scope holders
 * (20008/20009) — proven by the tests above. There is no existing data from
 * which EDO could safely derive the object: the upload contract carries only
 * optional metadata.locationId / metadata.project_code_1c (see
 * ManualDocumentService), and inventing an object from uploader identity,
 * time, or name matching would leak cross-object documents to reviewers.
 * Showing every NULL-object document to every reviewer is rejected for the
 * same reason.
 *
 * So fail-closed stays, and the case is NOT closed until the product picks:
 *  (a) make the object mandatory at upload (require locationId or resolvable
 *      project_code_1c in the candidate metadata contract; reject or park
 *      uploads without an object), or
 *  (b) a dedicated "without object" triage queue behind a separate access
 *      rule (NOT 20002) where an operator assigns the object explicitly.
 */
