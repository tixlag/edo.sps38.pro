import { Prisma } from "@prisma/client";
import { MIGRATION_UID } from "../ocr/ocr-profile";
import { EMPLOYMENT_PATENT_UID } from "./reemployment-document-policy";
import { CATALOG_TTL_MS } from "./document-catalog.service";

// SQL counterpart to requiredApplicable: stage rules replace the legacy type rule.
// The same predicate is used for listing and server-side filtering.
const requiredType = Prisma.sql`NOT (t.code='MILITARY' AND c.sexKnown=1 AND COALESCE(c.sex,'')='female') AND (
  (EXISTS (SELECT 1 FROM document_type_stage_rules sr WHERE sr.documentTypeId=t.id)
    AND EXISTS (SELECT 1 FROM document_type_stage_rules sr WHERE sr.documentTypeId=t.id AND (
      sr.requiredForAll=1 OR (LOWER(c.citizenship)='ru' AND sr.allRu=1) OR (LOWER(c.citizenship)<>'ru' AND sr.allForeign=1)
      OR EXISTS (SELECT 1 FROM document_type_stage_positions sp WHERE sp.ruleId=sr.id AND sp.code1c=c.positionCode AND sp.required=1)
      OR EXISTS (SELECT 1 FROM document_type_stage_projects sj WHERE sj.ruleId=sr.id AND sj.code1c=c.projectCode)
      OR EXISTS (SELECT 1 FROM document_type_stage_countries sc WHERE sc.ruleId=sr.id AND LOWER(sc.code)=LOWER(c.citizenship)))))
  OR (NOT EXISTS (SELECT 1 FROM document_type_stage_rules sr WHERE sr.documentTypeId=t.id)
    AND (t.requiredForAll=1 OR (LOWER(c.citizenship)='ru' AND t.allRu=1) OR (LOWER(c.citizenship)<>'ru' AND t.allForeign=1)
      OR EXISTS (SELECT 1 FROM document_type_positions tp WHERE tp.documentTypeId=t.id AND tp.code1c=c.positionCode))))`;
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Irkutsk" }).format(
    new Date(),
  );
const prior = () =>
  Prisma.sql`EXISTS (SELECT 1 FROM candidate_previous_documents prev WHERE prev.candidateId=c.id AND LOWER(prev.documentUid)=LOWER(t.erpUid) AND prev.status='CONFIRMED' AND prev.originalAvailable=1 AND prev.originalVerified=1 AND LOWER(prev.documentUid) NOT IN (${MIGRATION_UID.toLowerCase()},${EMPLOYMENT_PATENT_UID.toLowerCase()}) AND (prev.expiresAt IS NULL OR prev.expiresAt>=${today()}) AND NOT COALESCE(JSON_TYPE(JSON_EXTRACT(prev.fields,'$.isInvalid'))='BOOLEAN' AND JSON_UNQUOTE(JSON_EXTRACT(prev.fields,'$.isInvalid'))='true',0))`;
const fallbackPrior = () =>
  Prisma.sql`((d.id IS NULL OR d.status='DRAFT') AND ${prior()})`;
const accepted = () =>
  Prisma.sql`((d.status IN ('APPROVED','SIGNED') AND v.status IN ('APPROVED','SIGNED')) OR ${fallbackPrior()})`;
const reviewAvailable = Prisma.sql`(SELECT COUNT(*) FROM documents rd JOIN document_versions rv ON rv.documentId=rd.id AND rv.version=rd.currentVersion WHERE rd.candidateId=c.id AND rd.status='IN_REVIEW' AND rv.status='IN_REVIEW')`;
export function requirementsJoin(filters: {
  dateFrom: string | null;
  dateTo: string | null;
  locationUid: string | null;
  q: string | null;
}) {
  const search = filters.q;
  const memberFilter =
    filters.dateFrom || filters.dateTo || filters.locationUid
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM ig_arrival_members fm WHERE fm.personUid=rp.personUid ${filters.dateFrom ? Prisma.sql`AND fm.arrivalDate>=${filters.dateFrom}` : Prisma.empty} ${filters.dateTo ? Prisma.sql`AND fm.arrivalDate<=${filters.dateTo}` : Prisma.empty} ${filters.locationUid ? Prisma.sql`AND fm.locationUid=${filters.locationUid}` : Prisma.empty})`
      : Prisma.empty;
  const searchFilter = search
    ? Prisma.sql`AND (LOCATE(${search},rp.code1c)>0 OR LOCATE(${search},COALESCE(c.fullName,''))>0 OR EXISTS (SELECT 1 FROM ig_arrival_members sm WHERE sm.personUid=rp.personUid AND LOCATE(${search},COALESCE(sm.fullName,''))>0))`
    : Prisma.empty;
  const previous = fallbackPrior();
  return Prisma.sql`LEFT JOIN (
 SELECT c.id AS candidateId,COUNT(*) AS requiredCount,
 SUM(CASE WHEN (d.id IS NOT NULL AND d.status<>'DRAFT') OR ${previous} THEN 1 ELSE 0 END) AS presentCount,
 SUM(CASE WHEN ${accepted()} THEN 1 ELSE 0 END) AS acceptedCount,
 SUM(CASE WHEN d.status='IN_REVIEW' AND v.status='IN_REVIEW' THEN 1 ELSE 0 END) AS reviewCount,
 SUM(CASE WHEN d.status='RETURNED' THEN 1 ELSE 0 END) AS returnedCount,
 SUM(CASE WHEN (d.id IS NULL OR d.status='DRAFT') AND NOT ${previous} THEN 1 ELSE 0 END) AS missingCount,
 SUM(CASE WHEN d.status IN ('UPLOADED','OCR_PENDING') THEN 1 ELSE 0 END) AS processingCount,
 SUM(CASE WHEN d.status IN ('OCR_FAILED','EXPIRED') OR (d.status IN ('APPROVED','SIGNED') AND (v.id IS NULL OR v.status NOT IN ('APPROVED','SIGNED'))) OR (d.status='IN_REVIEW' AND (v.id IS NULL OR v.status<>'IN_REVIEW')) THEN 1 ELSE 0 END) AS attentionCount,
 MAX(CASE WHEN LOWER(t.erpUid)=${MIGRATION_UID.toLowerCase()} THEN 1 ELSE 0 END) AS migrationRequired,
 MAX(CASE WHEN LOWER(t.erpUid)=${EMPLOYMENT_PATENT_UID.toLowerCase()} THEN 1 ELSE 0 END) AS patentRequired
 FROM candidates c JOIN ig_arrival_persons rp ON rp.candidateId=c.id AND rp.igVerified=1 ${memberFilter} ${searchFilter}
 JOIN document_types t ON t.catalogSyncedAt IS NOT NULL AND ${requiredType}
 LEFT JOIN documents d ON d.candidateId=c.id AND d.documentTypeId=t.id
 LEFT JOIN document_versions v ON v.documentId=d.id AND v.version=d.currentVersion
 GROUP BY c.id
 ) req ON req.candidateId=c.id`;
}
export function requirementsKnown() {
  const cutoff = new Date(Date.now() - CATALOG_TTL_MS);
  return Prisma.sql`(c.id IS NOT NULL AND c.positionCode IS NOT NULL AND c.positionCode<>'' AND c.citizenship IS NOT NULL AND c.citizenship<>'' AND COALESCE(c.igRequirementsConflict,0)=0 AND p.state<>'CONFLICT' AND p.bindingError IS NULL AND NOT EXISTS (SELECT 1 FROM ig_arrival_issues srcIssue WHERE srcIssue.personHash=SHA2(p.personUid,256) AND srcIssue.active=1) AND COALESCE(req.migrationRequired,0)=1 AND COALESCE(req.patentRequired,0)=1 AND EXISTS (SELECT 1 FROM document_types fresh WHERE fresh.catalogSyncedAt IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM document_types stale WHERE stale.catalogSyncedAt IS NOT NULL AND stale.catalogSyncedAt < ${cutoff})
 AND NOT ((c.sexKnown=0 OR c.sex IS NULL OR c.sex NOT IN ('male','female')) AND EXISTS (SELECT 1 FROM document_types t WHERE t.catalogSyncedAt IS NOT NULL AND t.code='MILITARY' AND ${requiredType}))
 AND NOT ((c.projectCode IS NULL OR c.projectCode='') AND EXISTS (SELECT 1 FROM document_types t WHERE t.catalogSyncedAt IS NOT NULL AND NOT (${requiredType}) AND EXISTS (SELECT 1 FROM document_type_stage_rules sr JOIN document_type_stage_projects sp ON sp.ruleId=sr.id WHERE sr.documentTypeId=t.id))) )`;
}
export function requirementsAction() {
  return Prisma.sql`CASE WHEN ${reviewAvailable}>0 THEN 'REVIEW' WHEN EXISTS (SELECT 1 FROM documents returnedDoc WHERE returnedDoc.candidateId=c.id AND returnedDoc.status='RETURNED') THEN 'RETURNED' WHEN NOT ${requirementsKnown()} THEN 'UNKNOWN' WHEN req.attentionCount>0 THEN 'ATTENTION' WHEN req.processingCount>0 THEN 'PROCESSING' WHEN req.missingCount>0 THEN 'MISSING' WHEN req.acceptedCount=req.requiredCount THEN 'COMPLETE' ELSE 'ATTENTION' END`;
}
export const requirementsReviewAvailable = reviewAvailable;
