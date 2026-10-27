import type { DocumentStatus } from "@edo/api-client";
import { formatDateRu } from "./date-format";
export const LK_BASE_URL_FALLBACK = "https://lk.sps38.pro";

/** Browser base of the LK directory; override via VITE_LK_BASE_URL. */
export function lkBaseUrl(): string {
  const fromEnv =
    typeof import.meta !== "undefined"
      ? ((import.meta.env?.VITE_LK_BASE_URL as string | undefined) ?? "")
      : "";
  const trimmed = fromEnv.trim().replace(/\/+$/, "");
  return trimmed || LK_BASE_URL_FALLBACK;
}

/**
 * Public LK employee card URL, or null when there is no 1C code.
 * Format: {base}/public/employee/{encodeURIComponent(code1C)}?size_width=WIDE_1200
 */
export function lkEmployeeUrl(
  code1c: string | null | undefined,
): string | null {
  if (!code1c) return null;
  return `${lkBaseUrl()}/public/employee/${encodeURIComponent(code1c)}?size_width=WIDE_1200`;
}

/** "Иванова Анна Сергеевна" -> "ИА". Empty/blank -> "?". */
export function candidateInitials(fullName: string | null | undefined): string {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toLocaleUpperCase("ru");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "1990-05-17" -> "17.05.1990". Anything else passes through (or "—"). */
export function formatBirthDateRu(
  birthDate: string | null | undefined,
): string {
  return formatDateRu(birthDate);
}

/**
 * Full "Объект: ..." header line from the ERP snapshot.
 * Both null/blank -> "Объект: —".
 */
export function formatCandidateObject(
  projectName: string | null | undefined,
  projectCode: string | null | undefined,
): string {
  const name = (projectName ?? "").trim();
  const code = (projectCode ?? "").trim();
  if (name && code) return `Объект: ${name} (${code})`;
  if (name) return `Объект: ${name}`;
  if (code) return `Объект: (${code})`;
  return "Объект: —";
}

/**
 * "Подтверждено 3 из 5"; unknown catalog total (no positionCode) ->
 * "Подтверждено 3 · всего ожидается: неизвестно (нет должности)".
 */
export function formatDocumentProgress(
  approved: number,
  required: number | null | undefined,
): string {
  if (required === null || required === undefined) {
    return `Подтверждено ${approved} · всего ожидается: неизвестно (нет должности)`;
  }
  return `Подтверждено ${approved} из ${required}`;
}

/**
 * Progress-bar percent (0–100, clamped), or null when there is no
 * meaningful total (null/zero) so the caller renders no bar.
 */
export function documentProgressPercent(
  approved: number,
  required: number | null | undefined,
): number | null {
  if (required === null || required === undefined || required <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((approved / required) * 100)));
}

export type ReviewTab = "IN_REVIEW" | "ERP_PENDING" | "RETURNED";

const REVIEW_TABS: ReviewTab[] = ["IN_REVIEW", "ERP_PENDING", "RETURNED"];

export interface ReviewQueueFilters {
  status: ReviewTab;
  currentStatus?: DocumentStatus;
  managerName?: string;
  managerUnassigned?: boolean;
  /** Exact candidate id (ФИО selector over review-candidates). */
  candidateId?: string;
  documentTypeCode?: string;
  /** Exact citizenship code (review facets). */
  citizenship?: string;
  /** Exact manager code_1c (review facets). */
  managerCode1c?: string;
  /** Exact mentor code_1c (review facets). */
  mentorCode1c?: string;
  hasMentor?: boolean;
  birthDateFrom?: string;
  birthDateTo?: string;
  /** Exact LK position code_1c (positions directory). */
  positionCode?: string;
  /** Exact project code (review facets). */
  projectCode?: string;
  cursor?: string;
  /**
   * Open candidate drawer (view state only: never sent to the API, never a
   * filter, ignored by {@link hasActiveReviewFilters}).
   */
  candidate?: string;
}

function textParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function dateParam(value: unknown): string | undefined {
  const text = textParam(value);
  return text && DATE_RE.test(text) ? text : undefined;
}

function booleanParam(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

/** Parse untrusted TanStack Router search params into review-queue filters. */
export function parseReviewSearchParams(
  raw: Record<string, unknown>,
): ReviewQueueFilters {
  const status = String(raw.status ?? "IN_REVIEW");
  return {
    status: (REVIEW_TABS as string[]).includes(status)
      ? (status as ReviewTab)
      : "IN_REVIEW",
    currentStatus: [
      "DRAFT",
      "UPLOADED",
      "OCR_PENDING",
      "OCR_FAILED",
      "IN_REVIEW",
      "RETURNED",
      "APPROVED",
      "SIGNED",
      "EXPIRED",
    ].includes(String(raw.currentStatus))
      ? (String(raw.currentStatus) as DocumentStatus)
      : undefined,
    managerName: textParam(raw.managerName),
    managerUnassigned: booleanParam(raw.managerUnassigned),
    candidateId: textParam(raw.candidateId),
    documentTypeCode: textParam(raw.documentTypeCode),
    citizenship: textParam(raw.citizenship),
    managerCode1c: textParam(raw.managerCode1c),
    mentorCode1c: textParam(raw.mentorCode1c),
    hasMentor: booleanParam(raw.hasMentor),
    birthDateFrom: dateParam(raw.birthDateFrom),
    birthDateTo: dateParam(raw.birthDateTo),
    positionCode: textParam(raw.positionCode),
    projectCode: textParam(raw.projectCode),
    cursor: textParam(raw.cursor),
    candidate: textParam(raw.candidate),
  };
}

/** True when any server-side filter (besides status tab, cursor, drawer) is set. */
export function hasActiveReviewFilters(filters: ReviewQueueFilters): boolean {
  return Boolean(
    filters.currentStatus ??
    filters.managerName ??
    (filters.managerUnassigned ? "unassigned" : undefined) ??
    filters.candidateId ??
    filters.documentTypeCode ??
    filters.citizenship ??
    filters.managerCode1c ??
    filters.mentorCode1c ??
    filters.birthDateFrom ??
    filters.birthDateTo ??
    filters.positionCode ??
    filters.projectCode ??
    (filters.hasMentor !== undefined ? "hasMentor" : undefined),
  );
}
