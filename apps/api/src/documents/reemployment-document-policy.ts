import { MIGRATION_UID } from "../ocr/ocr-profile";

// ERP document identities are shared with the annotation catalog.
export const EMPLOYMENT_PATENT_UID = "e87d5a10-d248-11eb-80c7-002590854e7f";
const freshIgDocuments = new Set([MIGRATION_UID, EMPLOYMENT_PATENT_UID]);

export function needsNewIgDocument(documentUid: string | null): boolean {
  return (
    documentUid !== null && freshIgDocuments.has(documentUid.toLowerCase())
  );
}
