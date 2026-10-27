import { resolveOcrProfile } from "./ocr-profile";

export interface OcrRetryVersion {
  version: number;
  status: string;
  citizenship: string | null;
  reviewedAt: Date | null;
  cleanupPending: boolean;
  ocrSource: string | null;
  submission: { id: string; status: string } | null;
  document: {
    currentVersion: number;
    candidateId: string | null;
    documentType: { erpUid: string | null; code: string } | null;
  };
  job: {
    status: string;
    cleanupPending: boolean;
    errorCode: string | null;
  } | null;
  files: { deletedAt: Date | null }[];
}

function canProcessDocumentOcr(
  version: OcrRetryVersion,
  enabled: boolean,
  checkDocuments = false,
): boolean {
  return Boolean(
    enabled &&
    version.document.currentVersion === version.version &&
    ["IN_REVIEW", "OCR_FAILED"].includes(version.status) &&
    !version.reviewedAt &&
    !version.cleanupPending &&
    version.files.length > 0 &&
    version.files.every((file) => !file.deletedAt) &&
    (checkDocuments ||
      resolveOcrProfile({
        documentUid: version.document.documentType?.erpUid,
        documentTypeCode: version.document.documentType?.code ?? "",
        citizenship: version.citizenship,
      })),
  );
}

export function canRetryDocumentOcr(
  version: OcrRetryVersion,
  enabled: boolean,
  checkDocuments = false,
): boolean {
  return Boolean(
    canProcessDocumentOcr(version, enabled, checkDocuments) &&
    version.job &&
    ["FAILED", "REJECTED"].includes(version.job.status) &&
    !version.job.cleanupPending &&
    version.job.errorCode !== "UPLOAD_FAILED",
  );
}

export function canStartDocumentOcr(
  version: OcrRetryVersion,
  enabled: boolean,
  checkDocuments = false,
): boolean {
  return Boolean(
    canProcessDocumentOcr(version, enabled, checkDocuments) &&
    version.status === "IN_REVIEW" &&
    version.job === null &&
    version.ocrSource === null &&
    version.document.candidateId &&
    version.submission?.status === "SUCCEEDED",
  );
}
