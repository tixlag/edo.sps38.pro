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
  const rows = await tx.candidate.findMany({
    where: { OR: refs },
    include: {
      _count: { select: { documents: true, previousDocuments: true } },
    },
  });
  if (rows.length > 1) {
    const ghost = rows.find(
      (r) =>
        r.erpUid &&
        !r.chatUuid &&
        r._count.documents === 0 &&
        r._count.previousDocuments === 0,
    );
    const real = rows.find(
      (r) =>
        r.id !== ghost?.id &&
        (r.chatUuid || ((r as any)._count?.documents ?? 0) > 0),
    );
    if (
      ghost &&
      real &&
      rows.length === 2 &&
      (!identity.expectedId || identity.expectedId === real.id) &&
      (!real.erpUid || real.erpUid === ghost.erpUid) &&
      (!real.reviewGroup ||
        !ghost.reviewGroup ||
        real.reviewGroup === ghost.reviewGroup) &&
      (!identity.reviewGroup ||
        !real.reviewGroup ||
        identity.reviewGroup === real.reviewGroup) &&
      (!identity.reviewGroup ||
        !ghost.reviewGroup ||
        identity.reviewGroup === ghost.reviewGroup) &&
      (!real.personUid ||
        !ghost.personUid ||
        real.personUid === ghost.personUid) &&
      (!identity.personUid ||
        !real.personUid ||
        identity.personUid === real.personUid) &&
      (!identity.personUid ||
        !ghost.personUid ||
        identity.personUid === ghost.personUid)
    ) {
      await tx.candidate.delete({ where: { id: ghost.id } });
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${real.id} FOR UPDATE`;
      return tx.candidate.update({
        where: { id: real.id },
        data: {
          erpUid: ghost.erpUid,
          ...(ghost.statusId && !real.statusId
            ? { statusId: ghost.statusId }
            : {}),
          ...(ghost.statusName && !real.statusName
            ? { statusName: ghost.statusName }
            : {}),
          ...(ghost.managerId && !real.managerId
            ? { managerId: ghost.managerId }
            : {}),
          ...(ghost.managerName && !real.managerName
            ? { managerName: ghost.managerName }
            : {}),
          ...(ghost.projectCode && !real.projectCode
            ? { projectCode: ghost.projectCode }
            : {}),
          ...(ghost.projectName && !real.projectName
            ? { projectName: ghost.projectName }
            : {}),
          ...(ghost.positionCode && !real.positionCode
            ? { positionCode: ghost.positionCode }
            : {}),
          ...(ghost.positionName && !real.positionName
            ? { positionName: ghost.positionName }
            : {}),
          reviewGroup:
            real.reviewGroup ??
            ghost.reviewGroup ??
            identity.reviewGroup ??
            "RU",
          ...(identity.chatUuid && !real.chatUuid
            ? { chatUuid: identity.chatUuid }
            : {}),
          ...(identity.code1c && !real.code1c
            ? { code1c: identity.code1c }
            : {}),
          ...(identity.personUid && !real.personUid
            ? { personUid: identity.personUid }
            : {}),
        },
      });
    }
    throw new ConflictException("CANDIDATE_IDENTITY_CONFLICT");
  }
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
    (identity.chatUuid && !owner.chatUuid) ||
    (identity.code1c && !owner.code1c)
  ) {
    return tx.candidate.update({
      where: { id: owner.id },
      data: {
        ...(identity.erpUid ? { erpUid: identity.erpUid } : {}),
        ...(identity.personUid ? { personUid: identity.personUid } : {}),
        ...(identity.reviewGroup ? { reviewGroup: identity.reviewGroup } : {}),
        ...(identity.chatUuid ? { chatUuid: identity.chatUuid } : {}),
        ...(identity.code1c ? { code1c: identity.code1c } : {}),
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
