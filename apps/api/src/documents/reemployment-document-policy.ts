import { MIGRATION_UID } from "../ocr/ocr-profile";

// ERP document identities are shared with the annotation catalog.
export const EMPLOYMENT_PATENT_UID = "e87d5a10-d248-11eb-80c7-002590854e7f";
const freshIgDocuments = new Set([MIGRATION_UID, EMPLOYMENT_PATENT_UID]);

export function needsNewIgDocument(documentUid: string | null): boolean {
  return (
    documentUid !== null && freshIgDocuments.has(documentUid.toLowerCase())
  );
}

/** Indefinite document types that never require an expiration date. */
export const INDEFINITE_DOCUMENT_UIDS = new Set([
  "f97a4962-8c32-11eb-ba8b-00259002db81", // SNILS
  "2452c57b-8c32-11eb-ba8b-00259002db81", // INN
  "5a339bce-4386-11ec-80c9-002590854e7f", // BANK_DETAILS
  "6d5f0835-8c54-11eb-ba8b-00259002db81", // MILITARY
]);

export function isIndefiniteDocumentType(
  documentUid: string | null,
  code?: string | null,
): boolean {
  if (
    code &&
    ["INN", "SNILS", "BANK_DETAILS", "MILITARY"].includes(code.toUpperCase())
  )
    return true;
  return (
    documentUid !== null &&
    INDEFINITE_DOCUMENT_UIDS.has(documentUid.toLowerCase())
  );
}

/** ERP expiry dates are calendar days; review queues use Irkutsk business dates. */
export function isPreviousDocumentExpired(
  expiresAt: Date,
  now = new Date(),
): boolean {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Irkutsk",
  }).format(now);
  return expiresAt.toISOString().slice(0, 10) < today;
}

export function isPreviousDocumentValid(
  doc: {
    documentUid: string | null;
    expiresAt?: Date | null;
    fields?: unknown;
    originalAvailable?: boolean;
    originalVerified?: boolean;
    sourceId?: string;
    knownValid?: boolean;
  },
  isIg = true,
): boolean {
  if (!doc.originalAvailable || !doc.originalVerified) return false;
  if (doc.documentUid && isIg && needsNewIgDocument(doc.documentUid))
    return false;
  const fields =
    doc.fields && typeof doc.fields === "object" && !Array.isArray(doc.fields)
      ? (doc.fields as Record<string, unknown>)
      : {};
  if (fields.isInvalid === true) return false;

  if (doc.expiresAt) {
    return !isPreviousDocumentExpired(doc.expiresAt);
  }

  // If expiry date is missing:
  // 1. Indefinite types (INN, SNILS, etc.) are always valid
  if (isIndefiniteDocumentType(doc.documentUid)) return true;
  // 2. Trusted EDO source is valid
  if (doc.sourceId?.startsWith("edo:")) return true;
  // 3. From ERP: only valid if explicitly verified as not invalid (knownValid / isInvalid === false)
  if (doc.knownValid === true || fields.isInvalid === false) return true;

  return false;
}

