import type { AuditLogItemDto, MeResponseDto } from '@edo/api-client';

/**
 * Local alias kept so HistoryPage imports stay stable.
 *
 * `version` (from `after.version`) is added by the backend agent as
 * `AuditLogItemDto.version: number | null`. It is optional here so this file
 * compiles both BEFORE regeneration (generated type has no field) and AFTER
 * (required `number | null` narrows this optional down — reads stay valid).
 */
export type AuditLogItem = AuditLogItemDto & { version?: number | null };

const AUDIT_ACTION_LABELS: Record<string, string> = {
  DOCUMENT_APPROVED: 'Подтверждён',
  DOCUMENT_RETURNED: 'Возвращён',
  DOCUMENT_FIELDS_UPDATED: 'Поля исправлены',
  DOCUMENT_UPLOADED: 'Загружен',
  DOCUMENT_SIGNED: 'Подписан',
  EMPLOYEE_CREATED: 'Дело создано',
  WORKFLOW_STAGE_CHANGED: 'Этап изменён',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function auditEntityLabel(entityType: string): string {
  switch (entityType) {
    case 'Document':
      return 'Документ';
    case 'Employee':
      return 'Дело работника';
    case 'Candidate':
      return 'Кандидат';
    default:
      return entityType;
  }
}

/** Minimal shape needed to build an SPA target (linkHint is never used). */
export interface AuditLinkSource {
  entityType: string;
  entityId: string;
  version?: number | null;
}

export interface AuditDocumentLink {
  to: '/review/$documentId';
  params: { documentId: string };
  search: { version?: number };
}

export interface AuditEmployeeLink {
  to: '/employees/$employeeId';
  params: { employeeId: string };
}

export type AuditLink = AuditDocumentLink | AuditEmployeeLink;

/**
 * SPA target for a row: review card for documents (versioned deep link
 * `?version=N` when the audit row carries a version), case card for employees.
 *
 * PRODUCT DECISION: the backend `linkHint` uses `/documents/<id>` while the SPA
 * route is `/review/$documentId`. This frontend mapping is the source of truth
 * for routes; the raw `linkHint` string is NEVER used for navigation (it stays
 * informational only).
 */
export function auditLogLink(item: AuditLinkSource): AuditLink | null {
  if (item.entityType === 'Document') {
    const version = auditLogVersion(item);
    return {
      to: '/review/$documentId',
      params: { documentId: item.entityId },
      search: version === null ? {} : { version },
    };
  }
  if (item.entityType === 'Employee') {
    return { to: '/employees/$employeeId', params: { employeeId: item.entityId } };
  }
  return null;
}

/** Audited document version, or null for legacy rows without one. */
export function auditLogVersion(item: { version?: number | null }): number | null {
  return typeof item.version === 'number' &&
    Number.isInteger(item.version) &&
    item.version > 0
    ? item.version
    : null;
}

/**
 * EDO access rules: key presence grants the right (value may be `[]`),
 * NEVER truthiness. Frontend use is UI-only; the backend re-checks.
 */
export function hasAccessRule(profile: MeResponseDto | undefined, rule: number): boolean {
  const permissions = (profile?.permissions ?? {}) as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(permissions, String(rule));
}

/**
 * Base read right (20000; FULL_ACCESS 20009 implies it, mirroring the backend
 * `hasAccessRule`). Both the review card (`GET documents/:id/versions/:v`)
 * and the employee card (`GET employees/:id`) require ACCESS — the backend
 * re-checks per object via DocumentAccessService (location scope → 404).
 * UI use only: hides links, never bypasses the backend.
 * Fail-closed: unknown profile → false.
 */
export function canReadDocuments(profile: MeResponseDto | undefined): boolean {
  return hasAccessRule(profile, 20000) || hasAccessRule(profile, 20009);
}

/** Whether the audit row may render as a clickable object link. */
export function canOpenAuditObject(
  profile: MeResponseDto | undefined,
  entityType: string,
): boolean {
  if (entityType !== 'Document' && entityType !== 'Employee') return false;
  return canReadDocuments(profile);
}

export type AuditScope = 'mine' | 'all';

/**
 * Fail-closed scope resolution (pure, unit-tested): reviewers only see their
 * own rows until the profile confirms AUDIT_VIEW.
 */
export function resolveEffectiveMine(
  lockMine: boolean | undefined,
  canViewAll: boolean,
  scope: AuditScope,
): boolean {
  return Boolean(lockMine) || !canViewAll || scope === 'mine';
}

/** Parse `?version=N` (string or number) into a positive integer version. */
export function parseVersionParam(raw: unknown): number | undefined {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined;
}

/** Historic mode: the viewed version is older than the current one. */
export function isHistoricVersion(
  viewed: number | null | undefined,
  current: number | null | undefined,
): boolean {
  return (
    typeof viewed === 'number' && typeof current === 'number' && viewed < current
  );
}
