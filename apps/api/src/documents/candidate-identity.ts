import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/** Strong identifiers only. identityKey is immutable; submission namespaces are independent. */
export async function resolveCandidateIdentity(
  tx: Prisma.TransactionClient,
  identity: {
    erpUid?: string | null;
    personUid?: string | null;
    code1c?: string | null;
    reviewGroup?: "RU" | "IG";
    chatUuid?: string | null;
    identityKey: string;
    expectedId?: string;
  },
) {
  const refs = [
    { identityKey: identity.identityKey },
    ...(identity.erpUid ? [{ erpUid: identity.erpUid }] : []),
    ...(identity.chatUuid ? [{ chatUuid: identity.chatUuid }] : []),
    ...(identity.expectedId ? [{ id: identity.expectedId }] : []),
  ];
  const rows = await tx.candidate.findMany({ where: { OR: refs } });
  if (rows.length > 1)
    throw new ConflictException("CANDIDATE_IDENTITY_CONFLICT");
  if (!rows.length) {
    // A legacy employee namespace does not prove an admission cycle. Refuse a
    // second card until that unresolved history is reconciled explicitly.
    if (
      identity.code1c &&
      (await tx.candidate.findFirst({
        where: {
          code1c: identity.code1c,
          erpUid: null,
          OR: [
            { identityKey: `employee:${identity.code1c}` },
            { reviewGroup: null },
          ],
        },
      }))
    )
      throw new ConflictException(
        "LEGACY_CANDIDATE_IDENTITY_REQUIRES_RECONCILIATION",
      );
    if (identity.expectedId)
      throw new ConflictException("CANDIDATE_IDENTITY_CHANGED");
    return tx.candidate.create({
      data: {
        identityKey: identity.identityKey,
        erpUid: identity.erpUid ?? null,
        personUid: identity.personUid ?? null,
        reviewGroup: identity.reviewGroup ?? null,
        chatUuid: identity.chatUuid ?? null,
      },
    });
  }
  await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${rows[0].id} FOR UPDATE`;
  const owner = await tx.candidate.findUniqueOrThrow({
    where: { id: rows[0].id },
  });
  if (
    (identity.expectedId && owner.id !== identity.expectedId) ||
    (identity.reviewGroup &&
      owner.reviewGroup &&
      owner.reviewGroup !== identity.reviewGroup) ||
    (identity.personUid &&
      owner.personUid &&
      owner.personUid !== identity.personUid) ||
    (identity.erpUid && owner.erpUid && owner.erpUid !== identity.erpUid) ||
    (identity.chatUuid &&
      owner.chatUuid &&
      owner.chatUuid !== identity.chatUuid)
  )
    throw new ConflictException("CANDIDATE_IDENTITY_CONFLICT");
  if (
    (identity.personUid && !owner.personUid) ||
    (identity.reviewGroup && !owner.reviewGroup) ||
    (identity.erpUid && !owner.erpUid) ||
    (identity.chatUuid && !owner.chatUuid)
  ) {
    return tx.candidate.update({
      where: { id: owner.id },
      data: {
        ...(identity.erpUid ? { erpUid: identity.erpUid } : {}),
        ...(identity.personUid ? { personUid: identity.personUid } : {}),
        ...(identity.reviewGroup ? { reviewGroup: identity.reviewGroup } : {}),
        ...(identity.chatUuid ? { chatUuid: identity.chatUuid } : {}),
      },
    });
  }
  return owner;
}

/** Unique constraints serialize first creation; losers re-resolve the committed owner. */
export async function candidateIdentityTransaction<T>(
  prisma: PrismaService,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(action, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (error) {
      if (
        attempt < 2 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)
      )
        continue;
      throw error;
    }
  }
}
