import { ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

/** Called inside the upload transaction. The state lock serializes grants and uploads. */
export async function igUploadOwner(
  tx: Prisma.TransactionClient,
  code1c: string,
  citizenship: string,
  locationId?: number,
) {
  await tx.igEmploymentState.upsert({
    where: { code1c },
    create: { code1c },
    update: {},
  });
  await tx.$queryRaw`SELECT code1c FROM ig_employment_states WHERE code1c = ${code1c} FOR UPDATE`;
  const state = await tx.igEmploymentState.findUniqueOrThrow({
    where: { code1c },
    include: { currentCandidate: true },
  });
  const owner =
    state.currentCandidate ??
    (await tx.candidate.create({
      data: {
        identityKey: `ig-upload:${randomUUID()}`,
        code1c,
        citizenship: citizenship.toLowerCase(),
        reviewGroup: "IG",
        locationId: locationId ?? null,
      },
    }));
  if (
    owner.code1c !== code1c ||
    owner.chatUuid ||
    owner.reviewGroup === "RU" ||
    owner.citizenship?.toLowerCase() === "ru"
  )
    throw new ConflictException("CANDIDATE_IDENTITY_CONFLICT");
  if (!state.currentCandidateId)
    await tx.igEmploymentState.update({
      where: { code1c },
      data: { currentCandidateId: owner.id },
    });
  return owner;
}
