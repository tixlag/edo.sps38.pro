import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/auth-principal';
import { EdoAccessRule } from '../auth/edo-access-rule';
import { hasAccessRule, resolveLocationScope } from '../auth/access-rules';
import type {
  AuditLogListDto,
  AuditLogQueryDto,
} from './dto/audit-log.dto';

/**
 * Audit history reads for admins and reviewers.
 * - `mine=true` (or `actorId=me`) shows only the caller actions and needs
 *   DOCUMENT_REVIEW (20002), AUDIT_VIEW (20005) or FULL_ACCESS (20009).
 * - Unfiltered history needs AUDIT_VIEW (20005) or FULL_ACCESS (20009).
 * - Document/Employee rows are location-scoped in the DB query using the same
 *   object rule as document/employee reads (OR employee/candidate location);
 *   other entity types carry no location object and pass through.
 * - Author names come ONLY from the local LK projection (`lk_employees` via
 *   PrismaService), matched by uuid with a code1c fallback. Never by full
 *   name, never from LK tables directly.
 */
@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    principal: AuthPrincipal | undefined | null,
    query: AuditLogQueryDto,
  ): Promise<AuditLogListDto> {
    if (!principal) throw new UnauthorizedException('Missing principal');
    const limit = query.limit ?? 20;
    const entityType = query.entityType || undefined;
    const entityId = query.entityId || undefined;

    const isMine = query.mine === true || query.actorId === 'me';
    if (isMine) {
      // AccessRuleGuard already allows DOCUMENT_REVIEW or AUDIT_VIEW holders
      // (FULL_ACCESS implies both via hasAccessRule); re-check fail-closed.
      if (
        !hasAccessRule(principal.accessRules, EdoAccessRule.DOCUMENT_REVIEW) &&
        !hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW)
      ) {
        throw new ForbiddenException('Missing required EDO access rule');
      }
    } else if (
      !hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW)
    ) {
      // Full history is admin-only: a bare DOCUMENT_REVIEW reviewer must use mine=true.
      throw new ForbiddenException('Missing required EDO access rule');
    }

    const where: Prisma.AuditLogWhereInput = {
      ...(isMine
        ? { actorId: principal.uuid }
        : query.actorId
          ? { actorId: query.actorId }
          : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
    };
    const and: Prisma.AuditLogWhereInput[] = [];

    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }

    const scope = resolveLocationScope(principal);
    if (!scope.all) {
      // No scope (missing 20007/20008/20009) sees no scoped history.
      if (scope.locationIds.length === 0)
        return { items: [], nextCursor: null };
      // Same object rule as DocumentAccessService.documentWhere (kept inline
      // so the access service stays untouched).
      const documentScope: Prisma.DocumentWhereInput = {
        OR: [
          { employee: { locationId: { in: scope.locationIds } } },
          { candidate: { locationId: { in: scope.locationIds } } },
        ],
      };
      const employeeScope: Prisma.EmployeeWhereInput = {
        locationId: { in: scope.locationIds },
      };
      if (entityType === 'Document' && entityId) {
        // Deep-link history: single-row scope check, no id enumeration.
        const doc = await this.prisma.document.findFirst({
          where: { id: entityId, ...documentScope },
          select: { id: true },
        });
        if (!doc) return { items: [], nextCursor: null };
      } else if (entityType === 'Employee' && entityId) {
        const emp = await this.prisma.employee.findFirst({
          where: { id: entityId, ...employeeScope },
          select: { id: true },
        });
        if (!emp) return { items: [], nextCursor: null };
      } else {
        const needDocs = !entityType || entityType === 'Document';
        const needEmps = !entityType || entityType === 'Employee';
        if (needDocs || needEmps) {
          const [docs, emps] = await Promise.all([
            needDocs
              ? this.prisma.document.findMany({
                  where: documentScope,
                  select: { id: true },
                })
              : Promise.resolve([]),
            needEmps
              ? this.prisma.employee.findMany({
                  where: employeeScope,
                  select: { id: true },
                })
              : Promise.resolve([]),
          ]);
          const scopeOr: Prisma.AuditLogWhereInput[] = [];
          if (needDocs)
            scopeOr.push({
              entityType: 'Document',
              entityId: { in: docs.map((d) => d.id) },
            });
          if (needEmps)
            scopeOr.push({
              entityType: 'Employee',
              entityId: { in: emps.map((e) => e.id) },
            });
          if (!entityType)
            scopeOr.push({
              entityType: { notIn: ['Document', 'Employee'] },
            });
          and.push({ OR: scopeOr });
        }
        // Other entity types (Candidate, Lk*) carry no location object.
      }
    }

    const rows = await this.prisma.auditLog.findMany({
      where: { ...where, ...(and.length ? { AND: and } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0
        ? encodeCursor(
            page[page.length - 1].createdAt,
            page[page.length - 1].id,
          )
        : null;

    const names = await this.resolveActorNames(
      page.map((r) => r.actorId).filter((v): v is string => typeof v === 'string' && v.length > 0),
    );
    return {
      items: page.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actorName: r.actorId ? (names.get(r.actorId) ?? null) : null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        rejectionReason: rejectionReasonOf(r.action, r.after),
        createdAt: r.createdAt.toISOString(),
        linkHint: linkHintOf(r.entityType, r.entityId),
      })),
      nextCursor,
    };
  }

  private async resolveActorNames(
    actorIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const distinct = [...new Set(actorIds)];
    if (distinct.length === 0) return names;
    // Local projection only; uuid first, code1c fallback; never by full name.
    const rows = await this.prisma.lkEmployee.findMany({
      where: {
        OR: [{ uuid: { in: distinct } }, { code1c: { in: distinct } }],
      },
      select: { uuid: true, code1c: true, fullName: true },
    });
    const byUuid = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byUuid.get(row.uuid) ?? [];
      group.push(row);
      byUuid.set(row.uuid, group);
    }
    for (const id of distinct) {
      const matches = byUuid.get(id) ?? [];
      if (matches.length === 1 && matches[0].fullName) {
        names.set(id, matches[0].fullName);
        continue;
      }
      const byCode = rows.find((row) => row.code1c === id);
      if (byCode?.fullName) names.set(id, byCode.fullName);
    }
    return names;
  }
}

function decodeCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string')
      throw new Error('bad cursor');
    if (!parsed.id) throw new Error('bad cursor');
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error('bad cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
    'utf8',
  ).toString('base64url');
}

function rejectionReasonOf(action: string, after: unknown): string | null {
  if (action !== 'DOCUMENT_RETURNED') return null;
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    const value = (after as Record<string, unknown>).rejectionReason;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function linkHintOf(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'Document':
      return `/documents/${entityId}`;
    case 'Employee':
      return `/employees/${entityId}`;
    case 'Candidate':
      return `/candidates/${entityId}`;
    default:
      return null;
  }
}
