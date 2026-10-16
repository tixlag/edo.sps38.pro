import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LkCandidateIdentityService } from "./lk-candidate-identity.service";
import { ErpCandidateClient, ErpCandidateError } from "./erp-candidate.client";
import {
  CandidateCardCache,
  type CandidateCardEntry,
} from "./candidate-card-cache";
import type { CandidateSnapshotDto } from "./dto/document.dto";

@Injectable()
export class CandidateContextService {
  private readonly pending = new Map<string, Promise<CandidateSnapshotDto>>();
  constructor(
    private readonly identity: LkCandidateIdentityService,
    private readonly erp: ErpCandidateClient,
    private readonly cache: CandidateCardCache,
  ) {}

  async context(chatUuid: string, signal?: AbortSignal) {
    const identity = await this.identity.byUuid(chatUuid.toLowerCase(), signal);
    let request = this.pending.get(identity.chatUuid);
    if (!request) {
      request = this.card(identity.chatUuid, signal).finally(() =>
        this.pending.delete(identity.chatUuid),
      );
      this.pending.set(identity.chatUuid, request);
    }
    let snapshot: CandidateSnapshotDto;
    try {
      snapshot = await request;
    } catch (error) {
      if (error instanceof ErpCandidateError) {
        if (error.status === 404)
          throw new NotFoundException("ERP_CANDIDATE_NOT_FOUND");
        throw new ServiceUnavailableException("ERP_CANDIDATE_UNAVAILABLE");
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
  async ownChat(code1c: string, signal?: AbortSignal) {
    return (await this.identity.byEmployee(code1c, signal)).chatUuid;
  }
  private async card(
    uuid: string,
    signal?: AbortSignal,
  ): Promise<CandidateSnapshotDto> {
    let previous: CandidateCardEntry | null;
    try {
      previous = await this.cache.get(uuid, signal);
    } catch {
      return this.erp.findByChatUuid(uuid, signal);
    }
    if (previous && previous.freshUntil > Date.now()) return previous.snapshot;
    const owner = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.cache.acquire(uuid, owner, signal);
    } catch {
      return this.erp.findByChatUuid(uuid, signal);
    }
    if (!acquired) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await delay(50, undefined, { signal });
        try {
          const current = await this.cache.get(uuid, signal);
          if (current && current.freshUntil > Date.now())
            return current.snapshot;
        } catch {
          return this.erp.findByChatUuid(uuid, signal);
        }
      }
      throw new ServiceUnavailableException("ERP_CANDIDATE_BUSY");
    }
    try {
      // The previous owner may have finished between our first read and acquisition.
      const current = await this.cache.get(uuid, signal).catch(() => null);
      if (current && current.freshUntil > Date.now()) return current.snapshot;
      let snapshot: CandidateSnapshotDto;
      try {
        snapshot = await this.erp.findByChatUuid(uuid, signal);
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
