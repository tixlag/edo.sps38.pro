import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction, EmployeeStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/auth-principal';
import { resolveLocationScope } from '../auth/access-rules';
import type { DashboardResponseDto } from './dto/dashboard-response.dto';

const STAGES: Array<[EmployeeStatus, string]> = [
  ['INVITED', 'Приглашены / вход'], ['ONBOARDING', 'Проходят путь'],
  ['BLOCKED', 'Заблокированы'], ['IN_REVIEW', 'Проверка и комплект'],
  ['SIGNING', 'Подписание'], ['HIRED', 'Оформлены'],
];
const ACTIONS: Partial<Record<AuditAction, string>> = {
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
    const employeeWhere: Prisma.EmployeeWhereInput = scope.all ? {} : { locationId: { in: scope.locationIds } };
    const documentWhere: Prisma.DocumentWhereInput = scope.all ? {} : {
      OR: [{ employee: { locationId: { in: scope.locationIds } } }, { candidate: { locationId: { in: scope.locationIds } } }],
    };
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
    const documentCount = (status: typeof documents[number]['status']) => documents.find(row => row.status === status)?._count._all ?? 0;
    return {
      source: 'database',
      kpis: [
        { key: 'queue', label: 'Очередь проверки', value: String(documentCount('IN_REVIEW')), hint: 'документов ждут проверки' },
        { key: 'stuck', label: 'Застряли в оформлении', value: String(employeeCount('BLOCKED')), hint: 'дела требуют внимания' },
        { key: 'signing', label: 'Ждут подписи', value: String(employeeCount('SIGNING')), hint: 'дела на этапе подписания' },
        { key: 'hired', label: 'Оформлены', value: String(employeeCount('HIRED')), hint: 'дела в статусе «Оформлен»' },
        { key: 'expired', label: 'Просрочены', value: String(documentCount('EXPIRED')), hint: 'документы в статусе «Просрочен»' },
        { key: 'rework', label: 'Возвращены', value: String(documentCount('RETURNED')), hint: 'документов возвращено на исправление' },
      ],
      weekly,
      stages: STAGES.map(([status, label]) => ({ label, value: employeeCount(status) })),
      blocked: blocked.map(row => ({ employeeId: row.id, fullName: row.fullName, step: row.stage ?? 'Этап не указан' })),
      tasks: tasks.map(row => ({ title: row.title, due: row.dueDate?.toISOString() ?? '' })),
      activity: activity.map(row => ({ kind: 'check', title: ACTIONS[row.action] ?? 'Действие в EDO', time: row.createdAt.toISOString() })),
    };
  }
}
