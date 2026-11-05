import { createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { candidateIdentityTransaction } from "./candidate-identity";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import {
  arrivalStateHash,
  arrivalStateSchema,
  type PersonArrivalState,
} from "./ig-arrival-contract";

@Injectable()
export class IgArrivalProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly audit: AuditService,
  ) {}
  async apply(input: PersonArrivalState): Promise<boolean> {
    const item = arrivalStateSchema.parse(input);
    const hash = arrivalStateHash(item);
    const identity = await this.erp.identity(item.code1c).catch(() => null);
    const verified =
      !!identity &&
      identity.recipientType === "person" &&
      identity.reviewGroup === "IG" &&
      identity.personUid === item.personUid &&
      identity.code1C === item.code1c &&
      !identity.chatUuid &&
      !identity.erpUid;
    return candidateIdentityTransaction(this.prisma, async (tx) => {
      await tx.igEmploymentState.upsert({
        where: { code1c: item.code1c },
        create: { code1c: item.code1c },
        update: {},
      });
      await tx.$queryRaw`SELECT code1c FROM ig_employment_states WHERE code1c = ${item.code1c} FOR UPDATE`;
      const occupiedCode = await tx.igArrivalPerson.findUnique({
        where: { code1c: item.code1c },
      });
      if (occupiedCode && occupiedCode.personUid !== item.personUid)
        throw new ConflictException("ARRIVAL_PERSON_CODE_CONFLICT");
      await tx.igArrivalPerson.upsert({
        where: { personUid: item.personUid },
        create: {
          personUid: item.personUid,
          code1c: item.code1c,
          state: "NONE",
          sourceHash: "",
          sourcePayload: {},
        },
        update: {},
      });
      await tx.$queryRaw`SELECT personUid FROM ig_arrival_persons WHERE personUid = ${item.personUid} FOR UPDATE`;
      const existing = await tx.igArrivalPerson.findUniqueOrThrow({
        where: { personUid: item.personUid },
      });
      if (existing.code1c !== item.code1c)
        throw new ConflictException("ARRIVAL_PERSON_CODE_CONFLICT");
      const revision = BigInt(item.revision);
      if (revision < existing.revision) return false;
      if (revision === existing.revision && hash !== existing.sourceHash)
        throw new ConflictException("ARRIVAL_REVISION_CONFLICT");
      if (revision > existing.revision) {
        const ids = item.participations.map(
          (member) => member.arrivalMemberUid,
        );
        const foreign = await tx.igArrivalMember.findFirst({
          where: {
            arrivalMemberUid: { in: ids },
            personUid: { not: item.personUid },
          },
        });
        if (foreign)
          throw new ConflictException("ARRIVAL_MEMBER_OWNER_CONFLICT");
        for (const member of item.participations) {
          const data = {
            arrivalDate: member.arrivalDate,
            locationUid: member.locationUid,
            locationCode1c: member.locationCode1c,
            locationName: member.locationName,
            cancelled: member.cancelled,
            fullName: member.fullName ?? null,
            citizenship: member.citizenship?.toLowerCase() ?? null,
            managerCode1c: member.managerCode1c ?? null,
          };
          await tx.igArrivalMember.createMany({
            data: [
              {
                arrivalMemberUid: member.arrivalMemberUid,
                personUid: item.personUid,
                ...data,
              },
            ],
            skipDuplicates: true,
          });
          const changed = await tx.igArrivalMember.updateMany({
            where: {
              arrivalMemberUid: member.arrivalMemberUid,
              personUid: item.personUid,
            },
            data,
          });
          if (changed.count !== 1)
            throw new ConflictException("ARRIVAL_MEMBER_OWNER_CONFLICT");
        }
        await tx.igArrivalPerson.update({
          where: { personUid: item.personUid },
          data: {
            revision,
            state: item.state,
            currentMemberUid: item.currentArrivalMemberUid,
            sourceHash: hash,
            sourcePayload: item as Prisma.InputJsonValue,
            syncError: null,
            syncPending: true,
          },
        });
      }
      if (revision > existing.revision)
        await this.audit.logInTransaction(tx, {
          actorId: "system:arrival-sync",
          action: "DATA_IMPORTED",
          entityType: "IgArrivalPerson",
          entityId: createHash("sha256").update(item.personUid).digest("hex"),
          after: { revision: item.revision, state: item.state },
        });
      if (!verified) {
        if (identity && existing.candidateId)
          await this.audit.logInTransaction(tx, {
            actorId: "system:arrival-sync",
            action: "DATA_IMPORTED",
            entityType: "IgArrivalPerson",
            entityId: createHash("sha256").update(item.personUid).digest("hex"),
            after: { binding: "QUARANTINED", revision: item.revision },
          });
        await tx.igArrivalPerson.update({
          where: { personUid: item.personUid },
          data: {
            ...(identity ? { candidateId: null } : {}),
            bindingError: identity
              ? "ERP_PERSON_IDENTITY_MISMATCH"
              : "ERP_PERSON_IDENTITY_UNAVAILABLE",
          },
        });
        return true;
      }
      const state = await tx.igEmploymentState.findUniqueOrThrow({
        where: { code1c: item.code1c },
        include: { currentCandidate: true },
      });
      let candidate = state.currentCandidate;
      if (!candidate && item.state !== "CURRENT") {
        await tx.igArrivalPerson.update({
          where: { personUid: item.personUid },
          data: { candidateId: null, bindingError: null },
        });
        return true;
      }
      if (!candidate) {
        const possible = await tx.candidate.findMany({
          where: {
            OR: [{ code1c: item.code1c }, { personUid: item.personUid }],
          },
          take: 2,
        });
        if (possible.length > 1) {
          await tx.igArrivalPerson.update({
            where: { personUid: item.personUid },
            data: {
              candidateId: null,
              bindingError: "ARRIVAL_OWNER_AMBIGUOUS",
            },
          });
          return true;
        }
        candidate = possible[0] ?? null;
      }
      if (candidate) {
        await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${candidate.id} FOR UPDATE`;
        candidate = await tx.candidate.findUniqueOrThrow({
          where: { id: candidate.id },
        });
        if (
          candidate.code1c !== item.code1c ||
          candidate.chatUuid ||
          candidate.reviewGroup === "RU" ||
          candidate.citizenship?.toLowerCase() === "ru" ||
          (candidate.personUid && candidate.personUid !== item.personUid)
        ) {
          await tx.igArrivalPerson.update({
            where: { personUid: item.personUid },
            data: { candidateId: null, bindingError: "ARRIVAL_OWNER_CONFLICT" },
          });
          return true;
        }
        if (!candidate.personUid)
          candidate = await tx.candidate.update({
            where: { id: candidate.id },
            data: { personUid: item.personUid, reviewGroup: "IG" },
          });
      } else {
        const current = item.participations.find(
          (member) => member.arrivalMemberUid === item.currentArrivalMemberUid,
        );
        if (current?.citizenship?.toLowerCase() === "ru") {
          await tx.igArrivalPerson.update({
            where: { personUid: item.personUid },
            data: { candidateId: null, bindingError: "ARRIVAL_OWNER_CONFLICT" },
          });
          return true;
        }
        candidate = await tx.candidate.create({
          data: {
            identityKey: `ig-person:${item.personUid}`,
            personUid: item.personUid,
            code1c: item.code1c,
            reviewGroup: "IG",
            citizenship: current?.citizenship?.toLowerCase() ?? null,
            fullName: current?.fullName ?? null,
          },
        });
      }
      if (!state.currentCandidateId)
        await tx.igEmploymentState.update({
          where: { code1c: item.code1c },
          data: { currentCandidateId: candidate.id },
        });
      await tx.igArrivalPerson.update({
        where: { personUid: item.personUid },
        data: { candidateId: candidate.id, bindingError: null },
      });
      if (existing.candidateId !== candidate.id)
        await this.audit.logInTransaction(tx, {
          actorId: "system:arrival-sync",
          action: "DATA_IMPORTED",
          entityType: "IgArrivalPerson",
          entityId: createHash("sha256").update(item.personUid).digest("hex"),
          after: { binding: "LINKED", revision: item.revision },
        });
      return true;
    });
  }
}
