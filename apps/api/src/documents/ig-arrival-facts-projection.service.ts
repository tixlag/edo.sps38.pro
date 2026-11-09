import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { candidateIdentityTransaction } from "./candidate-identity";
import { arrivalStateSchema } from "./ig-arrival-contract";
import {
  arrivalFactsPersonSchema,
  type ArrivalFactsPerson,
} from "./ig-arrival-facts-contract";

export type ArrivalFactsLease = {
  lockToken: string;
  generation: bigint;
  scanGeneration?: bigint;
};
type FactIssue = { code: string; sourceKey?: string | null };

@Injectable()
export class IgArrivalFactsProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly erp: ErpWorkspaceClient,
  ) {}

  async apply(
    raw: ArrivalFactsPerson,
    lease: ArrivalFactsLease,
    issues: FactIssue[],
  ): Promise<void> {
    const item = arrivalFactsPersonSchema.parse(raw);
    const canonicalCode =
      item.code1c && /^\S{1,64}$/.test(item.code1c) ? item.code1c : null;
    const canonical = {
      ...item,
      participations: [...item.participations].sort((a, b) =>
        a.sourceKey.localeCompare(b.sourceKey),
      ),
    };
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          canonical,
          issues: issues
            .map((issue) => [issue.code, issue.sourceKey ?? null])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        }),
      )
      .digest("hex");
    let verified = false;
    if (canonicalCode) {
      try {
        const identity = await this.erp.identity(canonicalCode);
        verified =
          identity.recipientType === "person" &&
          identity.reviewGroup === "IG" &&
          identity.personUid === item.personUid &&
          identity.code1C === canonicalCode &&
          !identity.chatUuid &&
          !identity.erpUid;
      } catch {
        verified = false;
      }
    }
    await candidateIdentityTransaction(this.prisma, async (tx) => {
      const locks = await tx.$queryRaw<
        {
          lockToken: string | null;
          generation: bigint;
          lockExpiresAt: Date | null;
        }[]
      >`SELECT lockToken,generation,lockExpiresAt FROM ig_arrival_sync_state WHERE id='singleton' FOR UPDATE`;
      const lock = locks[0];
      if (
        !lock ||
        lock.lockToken !== lease.lockToken ||
        lock.generation !== lease.generation ||
        !lock.lockExpiresAt ||
        lock.lockExpiresAt <= new Date()
      )
        throw new Error("ARRIVAL_SYNC_FENCING_CONFLICT");
      let person = await tx.igArrivalPerson.findUnique({
        where: { personUid: item.personUid },
      });
      if (!person)
        person = await tx.igArrivalPerson.create({
          data: {
            personUid: item.personUid,
            code1c: canonicalCode,
            rawSourceCode1c: item.code1c,
            state: "NONE",
            sourceHash: "",
            sourcePayload: {},
            bindingError: "ERP_PERSON_IDENTITY_UNAVAILABLE",
            igVerified: false,
            syncPending: false,
          },
        });
      let revision =
        person.sourceHash === hash ? person.revision : person.revision + 1n;
      let factIdentityChanged = false;
      for (const fact of item.participations) {
        let row = await tx.igArrivalMember.findUnique({
          where: { sourceKey: fact.sourceKey },
        });
        const duplicate = issues.some(
          (issue) =>
            issue.code === "DUPLICATE_ARRIVAL_MEMBER_UID" &&
            issue.sourceKey === fact.sourceKey,
        );
        if (duplicate && fact.arrivalMemberUid) {
          const quarantined = await tx.igArrivalMember.updateMany({
            where: {
              OR: [
                { sourceMemberUid: fact.arrivalMemberUid },
                { arrivalMemberUid: fact.arrivalMemberUid },
              ],
              AND: [
                {
                  OR: [
                    { sourceKey: null },
                    { sourceKey: { not: fact.sourceKey } },
                  ],
                },
                { factsIdentityIssue: null },
              ],
            },
            data: { factsIdentityIssue: "DUPLICATE_ARRIVAL_MEMBER_UID" },
          });
          if (quarantined.count)
            await this.audit.logInTransaction(tx, {
              actorId: "system:arrival-sync",
              action: "DATA_IMPORTED",
              entityType: "IgArrivalSync",
              entityId: "facts",
              after: {
                quarantine: "DUPLICATE_ARRIVAL_MEMBER_UID",
                count: quarantined.count,
              },
            });
        }
        let identityIssue: string | null = duplicate
          ? "DUPLICATE_ARRIVAL_MEMBER_UID"
          : fact.arrivalMemberUid
            ? null
            : "ARRIVAL_IDENTITY_UNVERIFIED";
        if (!row) {
          const existing = fact.arrivalMemberUid
            ? await tx.igArrivalMember.findUnique({
                where: { arrivalMemberUid: fact.arrivalMemberUid },
              })
            : null;
          const canReuse =
            !duplicate &&
            !!fact.arrivalMemberUid &&
            (!existing ||
              (existing.personUid === item.personUid &&
                (existing.sourceKey === null ||
                  existing.sourceMemberUid === fact.arrivalMemberUid) &&
                !existing.factsIdentityIssue));
          if (existing && !canReuse)
            identityIssue = "ARRIVAL_MEMBER_OWNER_CONFLICT";
          if (canReuse && existing) {
            row = await tx.igArrivalMember.update({
              where: { arrivalMemberUid: existing.arrivalMemberUid },
              data: { sourceKey: fact.sourceKey },
            });
          } else {
            row = await tx.igArrivalMember.create({
              data: {
                arrivalMemberUid: canReuse
                  ? fact.arrivalMemberUid!
                  : randomUUID(),
                personUid: item.personUid,
                sourceKey: fact.sourceKey,
                cancelled: fact.cancelled,
              },
            });
          }
        } else if (
          row.personUid !== item.personUid ||
          row.sourceMemberUid !== fact.arrivalMemberUid
        ) {
          identityIssue = "ARRIVAL_IDENTITY_CONFLICT";
        }
        if (
          !duplicate &&
          fact.arrivalMemberUid &&
          row.arrivalMemberUid !== fact.arrivalMemberUid
        )
          identityIssue = "ARRIVAL_IDENTITY_CONFLICT";
        if (row.factsIdentityIssue === "ARRIVAL_IDENTITY_CONFLICT")
          identityIssue = row.factsIdentityIssue;
        if (row.factsIdentityIssue !== identityIssue)
          factIdentityChanged = true;
        await tx.igArrivalMember.update({
          where: { arrivalMemberUid: row.arrivalMemberUid },
          data: {
            sourceMemberUid: fact.arrivalMemberUid,
            factsSeenGeneration: lease.scanGeneration ?? lease.generation,
            factsMissingPasses: 0,
            factsArchived: false,
            factsIdentityIssue: identityIssue,
            latestSiteStatusCancelled: fact.latestSiteStatusCancelled,
            arrivalDate: fact.arrivalDate,
            arrivalDateTime: fact.arrivalDateTime,
            locationUid: fact.locationUid,
            locationCode1c: fact.locationCode1c,
            locationName: fact.locationName,
            fullName: fact.fullName,
            managerCode1c: fact.managerCode1c,
            cancelled: fact.cancelled,
            lastSeenRevision: revision,
          },
        });
      }
      const active = await tx.igArrivalMember.findMany({
        where: {
          personUid: item.personUid,
          cancelled: false,
          factsArchived: false,
        },
      });
      const state =
        active.length === 0
          ? "NONE"
          : active.length === 1
            ? "CURRENT"
            : "CONFLICT";
      const current = state === "CURRENT" ? active[0] : null;
      if (issues.length === 0)
        await tx.igArrivalIssue.updateMany({
          where: {
            personHash: createHash("sha256")
              .update(item.personUid)
              .digest("hex"),
            active: true,
            code: {
              in: [
                "ARRIVAL_STATE_INVALID",
                "ARRIVAL_PROJECTION_CONFLICT",
                "ARRIVAL_SOURCE_ISSUE_INVALID",
              ],
            },
          },
          data: { active: false },
        });
      let bindingError: string | null = verified
        ? null
        : "ERP_PERSON_IDENTITY_UNAVAILABLE";
      let candidateId = person.candidateId;
      const duplicatedCode = canonicalCode
        ? await tx.igArrivalPerson.findFirst({
            where: {
              code1c: canonicalCode,
              personUid: { not: item.personUid },
            },
          })
        : null;
      if (duplicatedCode) bindingError = "ARRIVAL_PERSON_CODE_CONFLICT";
      const eligible =
        verified &&
        !duplicatedCode &&
        state === "CURRENT" &&
        current &&
        current.sourceKey &&
        item.participations.some(
          (fact) => fact.sourceKey === current.sourceKey,
        ) &&
        current.sourceMemberUid === current.arrivalMemberUid &&
        !current.factsIdentityIssue;
      if (eligible && canonicalCode) {
        const possible = await tx.candidate.findMany({
          where: {
            OR: [{ code1c: canonicalCode }, { personUid: item.personUid }],
          },
          take: 2,
        });
        if (possible.length > 1) bindingError = "ARRIVAL_OWNER_AMBIGUOUS";
        else {
          let candidate = possible[0];
          if (
            candidate &&
            (candidate.code1c !== canonicalCode ||
              candidate.chatUuid ||
              candidate.erpUid ||
              candidate.reviewGroup === "RU" ||
              candidate.citizenship?.toLowerCase() === "ru" ||
              (candidate.personUid && candidate.personUid !== item.personUid))
          )
            bindingError = "ARRIVAL_OWNER_CONFLICT";
          else {
            if (!candidate)
              candidate = await tx.candidate.create({
                data: {
                  identityKey: `ig-person:${item.personUid}`,
                  personUid: item.personUid,
                  code1c: canonicalCode,
                  reviewGroup: "IG",
                  fullName: current.fullName,
                },
              });
            else if (!candidate.personUid || !candidate.reviewGroup)
              candidate = await tx.candidate.update({
                where: { id: candidate.id },
                data: { personUid: item.personUid, reviewGroup: "IG" },
              });
            const assigned = await tx.igArrivalPerson.findFirst({
              where: {
                candidateId: candidate.id,
                personUid: { not: item.personUid },
              },
            });
            if (assigned || (candidateId && candidateId !== candidate.id))
              bindingError = "ARRIVAL_OWNER_CONFLICT";
            else {
              candidateId = candidate.id;
              await tx.igEmploymentState.upsert({
                where: { code1c: canonicalCode },
                create: {
                  code1c: canonicalCode,
                  currentCandidateId: candidate.id,
                },
                update: {},
              });
            }
          }
        }
      }
      const rows = await tx.igArrivalMember.findMany({
        where: {
          sourceKey: { in: item.participations.map((fact) => fact.sourceKey) },
        },
      });
      const contextState =
        active.length === 0
          ? "NONE"
          : eligible && !bindingError && candidateId
            ? "CURRENT"
            : "CONFLICT";
      const payload = canonicalCode
        ? {
            personUid: item.personUid,
            code1c: canonicalCode,
            revision: Number(revision),
            state: contextState,
            currentArrivalMemberUid:
              contextState === "CURRENT" ? current!.arrivalMemberUid : null,
            participations: (rows.length <= 500
              ? rows
              : contextState === "CURRENT"
                ? [current!]
                : []
            ).map((row) => ({
              arrivalMemberUid: row.arrivalMemberUid,
              arrivalDate: row.arrivalDate,
              arrivalDateTime: row.arrivalDateTime,
              locationUid: row.locationUid,
              locationCode1c: row.locationCode1c,
              locationName: row.locationName,
              cancelled: row.cancelled,
              fullName: row.fullName,
              managerCode1c: row.managerCode1c,
            })),
          }
        : {};
      if (
        revision === person.revision &&
        (factIdentityChanged ||
          verified !== person.igVerified ||
          bindingError !== person.bindingError ||
          candidateId !== person.candidateId ||
          (canonicalCode &&
            person.sourcePayload &&
            typeof person.sourcePayload === "object" &&
            !Array.isArray(person.sourcePayload) &&
            ((person.sourcePayload as Record<string, unknown>).state !==
              contextState ||
              (person.sourcePayload as Record<string, unknown>)
                .currentArrivalMemberUid !== payload.currentArrivalMemberUid)))
      ) {
        revision += 1n;
        if ("revision" in payload) payload.revision = Number(revision);
        await tx.igArrivalMember.updateMany({
          where: {
            personUid: item.personUid,
            factsSeenGeneration: lease.scanGeneration ?? lease.generation,
          },
          data: { lastSeenRevision: revision },
        });
      }
      if (revision > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("ARRIVAL_REVISION_OVERFLOW");
      await tx.igArrivalPerson.update({
        where: { personUid: item.personUid },
        data: {
          code1c: canonicalCode,
          rawSourceCode1c: item.code1c,
          factsSeenGeneration: lease.scanGeneration ?? lease.generation,
          factsMissingPasses: 0,
          revision,
          state,
          currentMemberUid: current?.arrivalMemberUid ?? null,
          sourceHash: hash,
          sourcePayload: payload as Prisma.InputJsonValue,
          syncPending:
            verified &&
            !!canonicalCode &&
            !bindingError &&
            (revision !== person.revision ||
              !person.igVerified ||
              person.syncPending),
          igVerified: verified,
          bindingError,
          candidateId,
        },
      });
      if (
        revision !== person.revision ||
        verified !== person.igVerified ||
        bindingError !== person.bindingError ||
        candidateId !== person.candidateId
      )
        await this.audit.logInTransaction(tx, {
          actorId: "system:arrival-sync",
          action: "DATA_IMPORTED",
          entityType: "IgArrivalPerson",
          entityId: createHash("sha256").update(item.personUid).digest("hex"),
          after: {
            revision: String(revision),
            state,
            identityVerified: verified,
            binding: bindingError ?? (candidateId ? "LINKED" : "UNLINKED"),
          },
        });
    });
  }
  async recordIssue(
    personUid: string | null,
    code: string,
    lease: ArrivalFactsLease,
  ): Promise<void> {
    const personHash = createHash("sha256")
      .update(personUid ?? "unknown")
      .digest("hex");
    const id = createHash("sha256")
      .update(`${personHash}:${code}`)
      .digest("hex");
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          lockToken: string | null;
          generation: bigint;
          lockExpiresAt: Date | null;
        }[]
      >`SELECT lockToken,generation,lockExpiresAt FROM ig_arrival_sync_state WHERE id='singleton' FOR UPDATE`;
      const lock = rows[0];
      if (
        !lock ||
        lock.lockToken !== lease.lockToken ||
        lock.generation !== lease.generation ||
        !lock.lockExpiresAt ||
        lock.lockExpiresAt <= new Date()
      )
        throw new Error("ARRIVAL_SYNC_FENCING_CONFLICT");
      const existing = await tx.igArrivalIssue.findUnique({ where: { id } });
      await tx.igArrivalIssue.upsert({
        where: { id },
        create: { id, personHash, code },
        update: { active: true },
      });
      if (!existing || !existing.active)
        await this.audit.logInTransaction(tx, {
          actorId: "system:arrival-sync",
          action: "DATA_IMPORTED",
          entityType: "IgArrivalSourceIssue",
          entityId: id,
          after: { codes: [code] },
        });
    });
  }
  async finish(lease: ArrivalFactsLease): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locks = await tx.$queryRaw<
        {
          lockToken: string | null;
          generation: bigint;
          lockExpiresAt: Date | null;
          factsFinishedGeneration: bigint | null;
        }[]
      >`SELECT lockToken,generation,lockExpiresAt,factsFinishedGeneration FROM ig_arrival_sync_state WHERE id='singleton' FOR UPDATE`;
      const lock = locks[0];
      if (
        !lock ||
        lock.lockToken !== lease.lockToken ||
        lock.generation !== lease.generation ||
        !lock.lockExpiresAt ||
        lock.lockExpiresAt <= new Date()
      )
        throw new Error("ARRIVAL_SYNC_FENCING_CONFLICT");
      if (
        lock.factsFinishedGeneration ===
        (lease.scanGeneration ?? lease.generation)
      )
        return;
      const affected = await tx.igArrivalPerson.findMany({
        where: {
          members: {
            some: {
              factsArchived: false,
              factsMissingPasses: { gte: 1 },
              OR: [
                { factsSeenGeneration: null },
                {
                  factsSeenGeneration: {
                    not: lease.scanGeneration ?? lease.generation,
                  },
                },
              ],
            },
          },
        },
      });
      const archived =
        await tx.$executeRaw`UPDATE ig_arrival_members SET factsArchived = CASE WHEN factsMissingPasses >= 1 THEN TRUE ELSE factsArchived END, factsMissingPasses = factsMissingPasses + 1 WHERE factsArchived=0 AND (factsSeenGeneration IS NULL OR factsSeenGeneration <> ${lease.scanGeneration ?? lease.generation})`;
      for (const person of affected) {
        const active = await tx.igArrivalMember.findMany({
          where: {
            personUid: person.personUid,
            factsArchived: false,
            cancelled: false,
          },
        });
        const state =
          active.length === 0
            ? "NONE"
            : active.length === 1
              ? "CURRENT"
              : "CONFLICT";
        const current = state === "CURRENT" ? active[0] : null;
        const previous = arrivalStateSchema.safeParse(person.sourcePayload);
        const trusted =
          current &&
          current.sourceMemberUid === current.arrivalMemberUid &&
          !current.factsIdentityIssue &&
          person.igVerified &&
          !person.bindingError &&
          person.candidateId;
        const hasCurrent =
          previous.success &&
          current &&
          previous.data.participations.some(
            (member) =>
              member.arrivalMemberUid === current.arrivalMemberUid &&
              !member.cancelled,
          );
        const contextState =
          active.length === 0
            ? "NONE"
            : trusted && hasCurrent
              ? "CURRENT"
              : "CONFLICT";
        const contextUid =
          contextState === "CURRENT" ? current!.arrivalMemberUid : null;
        const changed =
          previous.success &&
          (previous.data.state !== contextState ||
            previous.data.currentArrivalMemberUid !== contextUid);
        const revision = changed ? person.revision + 1n : person.revision;
        if (revision > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("ARRIVAL_REVISION_OVERFLOW");
        const payload =
          previous.success && changed
            ? {
                ...previous.data,
                revision: Number(revision),
                state: contextState,
                currentArrivalMemberUid: contextUid,
              }
            : person.sourcePayload;
        await tx.igArrivalPerson.update({
          where: { personUid: person.personUid },
          data: {
            state,
            currentMemberUid: current?.arrivalMemberUid ?? null,
            revision,
            sourcePayload: payload as Prisma.InputJsonValue,
            syncPending:
              changed && person.igVerified && !person.bindingError
                ? true
                : person.syncPending,
          },
        });
      }
      if (archived)
        await this.audit.logInTransaction(tx, {
          actorId: "system:arrival-sync",
          action: "DATA_IMPORTED",
          entityType: "IgArrivalSync",
          entityId: "facts",
          after: { generation: String(lease.generation), updated: archived },
        });
      await tx.igArrivalSyncState.update({
        where: { id: "singleton" },
        data: {
          factsFinishedGeneration: lease.scanGeneration ?? lease.generation,
          factsScanGeneration: null,
          factsScanIncomplete: false,
          completedAt: new Date(),
          cursor: null,
        },
      });
    });
  }
}
