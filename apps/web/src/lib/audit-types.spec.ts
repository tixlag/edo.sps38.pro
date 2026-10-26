import { describe, expect, it } from 'vitest';
import { getListAuditLogsQueryKey, type MeResponseDto } from '@edo/api-client';
import {
  auditLogLink,
  auditLogVersion,
  auditActionLabel,
  auditEntityLabel,
  canOpenAuditObject,
  canReadDocuments,
  hasAccessRule,
  isHistoricVersion,
  parseVersionParam,
  resolveEffectiveMine,
} from './audit-types';

function meWith(permissions: Record<string, unknown[]>): MeResponseDto {
  return { permissions } as unknown as MeResponseDto;
}

describe('auditLogLink (versioned deep links)', () => {
  it('links a versioned Document row to /review/$documentId?version=N', () => {
    expect(
      auditLogLink({ entityType: 'Document', entityId: 'doc-1', version: 2 }),
    ).toEqual({
      to: '/review/$documentId',
      params: { documentId: 'doc-1' },
      search: { version: 2 },
    });
  });

  it('links a legacy Document row without version to the card without search', () => {
    expect(auditLogLink({ entityType: 'Document', entityId: 'doc-1' })).toEqual({
      to: '/review/$documentId',
      params: { documentId: 'doc-1' },
      search: {},
    });
    expect(
      auditLogLink({ entityType: 'Document', entityId: 'doc-1', version: null }),
    ).toEqual({
      to: '/review/$documentId',
      params: { documentId: 'doc-1' },
      search: {},
    });
  });

  it('ignores invalid versions (0, negative, non-integer)', () => {
    for (const version of [0, -1, 1.5, NaN]) {
      expect(
        auditLogLink({ entityType: 'Document', entityId: 'doc-1', version }),
      ).toEqual({
        to: '/review/$documentId',
        params: { documentId: 'doc-1' },
        search: {},
      });
    }
  });

  it('links Employee rows to the case card', () => {
    expect(
      auditLogLink({ entityType: 'Employee', entityId: 'emp-9', version: 3 }),
    ).toEqual({
      to: '/employees/$employeeId',
      params: { employeeId: 'emp-9' },
    });
  });

  it('returns null for entity types without SPA routes', () => {
    expect(auditLogLink({ entityType: 'Candidate', entityId: 'c-1' })).toBeNull();
    expect(auditLogLink({ entityType: 'LkEmployee', entityId: 'x' })).toBeNull();
  });

  it('never uses the raw backend linkHint (/documents/...) for navigation', () => {
    const row = {
      entityType: 'Document',
      entityId: 'doc-1',
      version: 1,
      linkHint: '/documents/doc-1',
    };
    const link = auditLogLink(row);
    expect(link?.to).toBe('/review/$documentId');
    expect(JSON.stringify(link)).not.toContain('/documents/');
  });
});

describe('auditLogVersion', () => {
  it('returns the version for versioned rows, null for legacy/invalid', () => {
    expect(auditLogVersion({ version: 2 })).toBe(2);
    expect(auditLogVersion({})).toBeNull();
    expect(auditLogVersion({ version: null })).toBeNull();
    expect(auditLogVersion({ version: 0 })).toBeNull();
  });
});

describe('audit labels', () => {
  it('falls back to the raw action for unknown actions', () => {
    expect(auditActionLabel('DOCUMENT_APPROVED')).toBe('Подтверждён');
    expect(auditActionLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('labels known entity types', () => {
    expect(auditEntityLabel('Document')).toBe('Документ');
    expect(auditEntityLabel('Employee')).toBe('Дело работника');
    expect(auditEntityLabel('Whatever')).toBe('Whatever');
  });
});

describe('access-rule gating (UI-only, backend re-checks)', () => {
  it('hasAccessRule uses key presence, never truthiness', () => {
    expect(hasAccessRule(meWith({ '20000': [] }), 20000)).toBe(true);
    expect(hasAccessRule(meWith({}), 20000)).toBe(false);
    expect(hasAccessRule(undefined, 20000)).toBe(false);
  });

  it('canReadDocuments needs 20000 (20009 implies it), fail-closed', () => {
    expect(canReadDocuments(meWith({ '20000': [] }))).toBe(true);
    expect(canReadDocuments(meWith({ '20009': [] }))).toBe(true);
    expect(canReadDocuments(meWith({ '20002': [] }))).toBe(false);
    expect(canReadDocuments(undefined)).toBe(false);
  });

  it('canOpenAuditObject gates Document/Employee cards, hides the rest', () => {
    const reader = meWith({ '20000': [] });
    const reviewerNoRead = meWith({ '20002': [] });
    expect(canOpenAuditObject(reader, 'Document')).toBe(true);
    expect(canOpenAuditObject(reader, 'Employee')).toBe(true);
    expect(canOpenAuditObject(reviewerNoRead, 'Document')).toBe(true);
    expect(canOpenAuditObject(reviewerNoRead, 'Employee')).toBe(false);
    expect(canOpenAuditObject(meWith({ '20011': [] }), 'Document')).toBe(true);
    expect(canOpenAuditObject(meWith({ '20005': [] }), 'Document')).toBe(false);
    expect(canOpenAuditObject(reader, 'Candidate')).toBe(false);
    expect(canOpenAuditObject(undefined, 'Document')).toBe(false);
  });
});

describe('resolveEffectiveMine (fail-closed scope)', () => {
  it('locks to mine without AUDIT_VIEW, respects scope otherwise', () => {
    expect(resolveEffectiveMine(true, true, 'all')).toBe(true);
    expect(resolveEffectiveMine(undefined, false, 'all')).toBe(true);
    expect(resolveEffectiveMine(undefined, true, 'mine')).toBe(true);
    expect(resolveEffectiveMine(undefined, true, 'all')).toBe(false);
  });
});

describe('review version helpers', () => {
  it('parseVersionParam accepts positive integers only', () => {
    expect(parseVersionParam('3')).toBe(3);
    expect(parseVersionParam(3)).toBe(3);
    expect(parseVersionParam(undefined)).toBeUndefined();
    expect(parseVersionParam('')).toBeUndefined();
    expect(parseVersionParam('abc')).toBeUndefined();
    for (const raw of [0, -2, 1.5, NaN, null, {}, []]) {
      expect(parseVersionParam(raw)).toBeUndefined();
    }
  });

  it('isHistoricVersion flags viewed < current only', () => {
    expect(isHistoricVersion(1, 2)).toBe(true);
    expect(isHistoricVersion(2, 2)).toBe(false);
    expect(isHistoricVersion(3, 2)).toBe(false);
    expect(isHistoricVersion(undefined, 2)).toBe(false);
    expect(isHistoricVersion(1, undefined)).toBe(false);
  });
});

describe('history pagination cache isolation', () => {
  it('builds distinct query keys per filter set (no page mixing)', () => {
    const mine = getListAuditLogsQueryKey({ mine: true, limit: 50 });
    const all = getListAuditLogsQueryKey({ limit: 50 });
    const approved = getListAuditLogsQueryKey({ mine: true, action: 'DOCUMENT_APPROVED', limit: 50 });
    const returned = getListAuditLogsQueryKey({ mine: true, action: 'DOCUMENT_RETURNED', limit: 50 });
    expect(JSON.stringify(mine)).not.toBe(JSON.stringify(all));
    expect(JSON.stringify(approved)).not.toBe(JSON.stringify(returned));
  });
});
