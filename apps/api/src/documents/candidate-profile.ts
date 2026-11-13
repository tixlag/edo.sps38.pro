import { selectedValues } from "../common/query-values";
import { managerFilter } from "./manager-filter";
import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { CandidateSnapshot } from "./document-contract";
import { candidateReviewGroup } from "./review-group";

export const DEFAULT_EXCLUDED_RU_STATUS_IDS = [
  "Заезд",
  "Отказ",
  "ЗаездПодтвержден",
] as const;

export const DEFAULT_EXCLUDED_RU_STATUS_NAMES = [
  "Заезд/выход",
  "Отказ",
  "Заезд подтвержден",
] as const;

export function buildDefaultExcludedRuStatusWhere() {
  return {
    OR: [
      { statusId: null },
      {
        NOT: {
          OR: [
            { statusId: { in: [...DEFAULT_EXCLUDED_RU_STATUS_IDS] } },
            { statusName: { in: [...DEFAULT_EXCLUDED_RU_STATUS_NAMES] } },
          ],
        },
      },
    ],
  };
}

/** Unknown facts remain visible until the catalog supplies a boolean. */
export function buildExcludeEmployedWhere() {
  return { OR: [{ employed: false }, { employed: null }] };
}

/** Review queue profile filters (all optional, combined with AND). */
export interface ReviewProfileFilters {
  includeEmployed?: boolean;
  candidateIds?: string[];
  statusIds?: string[];
  citizenships?: string[];
  positionCodes?: string[];
  projectCodes?: string[];
  mentorCodes1c?: string[];
  managerKeys?: string[];
  hasMentorValues?: string[];
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
  statusId?: string;
  managerCode1c?: string;
  managerId?: string;
  managerName?: string;
  managerUnassigned?: boolean;
  mentorCode1c?: string;
  reviewGroup?: "RU" | "IG";
}

type SnapshotRow = {
  fullName?: string | null;
  birthDate?: string | null;
  citizenship?: string | null;
  citizenshipProvided?: boolean;
  sex?: "male" | "female" | null;
  sexKnown?: boolean;
  photoPath?: string | null;
  masterName?: string | null;
  masterCode1c?: string | null;
  supervisorName?: string | null;
  supervisorCode1c?: string | null;
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
 * snapshot are written; absent or empty values leave stored values untouched.
 * Returns null when the snapshot
 * carries no fields, so uploads without a profile never touch stored data.
 */
export interface CandidateProfileData {
  fullName?: string | null;
  birthDate?: Date | null;
  citizenship?: string | null;
  sex?: string | null;
  sexKnown?: boolean;
  photoPath?: string | null;
  masterName?: string | null;
  masterCode1c?: string | null;
  supervisorName?: string | null;
  supervisorCode1c?: string | null;
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

export function changedProfileFields(current: object, next: object): string[] {
  const before = current as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  return Object.keys(after).filter((key) => {
    if (key === "profileSyncedAt") return false;
    const a =
      before[key] instanceof Date
        ? (before[key] as Date).toISOString()
        : (before[key] ?? null);
    const b =
      after[key] instanceof Date
        ? (after[key] as Date).toISOString()
        : (after[key] ?? null);
    return a !== b;
  });
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
    if (value !== undefined && value !== null) data[key] = value;
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
  if (snapshot.citizenshipProvided !== false)
    put("citizenship", snapshot.citizenship);
  put("sex", snapshot.sex);
  put("sexKnown", snapshot.sexKnown);
  // Do not overwrite photoPath with 1C filesystem path; EDO owns public relative photoPath URL.
  put("masterName", snapshot.masterName);
  put("masterCode1c", snapshot.masterCode1c);
  put("supervisorName", snapshot.supervisorName);
  put("supervisorCode1c", snapshot.supervisorCode1c);
  const rawPos = (snapshot as { position?: { code?: string; name?: string } })
    .position;
  put("positionCode", rawPos?.code ?? snapshot.positionCode);
  put("positionName", rawPos?.name ?? snapshot.positionName);
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
  employed?: boolean | null;
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
  sex?: string | null;
  sexKnown?: boolean;
  photoPath?: string | null;
  masterName?: string | null;
  masterCode1c?: string | null;
  supervisorName?: string | null;
  supervisorCode1c?: string | null;
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
    employed: row.employed ?? null,
    statusId: row.statusId ?? null,
    statusName: row.statusName ?? null,
    managerId: row.managerId ?? null,
    reviewGroup: candidateReviewGroup(row),
    chatUuid: row.chatUuid,
    code1c: row.code1c,
    fullName: row.fullName,
    birthDate: row.birthDate ? row.birthDate.toISOString().slice(0, 10) : null,
    citizenship: row.citizenship,
    sex: row.sex ?? null,
    sexKnown: row.sexKnown ?? false,
    photoPath: row.photoPath ?? null,
    masterName: row.masterName ?? null,
    masterCode1c: row.masterCode1c ?? null,
    supervisorName: row.supervisorName ?? null,
    supervisorCode1c: row.supervisorCode1c ?? null,
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
  if (filters.reviewGroup === "RU" && !filters.includeEmployed)
    and.push(buildExcludeEmployedWhere());
  const text = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const q = text(filters.q);
  if (q) and.push({ fullName: { contains: q } });
  const citizenships = selectedValues(
    filters.citizenships,
    text(filters.citizenship),
  ).map((value) => value.toLowerCase());
  if (citizenships.length)
    and.push({
      citizenship:
        filters.citizenships === undefined
          ? citizenships[0]
          : { in: citizenships },
    });
  const manager = text(filters.manager);
  if (filters.managerKeys !== undefined) {
    const where = managerFilter(filters.managerKeys);
    if (where) and.push(where);
  } else if (filters.managerId) and.push({ managerId: filters.managerId });
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
  const mentorPresence = selectedValues(filters.hasMentorValues);
  const hasMentor =
    filters.hasMentorValues !== undefined
      ? mentorPresence.length === 1
        ? mentorPresence[0] === "true"
        : undefined
      : filters.hasMentor;
  if (hasMentor !== undefined)
    and.push(
      hasMentor
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
  const positionCodes = selectedValues(
    filters.positionCodes,
    text(filters.positionCode),
  );
  if (positionCodes.length)
    and.push({
      positionCode:
        filters.positionCodes === undefined
          ? positionCodes[0]
          : { in: positionCodes },
    });
  const projectCodes = selectedValues(
    filters.projectCodes,
    text(filters.projectCode),
  );
  if (projectCodes.length)
    and.push({
      projectCode:
        filters.projectCodes === undefined
          ? projectCodes[0]
          : { in: projectCodes },
    });
  const candidateIds = selectedValues(
    filters.candidateIds,
    text(filters.candidateId),
  );
  if (candidateIds.length)
    and.push({
      id:
        filters.candidateIds === undefined
          ? candidateIds[0]
          : { in: candidateIds },
    });
  if (filters.managerKeys === undefined && filters.managerName !== undefined) {
    and.push(
      { OR: [{ managerCode1c: null }, { managerCode1c: "" }] },
      { managerName: filters.managerName },
    );
  }
  if (filters.managerKeys === undefined && filters.managerUnassigned === true) {
    and.push(
      { OR: [{ managerCode1c: null }, { managerCode1c: "" }] },
      { OR: [{ managerName: null }, { managerName: "" }] },
    );
  }
  const managerCode1c = text(filters.managerCode1c);
  if (filters.managerKeys === undefined && managerCode1c)
    and.push({ managerCode1c });
  const mentorCodes1c = selectedValues(
    filters.mentorCodes1c,
    text(filters.mentorCode1c),
  );
  if (mentorCodes1c.length)
    and.push({
      mentorCode1c:
        filters.mentorCodes1c === undefined
          ? mentorCodes1c[0]
          : { in: mentorCodes1c },
    });
  const statusIds = selectedValues(filters.statusIds, text(filters.statusId));
  if (statusIds.length) {
    and.push({
      statusId:
        filters.statusIds === undefined ? statusIds[0] : { in: statusIds },
    });
  } else if (filters.reviewGroup === "RU") {
    and.push(buildDefaultExcludedRuStatusWhere());
  }
  if (and.length === 0) return undefined;
  return and.length === 1 ? and[0] : { AND: and };
}
