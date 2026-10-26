import { canReviewGroup, type ReviewGroup } from "../documents/review-group";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/auth-principal';
import { EdoAccessRule } from '../auth/edo-access-rule';
import { hasAccessRule, resolveLocationScope } from '../auth/access-rules';
import type {
  AuditLogListDto,
  AuditLogQueryDto,
} from './dto/audit-log.dto';

/** Review document/candidate history follows confirmed workflow direction globally.
 * Independent audit access retains its object scope; employee history never
 * gains global access from document review rights. Full access reads all rows.
 * SQL EXISTS predicates avoid preloading IDs and enforce cursor scope in DB.
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
    const groups = (["RU", "IG"] as const).filter(group => canReviewGroup(principal, group));
    const auditAccess = hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW);
    const reviewEntity = !!entityId && (entityType === 'Document' || entityType === 'Candidate') && groups.length > 0;
    if (isMine) {
      // AccessRuleGuard already allows DOCUMENT_REVIEW or AUDIT_VIEW holders
      // (FULL_ACCESS implies both via hasAccessRule); re-check fail-closed.
      if (
        !hasAccessRule(principal.accessRules, EdoAccessRule.DOCUMENT_REVIEW_RU) &&
        !hasAccessRule(principal.accessRules, EdoAccessRule.DOCUMENT_REVIEW_IG) &&
        !hasAccessRule(principal.accessRules, EdoAccessRule.AUDIT_VIEW)
      ) {
        throw new ForbiddenException('Missing required EDO access rule');
      }
    } else if (!auditAccess && !reviewEntity) {
      // Full history is admin-only: a bare DOCUMENT_REVIEW reviewer must use mine=true.
      throw new ForbiddenException('Missing required EDO access rule');
    }

    const scope = resolveLocationScope(principal);
    if (!(auditAccess && scope.all)) {
      return this.listScoped(principal, query, {
        limit, entityType, entityId, isMine,
        locationIds: scope.all ? null : scope.locationIds,
        groups, auditAccess,
      });
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
      items: page.map((r) => mapRow(r, names.get(r.actorId ?? '') ?? null)),
      nextCursor,
    };
  }

  private async listScoped(
    principal: AuthPrincipal,
    query: AuditLogQueryDto,
    opts: {
      limit: number;
      entityType: string | undefined;
      entityId: string | undefined;
      isMine: boolean;
      locationIds: number[] | null;
      groups: ReviewGroup[];
      auditAccess: boolean;
    },
  ): Promise<AuditLogListDto> {
    const { limit, entityType, entityId, isMine, locationIds, groups, auditAccess } = opts;
    // No scope (missing 20007/20008/20009) sees no scoped history.
    // An empty location list never means "all" (fail-closed).
    if (locationIds?.length === 0 && !groups.length) return { items: [], nextCursor: null };
    // Unknown entity types carry no provable object context: hide them
    // from scoped callers instead of passing them through.
    if (entityType && !isScopedEntityType(entityType)) {
      return { items: [], nextCursor: null };
    }
    if (entityType === 'Document' && entityId) {
      const document = await this.prisma.document.findFirst({
        where: { id: entityId, OR: [
          { reviewGroup: { in: groups } },
          ...(auditAccess ? [locationIds === null ? {} : { OR: [
            { employee: { locationId: { in: locationIds } } },
            { candidate: { locationId: { in: locationIds } } },
          ] }] : []),
        ] }, select: { id: true },
      });
      if (!document) return { items: [], nextCursor: null };
    } else if (entityType === 'Employee' && entityId) {
      if (locationIds?.length === 0) return { items: [], nextCursor: null };
      const employee = await this.prisma.employee.findFirst({
        where: { id: entityId, ...(locationIds ? { locationId: { in: locationIds } } : {}) },
        select: { id: true },
      });
      if (!employee) return { items: [], nextCursor: null };
    } else if (entityType === 'Candidate' && entityId) {
      const candidate = await this.prisma.candidate.findFirst({
        where: { id: entityId, OR: [
          { reviewGroup: { in: groups } },
          ...(auditAccess ? [locationIds === null ? {} : { locationId: { in: locationIds } }] : []),
        ] }, select: { id: true },
      });
      if (!candidate) return { items: [], nextCursor: null };
    }

    const cursor = decodeCursor(query.cursor);
    const conds: Prisma.Sql[] = [];
    if (isMine) {
      conds.push(Prisma.sql`\`a\`.\`actorId\` = ${principal.uuid}`);
    } else if (query.actorId) {
      conds.push(Prisma.sql`\`a\`.\`actorId\` = ${query.actorId}`);
    }
    if (query.action) {
      conds.push(Prisma.sql`\`a\`.\`action\` = ${query.action}`);
    }
    if (entityType) {
      conds.push(Prisma.sql`\`a\`.\`entityType\` = ${entityType}`);
    }
    if (entityId) {
      conds.push(Prisma.sql`\`a\`.\`entityId\` = ${entityId}`);
    }
    if (cursor) {
      conds.push(
        Prisma.sql`(\`a\`.\`createdAt\` < ${cursor.createdAt} OR (\`a\`.\`createdAt\` = ${cursor.createdAt} AND \`a\`.\`id\` < ${cursor.id}))`,
      );
    }
    // DB-level object scope: EXISTS over entityType/entityId, no ID preload.
    // Legacy rows with no matching scoped object stay hidden (fail-closed).
    conds.push(scopedPredicate(entityType, locationIds, groups, auditAccess));

    const take = limit + 1;
    const rows = await this.prisma.$queryRaw<ScopedAuditRow[]>(
      Prisma.sql`SELECT \`a\`.\`id\` AS \`id\`, \`a\`.\`actorId\` AS \`actorId\`, \`a\`.\`action\` AS \`action\`, \`a\`.\`entityType\` AS \`entityType\`, \`a\`.\`entityId\` AS \`entityId\`, \`a\`.\`after\` AS \`after\`, \`a\`.\`createdAt\` AS \`createdAt\` FROM \`audit_logs\` AS \`a\` WHERE ${Prisma.join(conds, ' AND ')} ORDER BY \`a\`.\`createdAt\` DESC, \`a\`.\`id\` DESC LIMIT ${take}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor(new Date(last.createdAt), last.id)
        : null;

    const names = await this.resolveActorNames(
      page.map((r) => r.actorId).filter((v): v is string => typeof v === 'string' && v.length > 0),
    );
    return {
      items: page.map((r) =>
        mapRow(
          {
            id: r.id,
            actorId: r.actorId,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            after: r.after,
            createdAt: new Date(r.createdAt),
          },
          r.actorId ? (names.get(r.actorId) ?? null) : null,
        ),
      ),
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

interface ScopedAuditRow {
  id: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  after: unknown;
  createdAt: Date | string;
}

function isScopedEntityType(entityType: string): boolean {
  return (
    entityType === 'Document' ||
    entityType === 'Employee' ||
    entityType === 'Candidate'
  );
}

/**
 * DB-level scope predicate over entityType/entityId (no ID preloading).
 * The audit FK columns (documentId/employeeId) are never populated by
 * AuditService, so EXISTS over the string entity reference is the fallback.
 * Unfiltered history matches Document OR Employee OR Candidate rows whose
 * referenced object is in scope; unknown types never match (fail-closed).
 */
function scopedPredicate(
  entityType: string | undefined,
  locationIds: number[] | null,
  groups: ReviewGroup[],
  auditAccess: boolean,
): Prisma.Sql {
  const loc = locationIds?.length ? Prisma.join(locationIds) : Prisma.sql`NULL`;
  const candidateLocation = locationIds === null ? Prisma.sql`1=1` : Prisma.sql`c.locationId IN (${loc})`;
  const documentLocation = locationIds === null ? Prisma.sql`1=1` : Prisma.sql`(e.locationId IN (${loc}) OR c.locationId IN (${loc}))`;
  const candidateGroup = groups.length ? Prisma.sql`c.reviewGroup IN (${Prisma.join(groups)})` : Prisma.sql`1=0`;
  // The document's saved workflow is authoritative, even if its candidate
  // later changes citizenship, chat link or employee identity.
  const documentGroup = groups.length ? Prisma.sql`d.reviewGroup IN (${Prisma.join(groups)})` : Prisma.sql`1=0`;
  const documentAccess = auditAccess ? Prisma.sql`(${documentGroup} OR ${documentLocation})` : documentGroup;
  const candidateAccess = auditAccess ? Prisma.sql`(${candidateGroup} OR ${candidateLocation})` : candidateGroup;
  const docExists = Prisma.sql`EXISTS (SELECT 1 FROM \`documents\` AS d LEFT JOIN \`employees\` AS e ON e.id = d.employeeId LEFT JOIN \`candidates\` AS c ON c.id = d.candidateId WHERE d.id = a.entityId AND ${documentAccess})`;
  const empExists = Prisma.sql`EXISTS (SELECT 1 FROM \`employees\` AS e WHERE e.id = a.entityId AND ${locationIds === null ? Prisma.sql`1=1` : Prisma.sql`e.locationId IN (${loc})`})`;
  const candExists = Prisma.sql`EXISTS (SELECT 1 FROM \`candidates\` AS c WHERE c.id = a.entityId AND ${candidateAccess})`;
  if (entityType === 'Document') return docExists;
  if (entityType === 'Employee') return empExists;
  if (entityType === 'Candidate') return candExists;
  return Prisma.sql`((a.entityType = 'Document' AND ${docExists}) OR (a.entityType = 'Employee' AND ${empExists}) OR (a.entityType = 'Candidate' AND ${candExists}))`;
}

interface MappableAuditRow {
  id: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  after: unknown;
  createdAt: Date;
}

function mapRow(
  r: MappableAuditRow,
  actorName: string | null,
): {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: MappableAuditRow['action'];
  entityType: string;
  entityId: string;
  rejectionReason: string | null;
  version: number | null;
  createdAt: string;
  linkHint: string | null;
} {
  return {
    id: r.id,
    actorId: r.actorId,
    actorName,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    rejectionReason: rejectionReasonOf(r.action, r.after),
    version: versionOf(r.after),
    createdAt: r.createdAt.toISOString(),
    linkHint: linkHintOf(r.entityType, r.entityId),
  };
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

function parseJsonLenient(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}

function rejectionReasonOf(action: string, after: unknown): string | null {
  if (action !== 'DOCUMENT_RETURNED') return null;
  const parsed = parseJsonLenient(after);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const value = (parsed as Record<string, unknown>).rejectionReason;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function versionOf(after: unknown): number | null {
  const parsed = parseJsonLenient(after);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const value = (parsed as Record<string, unknown>).version;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function linkHintOf(entityType: string, entityId: string): string | null {
  switch (entityType) {
    // Real frontend routes only: /review/:documentId, /employees/:employeeId.
    // Candidate has no SPA route — return null rather than a false link.
    case 'Document':
      return `/review/${entityId}`;
    case 'Employee':
      return `/employees/${entityId}`;
    default:
      return null;
  }
}
