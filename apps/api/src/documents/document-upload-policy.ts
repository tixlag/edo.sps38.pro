import { ConflictException } from "@nestjs/common";
import type { Prisma, DocumentStatus } from "@prisma/client";

/** Call only while holding the owner's candidate row lock, after idempotent replay. */
export async function assertDocumentUploadAllowed(
  tx: Prisma.TransactionClient,
  document: { id: string; status: DocumentStatus },
): Promise<void> {
  if (["IN_REVIEW", "OCR_PENDING"].includes(document.status))
    throw new ConflictException("DOCUMENT_IN_REVIEW");
  if (
    await tx.documentSubmission.findFirst({
      where: { status: "UPLOADING", version: { documentId: document.id } },
      select: { id: true },
    })
  )
    throw new ConflictException("DOCUMENT_UPLOAD_IN_PROGRESS");
}
