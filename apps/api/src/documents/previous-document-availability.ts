import type { CandidatePreviousDocument } from "@prisma/client";
import type { PreviousDocumentAvailabilityDto } from "./dto/document.dto";
import {
  isPreviousDocumentExpired,
  needsNewIgDocument,
} from "./reemployment-document-policy";

type CatalogType = {
  code: string;
  title: string;
  erpUid: string | null;
  category: "required" | "additional";
};
type Previous = Pick<
  CandidatePreviousDocument,
  | "id"
  | "sourceId"
  | "documentUid"
  | "status"
  | "fields"
  | "expiresAt"
  | "originalAvailable"
  | "reviewedAt"
>;

/** A former document stays a former source; it is never a synthetic current upload. */
export function previousDocumentState(
  doc: Previous,
  isIg: boolean,
): PreviousDocumentAvailabilityDto["state"] {
  if (doc.expiresAt && isPreviousDocumentExpired(doc.expiresAt))
    return "EXPIRED";
  const invalid =
    doc.fields &&
    typeof doc.fields === "object" &&
    !Array.isArray(doc.fields) &&
    doc.fields.isInvalid === true;
  if (
    invalid ||
    (isIg && needsNewIgDocument(doc.documentUid)) ||
    ["REPLACE", "MISSING"].includes(doc.status)
  )
    return "REPLACE_REQUIRED";
  if (!doc.originalAvailable || doc.status === "ORIGINAL_UNAVAILABLE")
    return "ORIGINAL_UNAVAILABLE";
  return doc.status === "CONFIRMED" ? "REUSED" : "REQUIRES_REVIEW";
}

export function previousDocumentAvailability(
  types: CatalogType[],
  previous: Previous[],
  _current: { documentType: { erpUid: string | null } | null; status: string }[] = [],
  isIg: boolean = true,
): PreviousDocumentAvailabilityDto[] {
  return types.flatMap((type) => {
    const uid = type.erpUid?.toLowerCase();
    if (!uid) return [];
    const candidates = previous
      .filter((doc) => doc.documentUid?.toLowerCase() === uid)
      .sort(
        (a, b) =>
          Number(previousDocumentState(b, isIg) === "REUSED") -
            Number(previousDocumentState(a, isIg) === "REUSED") ||
          (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0) ||
          a.id.localeCompare(b.id),
      );
    const doc = candidates[0];
    if (!doc) return [];
    const fields =
      doc.fields && typeof doc.fields === "object" && !Array.isArray(doc.fields)
        ? (doc.fields as Record<string, unknown>)
        : {};
    const date = fields.recordDate;
    const recordedAt =
      typeof date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(date)) &&
      new Date(date).toISOString().slice(0, 10) === date
        ? date
        : null;
    const isEdo = Boolean(doc.sourceId?.startsWith("edo:"));
    const cleanFields = Object.fromEntries(
      Object.entries(fields).filter(
        ([k, v]) =>
          !/(?:uuid|uid|code_?1c|code1c|erp|^id$|^sourceId$)/i.test(k) &&
          (typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean"),
      ),
    );
    const versionMatch = doc.sourceId?.match(/^edo:[^:]+:(\d+)$/);
    const versionNumber = versionMatch ? Number(versionMatch[1]) : null;

    return [
      {
        id: doc.id,
        documentUid: type.erpUid!,
        documentTypeCode: type.code,
        title: type.title,
        category: type.category,
        state: previousDocumentState(doc, isIg),
        expiresAt: doc.expiresAt?.toISOString().slice(0, 10) ?? null,
        recordedAt,
        originalAvailable: doc.originalAvailable,
        source: isEdo ? ("EDO" as const) : ("ERP" as const),
        sourceDescription: isEdo
          ? "Из прошлого оформления в ЭДО"
          : "Из ERP",
        fields: cleanFields,
        version: versionNumber,
        reviewedAt: doc.reviewedAt?.toISOString() ?? null,
      },
    ];
  });
}
