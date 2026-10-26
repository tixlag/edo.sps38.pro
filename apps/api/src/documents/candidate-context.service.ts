import { snapshotUpdateInput } from "./candidate-profile";
import { AuditService } from "../audit/audit.service";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "./candidate-identity";
import { ConflictException, Injectable } from "@nestjs/common";
import {
  CandidateDocumentError,
  withinDocumentDeadline,
} from "./candidate-document.error";
import { CandidateProfileField as Field } from "./dto/candidate-error.dto";
import { CandidateDocumentErrorCode as Code } from "./dto/candidate-error.dto";
import type { EdoCandidateChat } from "@edo/lk-client";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LkCandidateIdentityService } from "./lk-candidate-identity.service";
import { ErpCandidateClient, ErpCandidateError } from "./erp-candidate.client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CandidateCardCache,
  type CandidateCardEntry,
} from "./candidate-card-cache";
import type { CandidateSnapshotDto } from "./dto/document.dto";
import type { CandidateDocumentContextDto } from "./dto/candidate-context.dto";

@Injectable()
export class CandidateContextService {
  private readonly pending = new Map<string, Promise<CandidateSnapshotDto>>();
  constructor(
    private readonly identity: LkCandidateIdentityService,
    private readonly erp: ErpCandidateClient,
    private readonly cache: CandidateCardCache,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async context(chatUuid: string, signal?: AbortSignal) {
    const identity = await this.identity.byUuid(chatUuid.toLowerCase(), signal);
    return this.forIdentity(identity, signal);
  }
  async forIdentity(identity: EdoCandidateChat, signal?: AbortSignal) {
    const started = Date.now();
    let request = this.pending.get(identity.chatUuid);
    if (!request) {
      request = this.card(
        identity.chatUuid,
        AbortSignal.timeout(19_000),
      ).finally(() => this.pending.delete(identity.chatUuid));
      this.pending.set(identity.chatUuid, request);
    }
    let snapshot: CandidateSnapshotDto;
    try {
      snapshot = signal
        ? await withinDocumentDeadline(request, signal)
        : await request;
    } catch (error) {
      if (
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
      )
        throw new CandidateDocumentError(Code.ERP_TIMEOUT);
      if (error instanceof ErpCandidateError) {
        throw new CandidateDocumentError(error.code, error.fields, {
          source: "ERP",
          upstreamStatus: error.status,
          durationMs: Date.now() - started,
        });
      }
      throw error;
    }
    signal?.throwIfAborted();
    return {
      ...identity,
      positionCode1c: (snapshot.position as { code: string }).code,
      citizenship: snapshot.citizenship!,
      projectCode1c:
        (snapshot.project as { code?: string } | undefined)?.code ?? null,
      candidateSnapshot: { ...snapshot, reviewGroup: "RU" as const },
    };
  }

  /** Candidate is authoritative for profiles looked up by employee code too. */
  async forEmployee(
    code1c: string,
    signal?: AbortSignal,
  ): Promise<CandidateDocumentContextDto> {
    // Always revalidate the current ERP cycle. Neither cached LK links nor a
    // repeated employee code identify a historical admission cycle.
    signal?.throwIfAborted();
    const identity = await this.erp.resolveCurrentIdentity(code1c);
    const snapshot = identity.erpUid
      ? await this.erp.workspaceCard(identity.erpUid).then((card) => {
          if (
            card.erpUid !== identity.erpUid ||
            (card.personUid && card.personUid !== identity.personUid) ||
            (card.code1C && card.code1C !== code1c)
          )
            throw new ConflictException("ERP_CANDIDATE_IDENTITY_CHANGED");
          if (!card.position?.code)
            throw new CandidateDocumentError(
              Code.CANDIDATE_PROFILE_INCOMPLETE,
              [Field.POSITION_CODE],
            );
          return {
            uuid: card.chatUuid,
            erpUid: card.erpUid,
            personUid: card.personUid ?? undefined,
            fullName: card.fullName,
            birthDate: card.birthDate,
            citizenship: card.citizenship,
            position: card.position,
            project: card.project ?? undefined,
            managerName: card.manager?.name,
            reviewGroup: card.reviewGroup,
          };
        })
      : await this.erp.findByEmployeeCode(code1c, signal);
    const candidateSnapshot = {
      ...snapshot,
      reviewGroup: identity.reviewGroup,
      ...(identity.erpUid ? { erpUid: identity.erpUid } : {}),
      ...(identity.personUid ? { personUid: identity.personUid } : {}),
    };
    const candidate = await candidateIdentityTransaction(
      this.prisma,
      async (tx) => {
        const identityKey = identity.erpUid
          ? `erp:${identity.erpUid}`
          : `person:${identity.personUid}`;
        const before = await tx.candidate.findFirst({
          where: {
            OR: [
              { identityKey },
              ...(identity.erpUid ? [{ erpUid: identity.erpUid }] : []),
              ...(identity.chatUuid ? [{ chatUuid: identity.chatUuid }] : []),
            ],
          },
        });
        const owner = await resolveCandidateIdentity(tx, {
          identityKey,
          code1c,
          erpUid: identity.erpUid,
          chatUuid: identity.chatUuid,
          personUid: identity.personUid,
          reviewGroup: identity.reviewGroup,
        });
        const profile = snapshotUpdateInput(candidateSnapshot);
        const changed =
          !before ||
          before.code1c !== code1c ||
          before.reviewGroup !== identity.reviewGroup ||
          before.personUid !== identity.personUid ||
          before.erpUid !== identity.erpUid ||
          Object.entries(profile ?? {}).some(
            ([key, value]) =>
              key !== "profileSyncedAt" &&
              JSON.stringify(before[key as keyof typeof before]) !==
                JSON.stringify(value),
          );
        await tx.candidate.update({
          where: { id: owner.id },
          data: { code1c, ...profile },
        });
        const classified = identity.erpUid
          ? await tx.document.updateMany({
              where: { candidateId: owner.id, reviewGroup: null },
              data: { reviewGroup: "RU" },
            })
          : { count: 0 };
        if (changed || classified.count)
          await this.audit.logInTransaction(tx, {
            actorId: "verified-employee",
            action: "CANDIDATE_LINKED",
            entityType: "Candidate",
            entityId: owner.id,
            correlationId: "",
            before: before
              ? {
                  code1c: before.code1c,
                  reviewGroup: before.reviewGroup,
                  personUid: before.personUid,
                }
              : null,
            after: {
              code1c,
              reviewGroup: identity.reviewGroup,
              personUid: identity.personUid,
              classifiedDocuments: classified.count,
            },
          });
        return owner;
      },
    );
    return {
      candidateId: candidate.id,
      chatUuid: identity.chatUuid,
      code1c,
      positionCode1c: (snapshot.position as { code: string }).code,
      citizenship: snapshot.citizenship!,
      projectCode1c:
        (snapshot.project as { code?: string } | undefined)?.code ?? null,
      candidateSnapshot,
    };
  }

  private async card(
    uuid: string,
    signal?: AbortSignal,
  ): Promise<CandidateSnapshotDto> {
    const fetchCard = () =>
      uuid.startsWith("code_1c:")
        ? this.erp.findByEmployeeCode(uuid.slice(8), signal)
        : this.erp.findByChatUuid(uuid, signal);
    let previous: CandidateCardEntry | null;
    try {
      previous = await this.cache.get(uuid, signal);
    } catch {
      return fetchCard();
    }
    if (previous?.snapshot.erpUid && previous.freshUntil > Date.now())
      return previous.snapshot;
    const owner = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.cache.acquire(uuid, owner, signal);
    } catch {
      return fetchCard();
    }
    if (!acquired) {
      const deadline = Date.now() + 17_000;
      while (Date.now() < deadline) {
        await delay(50, undefined, { signal });
        try {
          const current = await this.cache.get(uuid, signal);
          if (current?.snapshot.erpUid && current.freshUntil > Date.now())
            return current.snapshot;
        } catch {
          return fetchCard();
        }
      }
      throw new CandidateDocumentError(Code.ERP_UNAVAILABLE);
    }
    try {
      // The previous owner may have finished between our first read and acquisition.
      const current = await this.cache.get(uuid, signal).catch(() => null);
      if (current?.snapshot.erpUid && current.freshUntil > Date.now())
        return current.snapshot;
      let snapshot: CandidateSnapshotDto;
      try {
        snapshot = await fetchCard();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (previous && (error as { transient?: boolean }).transient === true) {
          await this.cache
            .write(uuid, owner, {
              ...previous,
              freshUntil: Date.now() + 60_000,
            })
            .catch(() => undefined);
          return previous.snapshot;
        }
        await this.cache
          .write(uuid, owner, null, signal)
          .catch(() => undefined);
        throw error;
      }
      await this.cache
        .write(uuid, owner, { snapshot, freshUntil: Date.now() + 15 * 60_000 })
        .catch(() => undefined);
      return snapshot;
    } finally {
      await this.cache.release(uuid, owner).catch(() => undefined);
    }
  }
}
