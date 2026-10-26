import { candidateGroupAccessWhere } from "../documents/review-group";
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction, EmployeeStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/auth-principal';
import { EdoAccessRule } from '../auth/edo-access-rule';
import { hasAccessRule, resolveLocationScope } from '../auth/access-rules';
import type { DashboardResponseDto, KpiDto } from './dto/dashboard-response.dto';

const STAGES: Array<[EmployeeStatus, string]> = [
  ['INVITED', 'Приглашены / вход'], ['ONBOARDING', 'Проходят путь'],
  ['BLOCKED', 'Заблокированы'], ['IN_REVIEW', 'Проверка и комплект'],
  ['SIGNING', 'Подписание'], ['HIRED', 'Оформлены'],
];
const ACTIONS: Partial<Record<AuditAction, string>> = {
  DOCUMENT_OCR_RETRIED: 'Документ повторно отправлен на распознавание',
  DOCUMENT_OCR_REQUESTED: 'Документ отправлен на распознавание',
  EMPLOYEE_CREATED: 'Создано дело работника', DOCUMENT_UPLOADED: 'Загружен документ',
  DOCUMENT_FIELDS_UPDATED: 'Исправлены поля документа', DOCUMENT_RETURNED: 'Возвращён документ',
  DOCUMENT_APPROVED: 'Подтверждён документ', DOCUMENT_SIGNED: 'Подписан документ',
  WORKFLOW_STAGE_CHANGED: 'Изменён этап оформления',
};

/** EDO cases filtered in the DB by the same location scope as employee/document reads. */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(principal?: AuthPrincipal): Promise<DashboardResponseDto> {
    if (!principal) throw new UnauthorizedException('Missing principal');
    const scope = resolveLocationScope(principal);
    // Denied scope (no 20007/20008/20009 location rights) matches nothing by
    // design — never all. Prisma `in: []` already matches nothing, but the
    // explicit branch keeps the denied semantics obvious and mirrors
    // EmployeesService.scopeWhere ({ id: '__denied__' }).
    const denied = !scope.all && scope.locationIds.length === 0;
    const employeeWhere: Prisma.EmployeeWhereInput = scope.all
      ? {}
      : denied ? { id: '__denied__' } : { locationId: { in: scope.locationIds } };
    // Same object filter as DocumentAccessService.documentWhere (the single
    // reader of documents): a document is visible only through its case object
    // (employee.locationId / candidate.locationId). Documents whose case has
    // locationId NULL are invisible to scoped (20007) users. That is why a
    // RETURNED document outside the caller's scope keeps the rework KPI at 0
    // for that user — exactly as the /review queue hides it. Never broaden.
    const locationDocumentWhere: Prisma.DocumentWhereInput = scope.all
      ? {}
      : denied ? { id: '__denied__' } : {
        OR: [{ candidate: { locationId: { in: scope.locationIds } } }, { employee: { locationId: { in: scope.locationIds } } }],
      };
    const group = candidateGroupAccessWhere(principal, true);
    const documentWhere: Prisma.DocumentWhereInput = Object.keys(group).length && !denied
      ? { AND: [locationDocumentWhere, { OR: [{ candidate: group }, ...(hasAccessRule(principal.accessRules, EdoAccessRule.DOCUMENT_REVIEW_RU) ? [{ candidateId: null }] : [])] }] }
      : locationDocumentWhere;
    // UTC reporting week; new cases are not treated as hires or signatures.
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const [employees, documents, weekly, blocked, tasks, activity] = await Promise.all([
      this.prisma.employee.groupBy({ by: ['status'], where: employeeWhere, _count: { _all: true } }),
      this.prisma.document.groupBy({ by: ['status'], where: documentWhere, _count: { _all: true } }),
      Promise.all(days.map(async (day, index) => ({ day, value: await this.prisma.employee.count({ where: {
        ...employeeWhere, createdAt: { gte: new Date(monday.getTime() + index * 86400_000), lt: new Date(monday.getTime() + (index + 1) * 86400_000) },
      } }) }))),
      this.prisma.employee.findMany({ where: { ...employeeWhere, status: 'BLOCKED' }, orderBy: { updatedAt: 'desc' }, take: 5, select: { id: true, fullName: true, stage: true } }),
      this.prisma.task.findMany({ where: {
        assignee: principal.uuid, status: { in: ['TODO', 'IN_PROGRESS'] },
        OR: [{ employee: employeeWhere }, { employeeId: null }],
      }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }], take: 5, select: { title: true, dueDate: true } }),
      // Own actions only; never expose another user's audit payload or names.
      this.prisma.auditLog.findMany({ where: { actorId: principal.uuid, action: { in: Object.keys(ACTIONS) as AuditAction[] } }, orderBy: { createdAt: 'desc' }, take: 5, select: { action: true, createdAt: true } }),
    ]);
    const employeeCount = (status: EmployeeStatus) => employees.find(row => row.status === status)?._count._all ?? 0;
    // Queue KPIs count Document.status (the same source the /review queue
    // filters on), never DocumentVersion.status: reject()/approve() always
    // write the decision to both the version and the parent Document.
    const documentCount = (status: typeof documents[number]['status']) => documents.find(row => row.status === status)?._count._all ?? 0;
    // (The annotation sits on the literal itself so contextual typing keeps
    // the group literals narrow; .filter() would otherwise widen them.)
    const allKpis: KpiDto[] = [
      { key: 'queue', label: 'Очередь проверки', value: String(documentCount('IN_REVIEW')), hint: 'документов ждут проверки', group: 'review' },
      { key: 'in_review', label: 'Дела на проверке', value: String(employeeCount('IN_REVIEW')), hint: 'дела на этапе проверки', group: 'review' },
      { key: 'rework', label: 'Возвращены', value: String(documentCount('RETURNED')), hint: 'документов возвращено на исправление', group: 'review' },
      { key: 'expired', label: 'Просрочены', value: String(documentCount('EXPIRED')), hint: 'документы в статусе «Просрочен»', group: 'review' },
      { key: 'signing', label: 'Ждут подписи', value: String(employeeCount('SIGNING')), hint: 'дела на этапе подписания', group: 'signing' },
      { key: 'hired', label: 'Оформлены', value: String(employeeCount('HIRED')), hint: 'дела в статусе «Оформлен»', group: 'signing' },
      { key: 'stuck', label: 'Застряли в оформлении', value: String(employeeCount('BLOCKED')), hint: 'дела требуют внимания', group: 'general' },
    ];
    const kpis = allKpis.filter((kpi) =>
      // Server-side KPI filtering by action rights (key presence, never
      // truthiness; FULL_ACCESS implies every rule via hasAccessRule):
      // DOCUMENT_REVIEW (20002) -> review + general, SIGNING (20003) ->
      // signing + general, both/20009 -> all, bare ACCESS (20000) -> general
      // only. The frontend still hides groups client-side as defense in depth,
      // but unentitled numbers must never leave the API.
      kpi.group === 'general'
        ? true
        : kpi.group === 'review'
          ? (hasAccessRule(principal.accessRules, EdoAccessRule.DOCUMENT_REVIEW_RU) || hasAccessRule(principal.accessRules, EdoAccessRule.DOCUMENT_REVIEW_IG))
          : hasAccessRule(principal.accessRules, EdoAccessRule.SIGNING),
    );
    return {
      source: 'database',
      kpis,
      weekly,
      stages: STAGES.map(([status, label]) => ({ label, value: employeeCount(status) })),
      blocked: blocked.map(row => ({ employeeId: row.id, fullName: row.fullName, step: row.stage ?? 'Этап не указан' })),
      tasks: tasks.map(row => ({ title: row.title, due: row.dueDate?.toISOString() ?? '' })),
      activity: activity.map(row => ({ kind: 'check', title: ACTIONS[row.action] ?? 'Действие в EDO', time: row.createdAt.toISOString() })),
    };
  }
}
