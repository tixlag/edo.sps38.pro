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

/**
 * Audit history reads for admins and reviewers.
 * - `mine=true` (or `actorId=me`) shows only the caller actions and needs
 *   DOCUMENT_REVIEW (20002), AUDIT_VIEW (20005) or FULL_ACCESS (20009).
 * - Unfiltered history needs AUDIT_VIEW (20005) or FULL_ACCESS (20009).
 *   ACCESS_ALL_LOCATIONS (20008) widens scope but never grants audit rights.
 * - Explicit object policy for scoped callers (`scope.all === false`):
 *   - Document: visible only when the document resolves into the caller scope
 *     (employee.locationId or candidate.locationId in scope.locationIds,
 *     same rule as DocumentAccessService.documentWhere).
 *   - Employee: visible only when employee.locationId is in scope.
 *   - Candidate: visible only when candidate.locationId is in scope
 *     (candidate->employee bindings never widen Candidate visibility).
 *   - Any other/unknown entityType: never visible to scoped callers;
 *     only `scope.all` (20009, or 20008 widening) sees them.
 *   - `mine=true` for DOCUMENT_REVIEW holders still applies the same object
 *     check: own actions on out-of-scope objects stay hidden.
 *   - Rows whose scope cannot be proven (legacy rows with NULL
 *     documentId/employeeId and no matching scoped object) are hidden
 *     from scoped callers (fail-closed); FULL_ACCESS sees everything.
 * - Scope is enforced at DB level with EXISTS subqueries over
 *   entityType/entityId (the audit FK columns documentId/employeeId are
 *   never populated by AuditService, so relation filters would hide
 *   everything). No unbounded ID preloading: scoped reads issue a single
 *   `$queryRaw` plus point `findFirst` checks for entityId deep links.
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

    const scope = resolveLocationScope(principal);
    if (!scope.all) {
      return this.listScoped(principal, query, {
        limit,
        entityType,
        entityId,
        isMine,
        locationIds: scope.locationIds,
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
      locationIds: number[];
    },
  ): Promise<AuditLogListDto> {
    const { limit, entityType, entityId, isMine, locationIds } = opts;
    // No scope (missing 20007/20008/20009) sees no scoped history.
    // An empty location list never means "all" (fail-closed).
    if (locationIds.length === 0) return { items: [], nextCursor: null };
    // Unknown entity types carry no provable object context: hide them
    // from scoped callers instead of passing them through.
    if (entityType && !isScopedEntityType(entityType)) {
      return { items: [], nextCursor: null };
    }
    if (entityType === 'Document' && entityId) {
      // Deep-link history: single-row scope check, no id enumeration.
      const doc = await this.prisma.document.findFirst({
        where: {
          id: entityId,
          OR: [
            { employee: { locationId: { in: locationIds } } },
            { candidate: { locationId: { in: locationIds } } },
          ],
        },
        select: { id: true },
      });
      if (!doc) return { items: [], nextCursor: null };
    } else if (entityType === 'Employee' && entityId) {
      const emp = await this.prisma.employee.findFirst({
        where: { id: entityId, locationId: { in: locationIds } },
        select: { id: true },
      });
      if (!emp) return { items: [], nextCursor: null };
    } else if (entityType === 'Candidate' && entityId) {
      // Candidate visibility uses ONLY the candidate's own locationId:
      // candidate->employee bindings never widen it.
      const cand = await this.prisma.candidate.findFirst({
        where: { id: entityId, locationId: { in: locationIds } },
        select: { id: true },
      });
      if (!cand) return { items: [], nextCursor: null };
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
    conds.push(scopedPredicate(entityType, locationIds));

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
  locationIds: number[],
): Prisma.Sql {
  const loc = Prisma.join(locationIds);
  const docExists = Prisma.sql`EXISTS (SELECT 1 FROM \`documents\` AS \`d\` LEFT JOIN \`employees\` AS \`e\` ON \`e\`.\`id\` = \`d\`.\`employeeId\` LEFT JOIN \`candidates\` AS \`c\` ON \`c\`.\`id\` = \`d\`.\`candidateId\` WHERE \`d\`.\`id\` = \`a\`.\`entityId\` AND (\`e\`.\`locationId\` IN (${loc}) OR \`c\`.\`locationId\` IN (${loc})))`;
  const empExists = Prisma.sql`EXISTS (SELECT 1 FROM \`employees\` AS \`e\` WHERE \`e\`.\`id\` = \`a\`.\`entityId\` AND \`e\`.\`locationId\` IN (${loc}))`;
  const candExists = Prisma.sql`EXISTS (SELECT 1 FROM \`candidates\` AS \`c\` WHERE \`c\`.\`id\` = \`a\`.\`entityId\` AND \`c\`.\`locationId\` IN (${loc}))`;
  if (entityType === 'Document') return docExists;
  if (entityType === 'Employee') return empExists;
  if (entityType === 'Candidate') return candExists;
  // Unfiltered: only scoped Document/Employee/Candidate rows match.
  return Prisma.sql`((\`a\`.\`entityType\` = 'Document' AND ${docExists}) OR (\`a\`.\`entityType\` = 'Employee' AND ${empExists}) OR (\`a\`.\`entityType\` = 'Candidate' AND ${candExists}))`;
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
