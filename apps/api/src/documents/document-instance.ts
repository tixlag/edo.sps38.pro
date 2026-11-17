import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { MULTIPLE_DOCUMENT_UIDS } from "./document-catalog.service";

// Caller holds the candidate row lock, serializing singleton creation and version allocation.
export async function reserveDocumentInstance(
  tx: Prisma.TransactionClient,
  candidateId: string,
  typeId: string,
  input: { mode?: "new" | "replace" | "append"; documentId?: string },
  reviewGroup?: "RU" | "IG",
) {
  if (input.mode === "new" && input.documentId)
    throw new BadRequestException("NEW_DOCUMENT_CANNOT_HAVE_TARGET");
  const type = await tx.documentType.findUniqueOrThrow({
    where: { id: typeId },
  });
  const multiple =
    !!type.erpUid && MULTIPLE_DOCUMENT_UIDS.has(type.erpUid.toLowerCase());
  if (input.mode === "new" && !multiple)
    throw new BadRequestException("DOCUMENT_TYPE_SINGLETON");
  if (input.mode === "append" && !input.documentId)
    throw new BadRequestException("DOCUMENT_ID_REQUIRED");
  const existing = input.documentId
    ? await tx.document.findFirst({
        where: { id: input.documentId, candidateId, documentTypeId: typeId },
      })
    : input.mode === "new"
      ? null
      : await tx.document.findFirst({
          where: { candidateId, documentTypeId: typeId },
          orderBy: { createdAt: "asc" },
        });
  if (input.documentId && !existing)
    throw new BadRequestException("DOCUMENT_NOT_FOUND");
  if (multiple && input.mode !== "new" && !input.documentId && existing)
    throw new ConflictException("DOCUMENT_INSTANCE_MODE_REQUIRED");
  return (
    existing ??
    tx.document.create({
      data: {
        candidateId,
        documentTypeId: typeId,
        currentVersion: 0,
        ...(reviewGroup ? { reviewGroup } : {}),
      },
    })
  );
}
