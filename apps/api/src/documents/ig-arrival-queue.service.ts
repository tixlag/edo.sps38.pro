import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { requireReviewGroup } from "./review-group";
import type {
  IgArrivalGroupsDto,
  IgArrivalPageQueryDto,
  IgArrivalPeopleDto,
  IgArrivalPeopleQueryDto,
} from "./dto/ig-arrival-queue.dto";

type GroupRow = {
  arrivalDate: string | null;
  locationUid: string | null;
  locationName: string | null;
  total: bigint;
  approved: bigint;
  confirmed: bigint;
  issues: bigint;
  waitingDocuments: bigint;
  inReview: bigint;
  returned: bigint;
  completed: bigint;
  sending: bigint;
  needsAttention: bigint;
};
type PersonRow = {
  personUid: string;
  code1c: string;
  candidateId: string | null;
  fullName: string | null;
  arrivalMemberUid: string | null;
  state: "CURRENT" | "CONFLICT";
  approvedDocuments: bigint;
  confirmedDocuments: bigint;
  employmentConfirmed: number | boolean;
  issueCode: string | null;
  primaryStatus:
    | "waitingDocuments"
    | "inReview"
    | "returned"
    | "completed"
    | "sending";
  needsAttention: number | boolean;
};
const sourceIssue = Prisma.sql`EXISTS (SELECT 1 FROM ig_arrival_issues i WHERE i.personHash = SHA2(p.personUid, 256) AND i.active = 1)`;
const issue = Prisma.sql`(p.state = 'CONFLICT' OR m.arrivalDate IS NULL OR m.locationUid IS NULL)`;
const approved = Prisma.sql`EXISTS (SELECT 1 FROM documents d WHERE d.candidateId = p.candidateId AND d.status IN ('APPROVED', 'SIGNED'))`;
const confirmed = Prisma.sql`(c.igCompletionVerified = 1 AND c.igCompletedAt IS NOT NULL)`;
const returned = Prisma.sql`EXISTS (SELECT 1 FROM documents d WHERE d.candidateId = p.candidateId AND d.status = 'RETURNED')`;
const inReview = Prisma.sql`EXISTS (SELECT 1 FROM documents d WHERE d.candidateId = p.candidateId AND d.status IN ('IN_REVIEW','OCR_PENDING','UPLOADED'))`;
const deliveryProblem = Prisma.sql`EXISTS (SELECT 1 FROM documents d JOIN document_versions v ON v.documentId = d.id AND v.version = d.currentVersion LEFT JOIN erp_document_deliveries x ON x.versionId = v.id WHERE d.candidateId = p.candidateId AND d.status IN ('APPROVED','SIGNED') AND (x.id IS NULL OR x.status IN ('WAITING_CONTRACT','REQUIRES_MANUAL') OR (x.status = 'SENT' AND NOT EXISTS (SELECT 1 FROM erp_document_attempts a WHERE a.deliveryId = x.id AND a.receiptValidated = 1 AND a.finishedAt IS NOT NULL AND a.errorCode IS NULL))))`;
const sending = Prisma.sql`EXISTS (SELECT 1 FROM documents d JOIN document_versions v ON v.documentId = d.id AND v.version = d.currentVersion LEFT JOIN erp_document_deliveries x ON x.versionId = v.id WHERE d.candidateId = p.candidateId AND d.status IN ('APPROVED','SIGNED') AND (x.id IS NULL OR x.status <> 'SENT' OR NOT EXISTS (SELECT 1 FROM erp_document_attempts a WHERE a.deliveryId = x.id AND a.receiptValidated = 1 AND a.finishedAt IS NOT NULL AND a.errorCode IS NULL)))`;
const primaryStatus = Prisma.sql`CASE WHEN ${confirmed} THEN 'completed' WHEN ${returned} THEN 'returned' WHEN ${inReview} THEN 'inReview' WHEN ${sending} THEN 'sending' ELSE 'waitingDocuments' END`;
const problem = Prisma.sql`(p.state = 'CONFLICT' OR ${sourceIssue} OR p.bindingError IS NOT NULL OR p.syncError IS NOT NULL OR c.igRequirementsConflict = 1 OR m.arrivalDate IS NULL OR m.locationUid IS NULL OR ${returned} OR ${deliveryProblem})`;
function bounds(q: IgArrivalPageQueryDto) {
  const limit = q.limit ?? 50,
    offset = q.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100000 ||
    (q.q?.length ?? 0) > 128
  )
    throw new BadRequestException("Invalid pagination");
  return { limit, offset };
}
function filter(q: IgArrivalPageQueryDto) {
  const search = q.q?.trim();
  return search
    ? Prisma.sql`AND (LOCATE(${search}, COALESCE(m.fullName, c.fullName, '')) > 0 OR LOCATE(${search}, p.code1c) > 0)`
    : Prisma.empty;
}
@Injectable()
export class IgArrivalQueueService {
  constructor(private readonly prisma: PrismaService) {}
  async groups(
    principal: AuthPrincipal,
    q: IgArrivalPageQueryDto,
  ): Promise<IgArrivalGroupsDto> {
    requireReviewGroup(principal, "IG");
    const { limit, offset } = bounds(q);
    const rows = await this.prisma.$queryRaw<GroupRow[]>(Prisma.sql`
   SELECT CASE WHEN ${issue} THEN NULL ELSE m.arrivalDate END AS arrivalDate,
          CASE WHEN ${issue} THEN NULL ELSE m.locationUid END AS locationUid,
          CASE WHEN ${issue} THEN NULL ELSE MAX(m.locationName) END AS locationName,
          COUNT(*) AS total, SUM(CASE WHEN ${approved} THEN 1 ELSE 0 END) AS approved,
          SUM(CASE WHEN ${confirmed} THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN ${problem} THEN 1 ELSE 0 END) AS issues,
          SUM(CASE WHEN ${problem} THEN 1 ELSE 0 END) AS needsAttention,
          SUM(CASE WHEN ${primaryStatus} = 'waitingDocuments' THEN 1 ELSE 0 END) AS waitingDocuments,
          SUM(CASE WHEN ${primaryStatus} = 'inReview' THEN 1 ELSE 0 END) AS inReview,
          SUM(CASE WHEN ${primaryStatus} = 'returned' THEN 1 ELSE 0 END) AS returned,
          SUM(CASE WHEN ${primaryStatus} = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN ${primaryStatus} = 'sending' THEN 1 ELSE 0 END) AS sending
   FROM ig_arrival_persons p LEFT JOIN ig_arrival_members m ON m.arrivalMemberUid = p.currentMemberUid
   LEFT JOIN candidates c ON c.id = p.candidateId
   WHERE p.igVerified = 1 AND p.state IN ('CURRENT','CONFLICT') ${filter(q)}
   GROUP BY CASE WHEN ${issue} THEN NULL ELSE m.arrivalDate END, CASE WHEN ${issue} THEN NULL ELSE m.locationUid END
   ORDER BY arrivalDate IS NULL DESC, arrivalDate ASC, locationUid ASC LIMIT ${limit + 1} OFFSET ${offset}`);
    return {
      items: rows.slice(0, limit).map((r) => ({
        group: r.arrivalDate && r.locationUid ? "assigned" : "issues",
        arrivalDate: r.arrivalDate,
        locationUid: r.locationUid,
        locationName: r.locationName,
        total: Number(r.total),
        approved: Number(r.approved),
        confirmed: Number(r.confirmed),
        issues: Number(r.issues),
        needsAttention: Number(r.needsAttention),
        waitingDocuments: Number(r.waitingDocuments),
        inReview: Number(r.inReview),
        returned: Number(r.returned),
        completed: Number(r.completed),
        sending: Number(r.sending),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  async people(
    principal: AuthPrincipal,
    q: IgArrivalPeopleQueryDto,
  ): Promise<IgArrivalPeopleDto> {
    requireReviewGroup(principal, "IG");
    const { limit, offset } = bounds(q);
    if (q.group !== "assigned" && q.group !== "issues")
      throw new BadRequestException("Invalid group");
    if (q.group === "assigned") {
      const value = q.arrivalDate;
      const date =
        value && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? new Date(`${value}T00:00:00.000Z`)
          : null;
      if (
        !date ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value ||
        !q.locationUid ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          q.locationUid,
        )
      )
        throw new BadRequestException("Invalid arrival group key");
    }
    const groupFilter =
      q.group === "issues"
        ? Prisma.sql`AND ${issue}`
        : Prisma.sql`AND NOT ${issue} AND m.arrivalDate = ${q.arrivalDate} AND m.locationUid = ${q.locationUid}`;
    const statusCondition =
      q.status === "needsAttention"
        ? Prisma.sql`AND (${problem})`
        : q.status
          ? Prisma.sql`AND (${primaryStatus} = ${q.status})`
          : Prisma.empty;
    const rows = await this.prisma.$queryRaw<PersonRow[]>(Prisma.sql`
   SELECT p.personUid, p.code1c, p.candidateId, COALESCE(m.fullName, c.fullName) AS fullName, p.currentMemberUid AS arrivalMemberUid, p.state,
    (SELECT COUNT(*) FROM documents d WHERE d.candidateId = p.candidateId AND d.status IN ('APPROVED','SIGNED')) AS approvedDocuments,
    (SELECT COUNT(*) FROM documents d JOIN document_versions v ON v.documentId = d.id AND v.version = d.currentVersion JOIN erp_document_deliveries x ON x.versionId = v.id AND x.status = 'SENT' AND x.transport = 'multipart-v2' WHERE d.candidateId = p.candidateId AND d.status IN ('APPROVED','SIGNED') AND v.status IN ('APPROVED','SIGNED') AND EXISTS (SELECT 1 FROM erp_document_attempts a WHERE a.deliveryId = x.id AND a.receiptValidated = 1 AND a.finishedAt IS NOT NULL AND a.errorCode IS NULL)) AS confirmedDocuments,
    CASE WHEN ${confirmed} THEN 1 ELSE 0 END AS employmentConfirmed,
    ${primaryStatus} AS primaryStatus, CASE WHEN ${problem} THEN 1 ELSE 0 END AS needsAttention,
    CASE WHEN p.state = 'CONFLICT' THEN 'ARRIVAL_SOURCE_CONFLICT' WHEN p.bindingError IS NOT NULL THEN p.bindingError WHEN ${sourceIssue} THEN (SELECT i.code FROM ig_arrival_issues i WHERE i.personHash = SHA2(p.personUid, 256) AND i.active = 1 ORDER BY i.updatedAt DESC LIMIT 1) WHEN m.arrivalDate IS NULL OR m.locationUid IS NULL THEN 'ARRIVAL_GROUP_UNASSIGNED' WHEN c.igRequirementsConflict = 1 THEN 'ERP_IG_REQUIREMENTS_CONFLICT' WHEN ${returned} THEN 'DOCUMENT_RETURNED' WHEN ${deliveryProblem} THEN 'ERP_DELIVERY_NEEDS_ATTENTION' ELSE p.syncError END AS issueCode
   FROM ig_arrival_persons p LEFT JOIN ig_arrival_members m ON m.arrivalMemberUid = p.currentMemberUid LEFT JOIN candidates c ON c.id = p.candidateId
   WHERE p.igVerified = 1 AND p.state IN ('CURRENT','CONFLICT') ${groupFilter} ${filter(q)} ${statusCondition}
   ORDER BY COALESCE(m.fullName, c.fullName, ''), p.personUid LIMIT ${limit + 1} OFFSET ${offset}`);
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...r,
        approvedDocuments: Number(r.approvedDocuments),
        confirmedDocuments: Number(r.confirmedDocuments),
        employmentConfirmed: Boolean(r.employmentConfirmed),
        needsAttention: Boolean(r.needsAttention),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
}
