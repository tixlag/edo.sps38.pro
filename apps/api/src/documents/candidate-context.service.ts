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
import { CandidateProfileField } from "./dto/candidate-error.dto";
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

  /**
   * Authenticated employees can upload their own documents without a chat
   * link. Use the locally synchronized LK employee projection as the source
   * for the server-side upload context; never trust profile fields from the
   * browser.
   */
  async forEmployee(code1c: string): Promise<CandidateDocumentContextDto> {
    const employee = await this.prisma.lkEmployee.findUnique({
      where: { code1c },
      select: {
        code1c: true,
        fullName: true,
        birthday: true,
        citizenship: true,
        positionCode1c: true,
        positionName: true,
        sourcePresent: true,
      },
    });
    if (!employee?.sourcePresent || !employee.positionCode1c)
      throw new CandidateDocumentError(Code.CANDIDATE_PROFILE_INCOMPLETE, [
        CandidateProfileField.POSITION_CODE,
      ]);

    const rawCitizenship = employee.citizenship?.trim();
    if (rawCitizenship && !/^[a-zA-Z]{2}$/.test(rawCitizenship))
      throw new CandidateDocumentError(Code.LK_CONTRACT_ERROR);
    const citizenship = rawCitizenship?.toLowerCase() || "ru";
    const candidateSnapshot: CandidateSnapshotDto = {
      ...(employee.fullName?.trim()
        ? { fullName: employee.fullName.trim() }
        : {}),
      ...(employee.birthday
        ? { birthDate: employee.birthday.toISOString().slice(0, 10) }
        : {}),
      citizenship,
      position: {
        code: employee.positionCode1c,
        ...(employee.positionName?.trim()
          ? { name: employee.positionName.trim() }
          : {}),
      },
    };
    return {
      chatUuid: null,
      code1c: employee.code1c,
      positionCode1c: employee.positionCode1c,
      citizenship,
      projectCode1c: null,
      candidateSnapshot,
    };
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
    if (previous?.snapshot.erpUid && previous.freshUntil > Date.now())
      return previous.snapshot;
    const owner = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.cache.acquire(uuid, owner, signal);
    } catch {
      return this.erp.findByChatUuid(uuid, signal);
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
          return this.erp.findByChatUuid(uuid, signal);
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
