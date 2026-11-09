import { MIGRATION_UID } from "../ocr/ocr-profile";

// ERP document identities are shared with the annotation catalog.
export const EMPLOYMENT_PATENT_UID = "e87d5a10-d248-11eb-80c7-002590854e7f";
const freshIgDocuments = new Set([MIGRATION_UID, EMPLOYMENT_PATENT_UID]);

export function needsNewIgDocument(documentUid: string | null): boolean {
  return (
    documentUid !== null && freshIgDocuments.has(documentUid.toLowerCase())
  );
}

/** Document types that strictly expire and require an expiration date. */
export const EXPIRING_DOCUMENT_UIDS = new Set([
  MIGRATION_UID.toLowerCase(),
  EMPLOYMENT_PATENT_UID.toLowerCase(),
  "26b930ce-6462-11ec-80cc-002590854e7f", // REGISTRATION_NOTICE
  "f26b853d-0367-11ef-a9f6-0050560116fc", // FOREIGN_MEDICAL_EXAMINATION
  "9b9cf254-d69d-11ee-a9e4-0050560116fc", // RESIDENCE_PERMIT
  "deb3bcd3-8340-11eb-ba8b-00259002db81", // DRIVER_LICENSE
  "65517702-8341-11eb-ba8b-00259002db81", // TACHOGRAPH_CARD
  "5f2d9eef-8341-11eb-ba8b-00259002db81", // DOPOG
  "7d0a587a-8228-11eb-ba8b-00259002db81", // SAFE_WINTER_DRIVING_CERTIFICATE
]);

export function requiresExpirationDate(documentUid: string | null): boolean {
  return (
    documentUid !== null &&
    EXPIRING_DOCUMENT_UIDS.has(documentUid.toLowerCase())
  );
}

/** Indefinite document types that never require an expiration date. */
export const INDEFINITE_DOCUMENT_UIDS = new Set([
  "f97a4962-8c32-11eb-ba8b-00259002db81", // SNILS
  "2452c57b-8c32-11eb-ba8b-00259002db81", // INN
  "5a339bce-4386-11ec-80c9-002590854e7f", // BANK_DETAILS
  "6d5f0835-8c54-11eb-ba8b-00259002db81", // MILITARY
  "10fa3e03-751b-11ec-80cd-002590854e7f", // VOCATIONAL_DIPLOMA
  "a18522de-8341-11eb-ba8b-00259002db81", // HIGHER_EDUCATION_DIPLOMA
  "402ec3c2-3cf6-11f0-89f3-00505601221a", // RETRAINING_DIPLOMA
  "3f164241-8c5b-11eb-ba8b-00259002db81", // BIRTH_CERTIFICATE
  "70fc9853-8c81-11eb-ba8b-00259002db81", // MARRIAGE_CERTIFICATE
  "7725d068-8341-11eb-ba8b-00259002db81", // EMPLOYMENT_RECORD
  "bdf50265-5469-11ef-89df-00505601221a", // PROFESSION_CERTIFICATE
]);

export function isIndefiniteDocumentType(
  documentUid: string | null,
  code?: string | null,
): boolean {
  if (
    code &&
    [
      "INN",
      "SNILS",
      "BANK_DETAILS",
      "MILITARY",
      "MILITARY_ID",
      "VOCATIONAL_DIPLOMA",
      "HIGHER_EDUCATION_DIPLOMA",
      "RETRAINING_DIPLOMA",
      "DIPLOMA",
      "EDUCATION",
      "BIRTH_CERTIFICATE",
      "MARRIAGE_CERTIFICATE",
      "EMPLOYMENT_RECORD",
      "PROFESSION_CERTIFICATE",
    ].includes(code.toUpperCase())
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
    previouslyConfirmed?: boolean;
  },
  isIg = true,
): boolean {
  if (!doc.originalAvailable) return false;
  if (isIg && !doc.originalVerified) return false;
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

  // A previously confirmed and verified original remains usable without an expiry date.
  if (isIg && doc.previouslyConfirmed === true) return true;

  // If expiry date is missing:
  // 1. Documents that strictly require an expiration date cannot be assumed indefinite
  if (isIg && requiresExpirationDate(doc.documentUid)) {
    return false;
  }

  // 2. Indefinite types (INN, SNILS, diploma, etc.) are always valid
  if (isIndefiniteDocumentType(doc.documentUid)) return true;
  // 3. Non-IG documents (e.g. internal Russian passport) have no expiration date in 1C
  if (!isIg) return true;

  // 4. Ordinary historical documents without an explicit expiration requirement
  if (
    doc.knownValid === true ||
    fields.isInvalid === false ||
    fields.isInvalid === null
  )
    return true;

  return false;
}
