import type {
  CandidateDocumentSummaryDto,
  DocumentVersionDto,
  PreviousDocumentAvailabilityDto,
} from "@edo/api-client";
import { formatDateRu, formatDateTimeRu } from "./date-format";

/** Use document facts only; never expose arbitrary internal field keys. */
export function documentRequisites(fields?: Record<string, unknown>): string {
  const first = (...names: string[]) => {
    for (const name of names) {
      const value = fields?.[name];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    }
    return "";
  };
  const series = first("series", "document_series", "doc_series");
  const number = first(
    "number",
    "document_number",
    "doc_number",
    "registration_number",
  );
  const date = formatDateRu(
    first("issueDate", "issuedAt", "issued_at", "issue_date"),
  );
  const issuer = first(
    "education_organization",
    "educationOrganization",
    "university",
    "institution",
    "issuedBy",
    "issued_by",
    "organization",
  );
  return [
    number
      ? `№ ${[series, number].filter(Boolean).join(" ")}`
      : series
        ? `Серия ${series}`
        : "",
    date !== "—" ? `от ${date}` : "",
    issuer,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function documentInstanceLabel(
  document: CandidateDocumentSummaryDto,
  index: number,
  version?: DocumentVersionDto,
): string {
  const fields = Object.fromEntries(
    (version?.fields ?? []).map((field) => [field.name, field.value]),
  );
  const requisites = documentRequisites(fields);
  const sent = formatDateTimeRu(
    version ? version.submittedAt : document.submittedAt,
  );
  return `Документ ${index + 1} · ${requisites || (sent !== "—" ? `отправлен ${sent}` : "дата отправки неизвестна")}`;
}

export function previousDocumentInstanceLabel(
  document: PreviousDocumentAvailabilityDto,
  index: number,
): string {
  const requisites = documentRequisites(document.fields);
  const recorded = formatDateRu(document.recordedAt);
  return `Документ ${index + 1} · ${requisites || (recorded !== "—" ? `запись от ${recorded}` : "дата записи неизвестна")}`;
}
