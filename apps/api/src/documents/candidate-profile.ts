import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { CandidateSnapshot } from "./document-contract";
import { candidateReviewGroup } from "./review-group";

/** Review queue profile filters (all optional, combined with AND). */
export interface ReviewProfileFilters {
  q?: string;
  citizenship?: string;
  manager?: string;
  mentor?: string;
  hasMentor?: boolean;
  birthDateFrom?: string;
  birthDateTo?: string;
  positionCode?: string;
  projectCode?: string;
  candidateId?: string;
  managerCode1c?: string;
  mentorCode1c?: string;
}

type SnapshotRow = {
  fullName?: string | null;
  birthDate?: string | null;
  citizenship?: string | null;
  positionCode?: string | null;
  positionName?: string | null;
  projectCode?: string | null;
  projectName?: string | null;
  managerName?: string | null;
  managerCode1c?: string | null;
  mentorName?: string | null;
  mentorPosition?: string | null;
  mentorCode1c?: string | null;
  isReemployment?: boolean;
};

/**
 * Prisma update for a normalized snapshot. Only keys actually present in the
 * snapshot are written (absent = undefined = untouched); a present-but-empty
 * value arrives as NULL and clears the column. Returns null when the snapshot
 * carries no fields, so uploads without a profile never touch stored data.
 */
export interface CandidateProfileData {
  fullName?: string | null;
  birthDate?: Date | null;
  citizenship?: string | null;
  positionCode?: string | null;
  positionName?: string | null;
  projectCode?: string | null;
  projectName?: string | null;
  managerName?: string | null;
  managerCode1c?: string | null;
  mentorName?: string | null;
  mentorPosition?: string | null;
  mentorCode1c?: string | null;
  isReemployment?: boolean;
  profileSyncedAt?: Date;
}
export function snapshotUpdateInput(
  snapshot: SnapshotRow | CandidateSnapshot | undefined | null,
): CandidateProfileData | null {
  if (!snapshot) return null;
  const data: CandidateProfileData = {};
  const put = <K extends keyof CandidateProfileData>(
    key: K,
    value: CandidateProfileData[K] | undefined,
  ) => {
    if (value !== undefined) data[key] = value;
  };
  put("fullName", snapshot.fullName);
  put(
    "birthDate",
    snapshot.birthDate === undefined
      ? undefined
      : snapshot.birthDate === null
        ? null
        : parseBirthDateBound(snapshot.birthDate, "birthDate"),
  );
  put("citizenship", snapshot.citizenship);
  put("positionCode", snapshot.positionCode);
  put("positionName", snapshot.positionName);
  put("projectCode", snapshot.projectCode);
  put("projectName", snapshot.projectName);
  put("managerName", snapshot.managerName);
  put("managerCode1c", snapshot.managerCode1c);
  put("mentorName", snapshot.mentorName);
  put("mentorPosition", snapshot.mentorPosition);
  put("mentorCode1c", snapshot.mentorCode1c);
  put("isReemployment", snapshot.isReemployment);
  if (Object.keys(data).length === 0) return null;
  data.profileSyncedAt = new Date();
  return data;
}

/** Strict YYYY-MM-DD calendar date parsed as UTC midnight for DATE columns. */
export function parseBirthDateBound(value: string, field: string): Date {
  const text = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) !== text
  )
    throw new BadRequestException(`${field} must be a real YYYY-MM-DD date`);
  return new Date(`${text}T00:00:00.000Z`);
}

type ProfileRow = {
  statusId?: string | null;
  statusName?: string | null;
  managerId?: string | null;
  reviewGroup?: "RU" | "IG" | null;
  id: string;
  chatUuid: string | null;
  code1c: string | null;
  fullName: string | null;
  birthDate: Date | null;
  citizenship: string | null;
  positionCode: string | null;
  positionName: string | null;
  projectCode: string | null;
  projectName: string | null;
  managerName: string | null;
  managerCode1c: string | null;
  mentorName: string | null;
  mentorPosition: string | null;
  mentorCode1c: string | null;
  isReemployment: boolean;
  profileSyncedAt: Date | null;
};

/** Per-request progress enrichment for the review queue. */
export interface CandidateProfileEnrichment {
  approvedDocuments?: number;
  requiredDocuments?: number | null;
}

/**
 * Serializes a candidate row into the CandidateProfileDto wire shape.
 * Progress defaults to empty values; the review queue patches it via
 * enrichReviewCandidates (batched queries, no N+1).
 */
export function toCandidateProfile(
  row: ProfileRow | null | undefined,
  enrichment?: CandidateProfileEnrichment,
) {
  if (!row) return null;
  return {
    id: row.id,
    statusId: row.statusId ?? null,
    statusName: row.statusName ?? null,
    managerId: row.managerId ?? null,
    reviewGroup: candidateReviewGroup(row),
    chatUuid: row.chatUuid,
    code1c: row.code1c,
    fullName: row.fullName,
    birthDate: row.birthDate ? row.birthDate.toISOString().slice(0, 10) : null,
    citizenship: row.citizenship,
    positionCode: row.positionCode,
    positionName: row.positionName,
    projectCode: row.projectCode,
    projectName: row.projectName,
    managerName: row.managerName,
    managerCode1c: row.managerCode1c,
    mentorName: row.mentorName,
    mentorPosition: row.mentorPosition,
    mentorCode1c: row.mentorCode1c,
    isReemployment: row.isReemployment,
    profileSyncedAt: row.profileSyncedAt
      ? row.profileSyncedAt.toISOString()
      : null,
    approvedDocuments: enrichment?.approvedDocuments ?? 0,
    requiredDocuments: enrichment?.requiredDocuments ?? null,
  };
}

/**
 * Candidate-side WHERE for the review queue. LIKE contains relies on the
 * utf8mb4_unicode_ci collation, which is already case-insensitive.
 */
export function buildCandidateProfileWhere(
  filters: ReviewProfileFilters,
): Prisma.CandidateWhereInput | undefined {
  const and: Prisma.CandidateWhereInput[] = [];
  const text = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const q = text(filters.q);
  if (q) and.push({ fullName: { contains: q } });
  const citizenship = text(filters.citizenship)?.toLowerCase();
  if (citizenship) and.push({ citizenship });
  const manager = text(filters.manager);
  if (manager)
    and.push({
      OR: [
        { managerName: { contains: manager } },
        { managerCode1c: { contains: manager } },
      ],
    });
  const mentor = text(filters.mentor);
  if (mentor)
    and.push({
      OR: [
        { mentorName: { contains: mentor } },
        { mentorCode1c: { contains: mentor } },
      ],
    });
  if (filters.hasMentor !== undefined)
    and.push(
      filters.hasMentor
        ? {
            OR: [
              { mentorName: { not: null } },
              { mentorCode1c: { not: null } },
            ],
          }
        : { mentorName: null, mentorCode1c: null },
    );
  const from = text(filters.birthDateFrom);
  const to = text(filters.birthDateTo);
  if (from || to)
    and.push({
      birthDate: {
        ...(from ? { gte: parseBirthDateBound(from, "birthDateFrom") } : {}),
        ...(to ? { lte: parseBirthDateBound(to, "birthDateTo") } : {}),
      },
    });
  const positionCode = text(filters.positionCode);
  if (positionCode) and.push({ positionCode });
  const projectCode = text(filters.projectCode);
  if (projectCode) and.push({ projectCode });
  const candidateId = text(filters.candidateId);
  if (candidateId) and.push({ id: candidateId });
  const managerCode1c = text(filters.managerCode1c);
  if (managerCode1c) and.push({ managerCode1c });
  const mentorCode1c = text(filters.mentorCode1c);
  if (mentorCode1c) and.push({ mentorCode1c });
  if (and.length === 0) return undefined;
  return and.length === 1 ? and[0] : { AND: and };
}
