import { ConflictException, Injectable } from "@nestjs/common";
import type { Candidate, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { ErpCandidate } from "../communications/communication-contract";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "./candidate-identity";

/** Applies ERP snapshots without calling ERP. Identity conflicts propagate to callers. */
@Injectable()
export class CandidateCatalogProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async applyRows(
    rows: ErpCandidate[],
    correlationId: string,
    options?: {
      beforeRow?: () => Promise<void>;
      beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
      onConflict?: (row: ErpCandidate) => void;
    },
  ) {
    const outcomes: {
      erpUid: string;
      candidateId: string;
      pendingObservation: boolean;
    }[] = [];
    if (!rows.length) return outcomes;
    const identityKeys = rows.map((row) =>
      row.chatUuid ? `chat:${row.chatUuid}` : `erp-candidate:${row.erpUid}`,
    );
    const candidates = await this.prisma.candidate.findMany({
      where: {
        OR: [
          { erpUid: { in: rows.map((row) => row.erpUid) } },
          {
            chatUuid: {
              in: rows.flatMap((row) => (row.chatUuid ? [row.chatUuid] : [])),
            },
          },
          { identityKey: { in: identityKeys } },
        ],
      },
    });
    const locations = await this.prisma.lkLocation.findMany({
      where: {
        code1c: {
          in: rows.flatMap((row) => (row.projectCode ? [row.projectCode] : [])),
        },
      },
    });
    const locationByCode = new Map(
      locations.map((location) => [location.code1c, location]),
    );
    for (const row of rows) {
      await options?.beforeRow?.();
      const identityKey = row.chatUuid
        ? `chat:${row.chatUuid}`
        : `erp-candidate:${row.erpUid}`;
      const matches = candidates.filter(
        (candidate) =>
          candidate.erpUid === row.erpUid ||
          candidate.identityKey === identityKey ||
          (row.chatUuid && candidate.chatUuid === row.chatUuid),
      );
      const prefetchedLocation = row.projectCode
        ? locationByCode.get(row.projectCode)
        : undefined;
      const existing = matches.length === 1 ? matches[0] : undefined;
      const equalDate =
        row.birthDate === undefined ||
        (row.birthDate === null
          ? existing?.birthDate == null
          : existing?.birthDate?.toISOString().slice(0, 10) === row.birthDate);
      // Only a fully resolved identity can skip the locked resolver. Ambiguous or
      // incomplete matches always go through its conflict and merge rules.
      const uniquelyReferenced =
        existing &&
        rows.filter(
          (other) =>
            other.erpUid === existing.erpUid ||
            (other.chatUuid && other.chatUuid === existing.chatUuid) ||
            (other.chatUuid
              ? `chat:${other.chatUuid}`
              : `erp-candidate:${other.erpUid}`) === existing.identityKey,
        ).length === 1;
      const sameIdentity = (candidate: Candidate | null | undefined) =>
        candidate?.erpUid === row.erpUid && candidate.reviewGroup === "RU" &&
        (!row.chatUuid || candidate.chatUuid === row.chatUuid);
      if (
        uniquelyReferenced &&
        existing &&
        sameIdentity(existing) &&
        existing.catalogSyncedAt &&
        existing.erpDeleted === row.deleted &&
        existing.employed === (row.employed ?? null) &&
        existing.fullName === (row.fullName || null) &&
        existing.projectCode === row.projectCode &&
        existing.projectName === row.projectName &&
        existing.positionCode === row.positionCode &&
        existing.positionName === row.positionName &&
        existing.locationId ===
          (prefetchedLocation?.deleted === false
            ? prefetchedLocation.locationId
            : null) &&
        (row.statusId === undefined || existing.statusId === row.statusId) &&
        (row.statusName === undefined ||
          existing.statusName === row.statusName) &&
        (row.managerId === undefined || existing.managerId === row.managerId) &&
        (row.managerName === undefined ||
          existing.managerName === row.managerName) &&
        equalDate &&
        (row.citizenship === undefined ||
          existing.citizenship === row.citizenship) &&
        (row.sex === undefined ||
          (existing.sex === row.sex &&
            existing.sexKnown === (row.sex !== null))) &&
        (row.mentorName === undefined || existing.mentorName === row.mentorName)
      ) {
        outcomes.push({
          erpUid: row.erpUid,
          candidateId: existing.id,
          pendingObservation:
            existing.employed === true && existing.employmentObservationPending,
        });
        continue;
      }
      try {
        const outcome = await candidateIdentityTransaction(
          this.prisma,
          async (tx) => {
            await options?.beforeWrite?.(tx);
            let locked: Candidate | null = null;
            if (uniquelyReferenced && existing?.identityKey === identityKey && sameIdentity(existing)) {
              await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${existing.id} FOR UPDATE`;
              locked = await tx.candidate.findUniqueOrThrow({ where: { id: existing.id } });
            }
            const current = locked?.identityKey === identityKey && sameIdentity(locked)
              ? locked
              : await resolveCandidateIdentity(tx, {
                  erpUid: row.erpUid,
                  reviewGroup: "RU",
                  chatUuid: row.chatUuid,
                  identityKey,
                });
            const location = row.projectCode
              ? await tx.lkLocation.findUnique({
                  where: { code1c: row.projectCode },
                })
              : null;
            const data = {
              erpUid: row.erpUid,
              erpDeleted: row.deleted,
              employed: row.employed ?? null,
              employmentObservationPending:
                row.employed === true
                  ? current.employed !== true ||
                    current.employmentObservationPending
                  : row.employed === false
                    ? false
                    : current.employmentObservationPending,
              ...(row.statusId !== undefined ? { statusId: row.statusId } : {}),
              ...(row.statusName !== undefined
                ? { statusName: row.statusName }
                : {}),
              ...(row.managerId !== undefined
                ? { managerId: row.managerId }
                : {}),
              ...(row.managerName !== undefined
                ? { managerName: row.managerName }
                : {}),
              ...(row.birthDate !== undefined
                ? {
                    birthDate:
                      row.birthDate === null
                        ? null
                        : new Date(`${row.birthDate}T00:00:00.000Z`),
                  }
                : {}),
              ...(row.citizenship !== undefined
                ? { citizenship: row.citizenship }
                : {}),
              ...(row.sex !== undefined
                ? { sex: row.sex, sexKnown: row.sex !== null }
                : {}),
              ...(row.mentorName !== undefined
                ? { mentorName: row.mentorName }
                : {}),
              reviewGroup: "RU" as const,
              chatUuid: row.chatUuid ?? current.chatUuid ?? null,
              fullName: row.fullName || null,
              projectCode: row.projectCode,
              projectName: row.projectName,
              positionCode: row.positionCode,
              positionName: row.positionName,
              locationId:
                location?.deleted === false ? location.locationId : null,
            };
            const changed =
              !current.catalogSyncedAt ||
              Object.entries(data).some(([field, value]) => {
                const old = current[field as keyof Candidate];
                return value instanceof Date && old instanceof Date
                  ? value.getTime() !== old.getTime()
                  : old !== value;
              });
            if (changed) {
              await tx.candidate.update({
                where: { id: current.id },
                data: { ...data, catalogSyncedAt: new Date() },
              });
              await this.audit.logInTransaction(tx, {
                action: "DATA_IMPORTED",
                entityType: "CandidateCatalog",
                entityId: current.id,
                correlationId,
                after: {
                  erpUid: row.erpUid,
                  deleted: row.deleted,
                  employed: row.employed ?? null,
                },
              });
            }
            return {
              erpUid: row.erpUid,
              candidateId: current.id,
              pendingObservation:
                data.employmentObservationPending && row.employed === true,
            };
          },
        );
        outcomes.push(outcome);
      } catch (error) {
        if (!(error instanceof ConflictException) || !options?.onConflict)
          throw error;
        options.onConflict(row);
      }
    }
    return outcomes;
  }
}
