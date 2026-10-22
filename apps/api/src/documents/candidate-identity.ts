import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/** Strong identifiers only. identityKey is immutable; submission namespaces are independent. */
export async function resolveCandidateIdentity(
  tx: Prisma.TransactionClient,
  identity: {
    erpUid?: string | null;
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
    if (identity.expectedId)
      throw new ConflictException("CANDIDATE_IDENTITY_CHANGED");
    return tx.candidate.create({
      data: {
        identityKey: identity.identityKey,
        erpUid: identity.erpUid ?? null,
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
    (identity.erpUid && owner.erpUid && owner.erpUid !== identity.erpUid) ||
    (identity.chatUuid &&
      owner.chatUuid &&
      owner.chatUuid !== identity.chatUuid)
  )
    throw new ConflictException("CANDIDATE_IDENTITY_CONFLICT");
  if (
    (identity.erpUid && !owner.erpUid) ||
    (identity.chatUuid && !owner.chatUuid)
  ) {
    return tx.candidate.update({
      where: { id: owner.id },
      data: {
        ...(identity.erpUid ? { erpUid: identity.erpUid } : {}),
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
