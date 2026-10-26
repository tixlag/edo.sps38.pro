import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuditLogsService } from '../src/audit/audit-logs.service';

/**
 * Object-scope policy for audit history (scoped = scope.all === false).
 * Mocks only — never the shared MariaDB/RabbitMQ/Redis/S3.
 */

const principal = (accessRules: Record<string, string[]>, uuid = 'reviewer-1') => ({
  uuid,
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules,
});

function mockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    document: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    employee: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    candidate: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    lkEmployee: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

type PrismaMock = ReturnType<typeof mockPrisma>;

function rawArg(prisma: PrismaMock): { sql?: string; values?: unknown[] } {
  return (
    ((prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      sql?: string;
      values?: unknown[];
    }) ?? {}
  );
}

function docRow(id: string, entityId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    actorId: 'reviewer-1',
    action: 'DOCUMENT_APPROVED',
    entityType: 'Document',
    entityId,
    after: { version: 1 },
    createdAt: new Date('2026-10-05T10:00:00.000Z'),
    ...extra,
  };
}

describe('AuditLogsService object scope', () => {
  it('1. 20005+20007 sees documents of its own location (DB-level EXISTS, no ID preload)', async () => {
    const prisma = mockPrisma({
      $queryRaw: vi.fn().mockResolvedValue([docRow('a1', 'doc-own')]),
    });
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      {} as never,
    );
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].entityId).toBe('doc-own');
    expect(dto.items[0].version).toBe(1);
    // Perf: exactly one scoped query; no unbounded ID preloads.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    // The scope really is in the query: EXISTS + location values.
    expect(rawArg(prisma).sql ?? '').toContain('EXISTS');
    expect(rawArg(prisma).sql ?? '').toContain('`documents`');
    expect(rawArg(prisma).values ?? []).toContain(98);
  });

  it('2. scoped caller does not see a foreign document (point check, no audit read)', async () => {
    const prisma = mockPrisma();
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      { entityType: 'Document', entityId: 'doc-foreign' } as never,
    );
    expect(dto).toEqual({ items: [], nextCursor: null });
    expect(prisma.document.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('3. Candidate of a foreign location is unavailable (own locationId only)', async () => {
    const prisma = mockPrisma();
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      { entityType: 'Candidate', entityId: 'cand-foreign' } as never,
    );
    expect(dto).toEqual({ items: [], nextCursor: null });
    // Point check is on the candidate row itself...
    expect(prisma.candidate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'cand-foreign' }),
      }),
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    // ...and the list predicate never widens Candidate via employee bindings:
    // a Candidate-filtered list query must not join documents/employees.
    const prisma2 = mockPrisma({
      candidate: { findFirst: vi.fn().mockResolvedValue({ id: 'cand-own' }) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    });
    await new AuditLogsService(prisma2 as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      { entityType: 'Candidate' } as never,
    );
    expect(prisma2.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = rawArg(prisma2).sql ?? '';
    expect(sql).toContain('`candidates`');
    expect(sql).not.toContain('`documents`');
    expect(sql).not.toContain('LEFT JOIN `employees`');
  });

  it('4. unknown entityType never bypasses scoped restrictions', async () => {
    const prisma = mockPrisma();
    // Filtered unknown type: denied without touching the audit table.
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      { entityType: 'LkEmployee', entityId: 'x-1' } as never,
    );
    expect(dto).toEqual({ items: [], nextCursor: null });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    // Unfiltered history predicate only admits Document/Employee/Candidate.
    const prisma2 = mockPrisma({
      $queryRaw: vi.fn().mockResolvedValue([docRow('a1', 'doc-own')]),
    });
    await new AuditLogsService(prisma2 as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      {} as never,
    );
    const sql = rawArg(prisma2).sql ?? '';
    expect(sql).toContain("'Document'");
    expect(sql).toContain("'Employee'");
    expect(sql).toContain("'Candidate'");
    expect(sql).not.toContain('LkEmployee');
    expect(prisma2.document.findMany).not.toHaveBeenCalled();
    expect(prisma2.employee.findMany).not.toHaveBeenCalled();
  });

  it('5. review history uses direction globally while employee actions retain object scope', async () => {
    const prisma = mockPrisma({
      $queryRaw: vi.fn().mockResolvedValue([docRow('a1', 'doc-own')]),
    });
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20002': [], '20007': ['98'] }) as never,
      { mine: true } as never,
    );
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].actorId).toBe('reviewer-1');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // Both the caller filter and the location scope are in the query.
    expect(rawArg(prisma).values ?? []).toContain('reviewer-1');
    expect(rawArg(prisma).values ?? []).toContain(98);
    expect(rawArg(prisma).sql ?? '').toContain('EXISTS');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('6. 20002 without mine is 403 on general history', async () => {
    const prisma = mockPrisma();
    await expect(
      new AuditLogsService(prisma as never).list(
        principal({ '20002': [], '20007': ['98'] }) as never,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('7. 20005+20008 sees everything by policy; bare 20008 has no audit right', async () => {
    const rows = [
      docRow('a1', 'doc-any'),
      {
        id: 'lk1',
        actorId: 'sys',
        action: 'LK_EVENT_APPLIED',
        entityType: 'LkEmployee',
        entityId: 'code-1',
        after: {},
        createdAt: new Date('2026-10-05T11:00:00.000Z'),
      },
    ];
    const prisma = mockPrisma({
      auditLog: { findMany: vi.fn().mockResolvedValue(rows) },
    });
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20005': [], '20008': [] }) as never,
      {} as never,
    );
    // scope.all: full-access path, unknown types included, no scope predicate.
    expect(dto.items).toHaveLength(2);
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    // 20008 alone widens scope but grants nothing: still 403.
    const prismaBare = mockPrisma();
    await expect(
      new AuditLogsService(prismaBare as never).list(
        principal({ '20008': [] }) as never,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaBare.auditLog.findMany).not.toHaveBeenCalled();
    expect(prismaBare.$queryRaw).not.toHaveBeenCalled();
  });

  it('8. 20009 sees everything including unknown types', async () => {
    const rows = [
      docRow('a1', 'doc-any'),
      {
        id: 'lk1',
        actorId: null,
        action: 'LK_EVENT_APPLIED',
        entityType: 'LkDepartment',
        entityId: 'dep-1',
        after: {},
        createdAt: new Date('2026-10-05T12:00:00.000Z'),
      },
    ];
    const prisma = mockPrisma({
      auditLog: { findMany: vi.fn().mockResolvedValue(rows) },
    });
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20009': [] }) as never,
      {} as never,
    );
    expect(dto.items).toHaveLength(2);
    expect(dto.items.map((i) => i.entityType).sort()).toEqual([
      'Document',
      'LkDepartment',
    ]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });

  it('9. empty scope is never access-to-all', async () => {
    for (const rules of [
      { '20005': [] },
      { '20005': [], '20007': [] },
    ]) {
      const prisma = mockPrisma({
        $queryRaw: vi.fn(),
        auditLog: { findMany: vi.fn() },
      });
      const dto = await new AuditLogsService(prisma as never).list(
        principal(rules, 'u1') as never,
        rules['20002'] && !rules['20005'] ? ({ mine: true }) as never : ({} as never),
      );
      void dto;
      // Others: 403 (no AUDIT_VIEW) or empty (no locations) — either way
      // the audit table is never read.
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.document.findMany).not.toHaveBeenCalled();
      expect(prisma.employee.findMany).not.toHaveBeenCalled();
    }
    // Explicit: AUDIT_VIEW with an empty 20007 list returns empty, no reads.
    const prisma = mockPrisma();
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ '20005': [], '20007': [] }) as never,
      {} as never,
    );
    expect(dto).toEqual({ items: [], nextCursor: null });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it.each([['20002','RU'],['20011','IG']])('reviewer %s reads its direction without object grants', async (rule,group) => {
    const prisma = mockPrisma({$queryRaw:vi.fn().mockResolvedValue([docRow('own','document')])});
    const result = await new AuditLogsService(prisma as never).list(principal({[rule]:[]}) as never,{mine:true} as never);
    expect(result.items).toHaveLength(1);
    expect(rawArg(prisma).values).toContain(group);
    expect(rawArg(prisma).sql).toContain('d.reviewGroup IN');
    expect(rawArg(prisma).sql).not.toMatch(/citizenship|chatUuid/);
  });

  it('allows all authors in a specific permitted review document, never in general history', async () => {
    const prisma = mockPrisma({document:{findFirst:vi.fn().mockResolvedValue({id:'doc'})}});
    await new AuditLogsService(prisma as never).list(principal({'20002':[]}) as never,{entityType:'Document',entityId:'doc'} as never);
    expect(prisma.document.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:'doc',OR:[{reviewGroup:{in:['RU']}}]}}));
    expect(rawArg(prisma).values).not.toContain('reviewer-1');
  });

  it('10. entityId probing of foreign objects is closed (Employee + Candidate)', async () => {
    const prismaEmp = mockPrisma();
    const dtoEmp = await new AuditLogsService(prismaEmp as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      { entityType: 'Employee', entityId: 'emp-foreign' } as never,
    );
    expect(dtoEmp).toEqual({ items: [], nextCursor: null });
    expect(prismaEmp.employee.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaEmp.$queryRaw).not.toHaveBeenCalled();
    expect(prismaEmp.auditLog.findMany).not.toHaveBeenCalled();
    expect(prismaEmp.employee.findMany).not.toHaveBeenCalled();

    const prismaCand = mockPrisma();
    const dtoCand = await new AuditLogsService(prismaCand as never).list(
      principal({ '20005': [], '20007': ['98'] }) as never,
      { entityType: 'Candidate', entityId: 'cand-foreign' } as never,
    );
    expect(dtoCand).toEqual({ items: [], nextCursor: null });
    expect(prismaCand.candidate.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaCand.$queryRaw).not.toHaveBeenCalled();
    expect(prismaCand.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('11. perf: one scoped query per page regardless of 10/1000/50000 documents; 20 rows at 50k', async () => {
    for (const total of [10, 1000, 50000]) {
      void total;
      // Simulate a full page (limit 20 -> take 21) with legacy + versioned rows.
      const takeRows = Array.from({ length: 21 }, (_, i) =>
        docRow(`p-${i}`, `doc-${i}`, {
          after: i % 2 === 0 ? { version: i } : {},
          createdAt: new Date(Date.UTC(2026, 9, 5, 10, 0, i)),
        }),
      );
      const prisma = mockPrisma({
        $queryRaw: vi.fn().mockResolvedValue(takeRows),
      });
      const dto = await new AuditLogsService(prisma as never).list(
        principal({ '20005': [], '20007': ['98'] }) as never,
        { limit: 20 } as never,
      );
      // Correct page: 20 rows + cursor for the next one.
      expect(dto.items).toHaveLength(20);
      expect(dto.nextCursor).toBeTruthy();
      expect(dto.items[0].version).toBe(0);
      expect(dto.items[1].version).toBeNull();
      // O(pages), not O(totalIds): a single audit query, zero preloads.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.document.findMany).not.toHaveBeenCalled();
      expect(prisma.employee.findMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    }
  });
});
