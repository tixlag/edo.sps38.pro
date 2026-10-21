import { resolveOcrProfile } from "./ocr-profile";

export interface OcrRetryVersion {
  version: number;
  status: string;
  citizenship: string | null;
  reviewedAt: Date | null;
  cleanupPending: boolean;
  document: {
    currentVersion: number;
    documentType: { erpUid: string | null; code: string } | null;
  };
  job: {
    status: string;
    cleanupPending: boolean;
    errorCode: string | null;
  } | null;
  files: { deletedAt: Date | null }[];
}

export function canRetryDocumentOcr(
  version: OcrRetryVersion,
  enabled: boolean,
): boolean {
  return Boolean(
    enabled &&
    version.document.currentVersion === version.version &&
    ["IN_REVIEW", "OCR_FAILED"].includes(version.status) &&
    !version.reviewedAt &&
    !version.cleanupPending &&
    version.job &&
    ["FAILED", "REJECTED"].includes(version.job.status) &&
    !version.job.cleanupPending &&
    version.job.errorCode !== "UPLOAD_FAILED" &&
    version.files.length > 0 &&
    version.files.every((file) => !file.deletedAt) &&
    resolveOcrProfile({
      documentUid: version.document.documentType?.erpUid,
      documentTypeCode: version.document.documentType?.code ?? "",
      citizenship: version.citizenship,
    }),
  );
}
