import type { AuditLogItemDto, MeResponseDto } from '@edo/api-client';

/** Local alias kept so HistoryPage imports stay stable. */
export type AuditLogItem = AuditLogItemDto;

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

/** SPA target for a row: review card for documents, case card for employees. */
export function auditLogLink(item: Pick<AuditLogItem, 'entityType' | 'entityId'>): string | null {
  if (item.entityType === 'Document') return `/review/${item.entityId}`;
  if (item.entityType === 'Employee') return `/employees/${item.entityId}`;
  return null;
}

/**
 * EDO access rules: key presence grants the right (value may be `[]`),
 * NEVER truthiness. Frontend use is UI-only; the backend re-checks.
 */
export function hasAccessRule(profile: MeResponseDto | undefined, rule: number): boolean {
  const permissions = (profile?.permissions ?? {}) as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(permissions, String(rule));
}
