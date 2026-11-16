import { createHash } from "node:crypto";

/** Stable UUID for ERP; EDO Document.id is a CUID and must never be sent as a 1C UUID. */
export function erpDocumentInstanceUid(documentId: string): string {
  const hex = createHash("sha256").update(`edo-document-instance:${documentId}`).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
