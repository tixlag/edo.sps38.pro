import { safeArrivalCandidate } from "./ig-arrival-safe-binding.sql";
import {
  BadRequestException,
  Injectable,
  Optional,
  Logger,
} from "@nestjs/common";
import { DocumentCatalogService } from "./document-catalog.service";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { AuthPrincipal } from "../auth/auth-principal";
import { PrismaService } from "../prisma/prisma.service";
import { requireReviewGroup } from "./review-group";
import {
  requirementsJoin,
  requirementsKnown,
  requirementsAction,
  requirementsReviewAvailable,
} from "./ig-arrival-requirements.sql";
import { REQUIREMENTS_ACTIONS } from "./dto/ig-arrival-registry.dto";
import type {
  IgArrivalRegistryQueryDto,
  IgArrivalRegistryParticipationsQueryDto,
  IgArrivalRegistryGroupsDto,
  IgArrivalRegistryParticipationsDto,
  IgArrivalRegistryParticipationDto,
  IgArrivalRegistryLocationsQueryDto,
  IgArrivalRegistryLocationsDto,
} from "./dto/ig-arrival-registry.dto";

type Filters = {
  archive: "current" | "archive";
  dateFrom: string | null;
  dateTo: string | null;
  locationUid: string | null;
  q: string | null;
  documentStatus: string | null;
  requirementsAction: string | null;
  needsAttention: boolean | null;
};
type GroupRow = {
  groupType: string;
  arrivalDate: string | null;
  locationUid: string | null;
  locationName: string | null;
  totalParticipationCount: bigint;
  participationCount: bigint;
  needsAttentionCount: bigint;
};
type ParticipationRow = Omit<
  IgArrivalRegistryParticipationDto,
  | "approvedDocuments"
  | "confirmedDocuments"
  | "needsAttention"
  | "issueCodes"
  | "sourceRevision"
  | "statusScope"
  | "oneCEmploymentStatus"
  | "requirements"
  | "reviewAvailable"
  | "action"
  | "deliveryNeedsAttention"
> & {
  approvedDocuments: bigint;
  confirmedDocuments: bigint;
  needsAttention: number | boolean;
  issueCode: string | null;
  factIdentityIssue: string | null;
  latestSiteStatusCancelled: number | boolean | null;
  sourceRevision: bigint;
  deliveryNeedsAttention: number | boolean;
  requirementsKnown: number | boolean;
  requiredCount: bigint | null;
  presentCount: bigint | null;
  acceptedCount: bigint | null;
  reviewCount: bigint | null;
  returnedCount: bigint | null;
  missingCount: bigint | null;
  processingCount: bigint | null;
  attentionCount: bigint | null;
  reviewAvailable: bigint;
  requirementsAction: IgArrivalRegistryParticipationDto["requirements"]["nextAction"];
};
const encode = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");
function decode(value: string, max: number): unknown {
  if (!value || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new BadRequestException("Invalid registry token");
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BadRequestException("Invalid registry token");
  }
}
function validDate(value: string) {
  const d = new Date(`${value}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === value
  );
}
function filters(q: IgArrivalRegistryQueryDto): Filters {
  if (
    (q.dateFrom && !validDate(q.dateFrom)) ||
    (q.dateTo && !validDate(q.dateTo)) ||
    (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) ||
    (q.limit !== undefined &&
      (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100)) ||
    (q.q?.length ?? 0) > 128 ||
    (q.archive && !["current", "archive"].includes(q.archive)) ||
    (q.needsAttention !== undefined && typeof q.needsAttention !== "boolean") ||
    (q.requirementsAction &&
      !REQUIREMENTS_ACTIONS.includes(q.requirementsAction)) ||
    (q.documentStatus &&
      ![
        "UNKNOWN",
        "NO_DOCUMENTS",
        "IN_PROGRESS",
        "RETURNED",
        "APPROVED",
      ].includes(q.documentStatus)) ||
    (q.locationUid &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        q.locationUid,
      ))
  )
    throw new BadRequestException("Invalid registry filters");
  return {
    archive: q.archive ?? "current",
    dateFrom: q.dateFrom ?? null,
    dateTo: q.dateTo ?? null,
    locationUid: q.locationUid?.toLowerCase() ?? null,
    q: q.q?.trim() || null,
    documentStatus: q.documentStatus ?? null,
    requirementsAction: q.requirementsAction ?? null,
    needsAttention: q.needsAttention ?? null,
  };
}
function groupKey(date: string | null, location: string | null) {
  return date && location ? encode(["assigned", date, location]) : "issues";
}
function parseGroup(value: string): {
  date: string | null;
  location: string | null;
} {
  if (value === "issues") return { date: null, location: null };
  const v = decode(value, 256);
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    v[0] !== "assigned" ||
    typeof v[1] !== "string" ||
    !validDate(v[1]) ||
    typeof v[2] !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      v[2],
    ) ||
    encode(v) !== value
  )
    throw new BadRequestException("Invalid group key");
  return { date: v[1], location: v[2] };
}
function fingerprint(f: Filters, kind: string, group: string | null) {
  return createHash("sha256")
    .update(JSON.stringify([kind, f, group]))
    .digest("hex");
}
function cursor(
  value: string | undefined,
  f: Filters,
  kind: string,
  group: string | null,
): string[] | null {
  if (!value) return null;
  const v = decode(value, 1024);
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    v[0] !== 1 ||
    v[1] !== fingerprint(f, kind, group) ||
    !Array.isArray(v[2]) ||
    v[2].length !== (kind === "groups" ? 3 : 1) ||
    v[2].some((x: unknown) => typeof x !== "string" || x.length > 128)
  )
    throw new BadRequestException("Invalid registry cursor");
  return v[2] as string[];
}
const hasReturned = Prisma.sql`EXISTS (SELECT 1 FROM documents d WHERE d.candidateId=c.id AND d.status='RETURNED')`;
const hasDoc = Prisma.sql`EXISTS (SELECT 1 FROM documents d WHERE d.candidateId=c.id)`;
const approvedCount = Prisma.sql`(SELECT COUNT(*) FROM documents d WHERE d.candidateId=c.id AND d.status IN ('APPROVED','SIGNED'))`;
const validReceipt = Prisma.sql`x.status='SENT' AND x.transport='multipart-v2' AND EXISTS (SELECT 1 FROM erp_document_attempts a WHERE a.deliveryId=x.id AND a.id=(SELECT latest.id FROM erp_document_attempts latest WHERE latest.deliveryId=x.id ORDER BY latest.startedAt DESC,latest.id DESC LIMIT 1) AND a.receiptValidated=1 AND a.finishedAt IS NOT NULL AND a.errorCode IS NULL)`;
const reused = Prisma.sql`(v.ocrSource='PREVIOUS_LINK' AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v.ocrRaw,'$.source')),'')='ERP' OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v.ocrRaw,'$.deliveredHistorically')),'')='true'))`;
const confirmedCount = Prisma.sql`(SELECT COUNT(*) FROM documents d JOIN document_versions v ON v.documentId=d.id AND v.version=d.currentVersion LEFT JOIN erp_document_deliveries x ON x.versionId=v.id WHERE d.candidateId=c.id AND d.status IN ('APPROVED','SIGNED') AND v.status IN ('APPROVED','SIGNED') AND (${reused} OR ${validReceipt}))`;
const deliveryProblem = Prisma.sql`EXISTS (SELECT 1 FROM documents d JOIN document_versions v ON v.documentId=d.id AND v.version=d.currentVersion LEFT JOIN erp_document_deliveries x ON x.versionId=v.id WHERE d.candidateId=c.id AND d.status IN ('APPROVED','SIGNED') AND NOT COALESCE(${reused},0) AND (x.id IS NULL OR x.status IN ('WAITING_CONTRACT','REQUIRES_MANUAL') OR (x.status='SENT' AND NOT (${validReceipt}))))`;
const docStatus = Prisma.sql`CASE WHEN NOT ${requirementsKnown()} THEN 'UNKNOWN' WHEN req.returnedCount>0 THEN 'RETURNED' WHEN req.acceptedCount=req.requiredCount THEN 'APPROVED' WHEN NOT ${hasDoc} AND req.presentCount=0 THEN 'NO_DOCUMENTS' ELSE 'IN_PROGRESS' END`;
const sourceIssue = Prisma.sql`EXISTS (SELECT 1 FROM ig_arrival_issues i WHERE i.personHash=SHA2(p.personUid,256) AND i.active=1)`;
const problem = Prisma.sql`(p.state='CONFLICT' OR m.factsIdentityIssue IS NOT NULL OR m.latestSiteStatusCancelled=1 OR ${sourceIssue} OR p.bindingError IS NOT NULL OR c.id IS NULL OR COALESCE(c.igRequirementsConflict,0)=1 OR m.arrivalDate IS NULL OR m.locationUid IS NULL OR ${hasReturned} OR ${deliveryProblem} OR ${requirementsReviewAvailable}>0 OR COALESCE(req.attentionCount,0)>0 OR NOT ${requirementsKnown()})`;
const common = (f: Filters, includeRequirements = true) =>
  Prisma.sql`FROM ig_arrival_persons p JOIN ig_arrival_members m ON m.personUid=p.personUid LEFT JOIN candidates c ON c.id=p.candidateId AND ${safeArrivalCandidate} ${includeRequirements ? requirementsJoin(f) : Prisma.empty}`;
function base(f: Filters) {
  const archive =
    f.archive === "current"
      ? Prisma.sql`(m.cancelled=0 AND m.factsArchived=0)`
      : Prisma.sql`(m.cancelled=1 OR m.factsArchived=1)`;
  return Prisma.sql`WHERE ${archive} ${f.dateFrom ? Prisma.sql`AND m.arrivalDate>=${f.dateFrom}` : Prisma.empty} ${f.dateTo ? Prisma.sql`AND m.arrivalDate<=${f.dateTo}` : Prisma.empty} ${f.locationUid ? Prisma.sql`AND m.locationUid=${f.locationUid}` : Prisma.empty}`;
}
function extra(f: Filters) {
  return Prisma.sql`${f.q ? Prisma.sql`AND (LOCATE(${f.q},COALESCE(m.fullName,c.fullName,''))>0 OR LOCATE(${f.q},COALESCE(p.rawSourceCode1c,p.code1c))>0)` : Prisma.empty} ${f.documentStatus ? Prisma.sql`AND ${docStatus}=${f.documentStatus}` : Prisma.empty} ${f.needsAttention !== null ? Prisma.sql`AND ${problem}=${f.needsAttention ? 1 : 0}` : Prisma.empty} ${f.requirementsAction ? Prisma.sql`AND ${requirementsAction()}=${f.requirementsAction}` : Prisma.empty}`;
}
const isIssues = Prisma.sql`(p.state='CONFLICT' OR m.arrivalDate IS NULL OR m.locationUid IS NULL)`;
const orderType = Prisma.sql`CASE WHEN ${isIssues} THEN '0' ELSE '1' END`;
const orderDate = Prisma.sql`CASE WHEN ${isIssues} THEN '' ELSE m.arrivalDate END`;
const orderLocation = Prisma.sql`CASE WHEN ${isIssues} THEN '' ELSE m.locationUid END`;
@Injectable()
export class IgArrivalRegistryService {
  private readonly logger = new Logger(IgArrivalRegistryService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly catalog?: DocumentCatalogService,
  ) {}
  private refreshCatalog(): void {
    if (this.catalog)
      void this.catalog
        .ensure()
        .catch(() => this.logger.warn("Document catalog refresh unavailable"));
  }
  private async sync() {
    const row = await this.prisma.igArrivalSyncState.findUnique({
      where: { id: "singleton" },
      select: { completedAt: true },
    });
    return { lastCompletedAt: row?.completedAt?.toISOString() ?? null };
  }
  async groups(
    principal: AuthPrincipal,
    q: IgArrivalRegistryQueryDto,
  ): Promise<IgArrivalRegistryGroupsDto> {
    requireReviewGroup(principal, "IG");
    this.refreshCatalog();
    const f = filters(q),
      limit = q.limit ?? 50,
      after = cursor(q.cursor, f, "groups", null);
    const matched = extra(f);
    const rows = await this.prisma.$queryRaw<GroupRow[]>(
      Prisma.sql`SELECT ${orderType} AS groupType, NULLIF(${orderDate},'') AS arrivalDate, NULLIF(${orderLocation},'') AS locationUid, CASE WHEN ${isIssues} THEN NULL ELSE MAX(m.locationName) END AS locationName, COUNT(*) AS totalParticipationCount, SUM(CASE WHEN 1=1 ${matched} THEN 1 ELSE 0 END) AS participationCount, SUM(CASE WHEN ${problem} ${matched} THEN 1 ELSE 0 END) AS needsAttentionCount ${common(f)} ${base(f)} ${after ? Prisma.sql`AND (${orderType}, ${orderDate}, ${orderLocation}) > (${after[0]},${after[1]},${after[2]})` : Prisma.empty} GROUP BY ${orderType},${orderDate},${orderLocation} HAVING participationCount > 0 ORDER BY groupType,arrivalDate,locationUid LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        groupKey: groupKey(r.arrivalDate, r.locationUid),
        group: r.groupType === "0" ? "issues" : "assigned",
        arrivalDate: r.arrivalDate,
        locationUid: r.locationUid,
        locationName: r.locationName,
        totalParticipationCount: Number(r.totalParticipationCount),
        participationCount: Number(r.participationCount),
        needsAttentionCount: Number(r.needsAttentionCount),
      })),
      nextCursor:
        rows.length > limit && last
          ? encode([
              1,
              fingerprint(f, "groups", null),
              [last.groupType, last.arrivalDate ?? "", last.locationUid ?? ""],
            ])
          : null,
      sync: await this.sync(),
    };
  }
  async locations(
    principal: AuthPrincipal,
    q: IgArrivalRegistryLocationsQueryDto,
  ): Promise<IgArrivalRegistryLocationsDto> {
    requireReviewGroup(principal, "IG");
    if (
      q.limit !== undefined &&
      (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 50)
    )
      throw new BadRequestException("Invalid limit");
    const f = filters({
      archive: q.archive,
      locationUid: q.locationUid,
      q: q.q,
    });
    const limit = q.limit ?? 20,
      after = cursor(q.cursor, f, "locations", null);
    const rows = await this.prisma.$queryRaw<
      { locationUid: string; locationName: string | null }[]
    >(
      Prisma.sql`SELECT m.locationUid,MAX(m.locationName) AS locationName ${common(f, false)} ${base(f)} AND m.locationUid IS NOT NULL ${f.q ? Prisma.sql`AND (LOCATE(${f.q},COALESCE(m.locationName,''))>0 OR LOCATE(${f.q},m.locationUid)>0)` : Prisma.empty} ${after ? Prisma.sql`AND m.locationUid>${after[0]}` : Prisma.empty} GROUP BY m.locationUid ORDER BY m.locationUid LIMIT ${limit + 1}`,
    );
    const items = rows.slice(0, limit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encode([1, fingerprint(f, "locations", null), [last.locationUid]])
          : null,
    };
  }
  async participations(
    principal: AuthPrincipal,
    q: IgArrivalRegistryParticipationsQueryDto,
  ): Promise<IgArrivalRegistryParticipationsDto> {
    requireReviewGroup(principal, "IG");
    this.refreshCatalog();
    const f = filters(q),
      limit = q.limit ?? 50,
      key = parseGroup(q.groupKey),
      after = cursor(q.cursor, f, "participations", q.groupKey);
    const selector =
      key.date && key.location
        ? Prisma.sql`AND NOT ${isIssues} AND m.arrivalDate=${key.date} AND m.locationUid=${key.location}`
        : Prisma.sql`AND ${isIssues}`;
    const uid = Prisma.sql`COALESCE(m.arrivalMemberUid,CONCAT('~',p.personUid))`;
    const rows = await this.prisma.$queryRaw<ParticipationRow[]>(
      Prisma.sql`SELECT m.arrivalMemberUid,p.personUid,COALESCE(p.rawSourceCode1c,p.code1c) AS code1c,c.id AS candidateId,COALESCE(m.fullName,c.fullName) AS fullName,m.arrivalDate,m.arrivalDateTime,m.locationUid,m.locationName,m.factsIdentityIssue AS factIdentityIssue,m.latestSiteStatusCancelled,CASE WHEN m.arrivalMemberUid IS NULL THEN 'ISSUE' WHEN m.cancelled=1 THEN 'CANCELLED' WHEN p.state='CONFLICT' THEN 'ISSUE' WHEN m.factsArchived=1 THEN 'HISTORICAL' ELSE 'CURRENT' END AS participationStatus,p.state AS personState,${docStatus} AS documentStatus,${approvedCount} AS approvedDocuments,${confirmedCount} AS confirmedDocuments,CASE WHEN c.id IS NULL THEN 'UNKNOWN' WHEN ${approvedCount}=0 THEN 'NOT_REQUIRED' WHEN ${deliveryProblem} THEN 'NEEDS_ATTENTION' WHEN ${confirmedCount}<${approvedCount} THEN 'PENDING' ELSE 'CONFIRMED' END AS erpDeliveryStatus,CASE WHEN c.id IS NULL THEN 'UNKNOWN' WHEN c.igCompletionVerified=1 AND c.igCompletedAt IS NOT NULL THEN 'DOCUMENTS_COMPLETED' ELSE 'IN_PROGRESS' END AS employmentStatus,CASE WHEN ${problem} THEN 1 ELSE 0 END AS needsAttention,CASE WHEN p.state='CONFLICT' THEN 'ARRIVAL_SOURCE_CONFLICT' WHEN m.factsIdentityIssue IS NOT NULL THEN m.factsIdentityIssue WHEN m.latestSiteStatusCancelled=1 THEN 'ARRIVAL_SITE_STATUS_CANCELLED' WHEN p.bindingError IS NOT NULL THEN p.bindingError WHEN ${sourceIssue} THEN (SELECT i.code FROM ig_arrival_issues i WHERE i.personHash=SHA2(p.personUid,256) AND i.active=1 ORDER BY i.updatedAt DESC,i.id DESC LIMIT 1) WHEN m.arrivalDate IS NULL OR m.locationUid IS NULL THEN 'ARRIVAL_GROUP_UNASSIGNED' WHEN c.igRequirementsConflict=1 THEN 'ERP_IG_REQUIREMENTS_CONFLICT' WHEN ${hasReturned} THEN 'DOCUMENT_RETURNED' WHEN ${deliveryProblem} THEN 'ERP_DELIVERY_NEEDS_ATTENTION' ELSE NULL END AS issueCode,p.revision AS sourceRevision,${requirementsKnown()} AS requirementsKnown, CASE WHEN ${deliveryProblem} THEN 1 ELSE 0 END AS deliveryNeedsAttention, req.requiredCount,req.presentCount,req.acceptedCount,req.reviewCount,req.returnedCount,req.missingCount,req.processingCount,req.attentionCount,${requirementsReviewAvailable} AS reviewAvailable,${requirementsAction()} AS requirementsAction ${common(f)} ${base(f)} ${selector} ${extra(f)} ${after ? Prisma.sql`AND ${uid}>${after[0]}` : Prisma.empty} ORDER BY ${uid} LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      items: page.map(
        ({
          issueCode,
          factIdentityIssue,
          latestSiteStatusCancelled,
          deliveryNeedsAttention,
          requirementsKnown: rawKnown,
          requiredCount,
          presentCount,
          acceptedCount,
          reviewCount,
          returnedCount,
          missingCount,
          processingCount,
          attentionCount,
          reviewAvailable,
          requirementsAction: nextAction,
          ...r
        }) => ({
          ...r,
          deliveryNeedsAttention: Boolean(deliveryNeedsAttention),
          requirements: {
            known: Boolean(rawKnown),
            required: rawKnown ? Number(requiredCount) : null,
            present: rawKnown ? Number(presentCount) : null,
            accepted: rawKnown ? Number(acceptedCount) : null,
            review: rawKnown ? Number(reviewCount) : null,
            returned: rawKnown ? Number(returnedCount) : null,
            missing: rawKnown ? Number(missingCount) : null,
            processing: rawKnown ? Number(processingCount) : null,
            completed: rawKnown
              ? Number(requiredCount) > 0 &&
                Number(acceptedCount) === Number(requiredCount) &&
                Number(attentionCount) === 0
              : null,
            nextAction,
          },
          reviewAvailable: Number(reviewAvailable),
          action:
            r.candidateId === null
              ? "NONE"
              : Number(reviewAvailable) > 0
                ? "REVIEW"
                : "OPEN_CARD",
          approvedDocuments: Number(r.approvedDocuments),
          confirmedDocuments: Number(r.confirmedDocuments),
          needsAttention: Boolean(r.needsAttention),
          issueCodes: [
            ...new Set([
              ...(issueCode ? [issueCode] : []),
              ...(factIdentityIssue ? [factIdentityIssue] : []),
              ...(latestSiteStatusCancelled
                ? ["ARRIVAL_SITE_STATUS_CANCELLED"]
                : []),
              ...(r.candidateId === null ? ["PROFILE_MISSING"] : []),
            ]),
          ],
          sourceRevision: String(r.sourceRevision),
          statusScope: "CURRENT_CANDIDATE",
          oneCEmploymentStatus: "UNKNOWN",
        }),
      ),
      nextCursor:
        rows.length > limit && last
          ? encode([
              1,
              fingerprint(f, "participations", q.groupKey),
              [last.arrivalMemberUid ?? `~${last.personUid}`],
            ])
          : null,
      sync: await this.sync(),
    };
  }
}
