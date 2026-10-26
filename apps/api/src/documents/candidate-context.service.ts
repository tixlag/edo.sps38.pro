import { Injectable } from "@nestjs/common";
import {
  CandidateDocumentError,
  withinDocumentDeadline,
} from "./candidate-document.error";
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
      candidateSnapshot: snapshot,
    };
  }

  /** Candidate is authoritative for profiles looked up by employee code too. */
  async forEmployee(
    code1c: string,
    signal?: AbortSignal,
  ): Promise<CandidateDocumentContextDto> {
    const key = `code_1c:${code1c}`;
    let request = this.pending.get(key);
    if (!request) {
      request = this.card(key, AbortSignal.timeout(19_000)).finally(() =>
        this.pending.delete(key),
      );
      this.pending.set(key, request);
    }
    let snapshot: CandidateSnapshotDto;
    try {
      snapshot = signal
        ? await withinDocumentDeadline(request, signal)
        : await request;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
      )
        throw new CandidateDocumentError(Code.ERP_TIMEOUT);
      if (error instanceof ErpCandidateError)
        throw new CandidateDocumentError(error.code, error.fields);
      throw error;
    }
    // A returned uuid is a chat identifier, but only LK can authorize its ownership.
    let chatUuid: string | null = null;
    if (snapshot.uuid) {
      const identity = await this.identity.byUuid(snapshot.uuid, signal);
      if (identity.code1c !== code1c)
        throw new CandidateDocumentError(Code.LK_CONTRACT_ERROR);
      chatUuid = identity.chatUuid;
    }
    return {
      chatUuid,
      code1c,
      positionCode1c: (snapshot.position as { code: string }).code,
      citizenship: snapshot.citizenship!,
      projectCode1c:
        (snapshot.project as { code?: string } | undefined)?.code ?? null,
      candidateSnapshot: snapshot,
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
