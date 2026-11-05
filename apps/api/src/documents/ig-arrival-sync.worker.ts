import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { IgArrivalProjectionService } from "./ig-arrival-projection.service";
import {
  arrivalStateSchema,
  arrivalSourceIssueSchema,
} from "./ig-arrival-contract";

const acknowledgement = z.object({
  personUid: z.string().uuid(),
  revision: z.number().int().positive().safe(),
  state: z.enum(["CURRENT", "NONE", "CONFLICT"]),
  currentArrivalMemberUid: z.string().uuid().nullable(),
});

interface SyncLease {
  lockToken: string;
  generation: bigint;
  cursor: string | null;
}
@Injectable()
export class IgArrivalSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgArrivalSyncWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly projection: IgArrivalProjectionService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}
  onModuleInit(): void {
    if (this.config.get<string>("EDO_ARRIVAL_SYNC_ENABLED") !== "true") return;
    const tick = () =>
      void this.sync().catch(() =>
        this.logger.warn("Arrival synchronization failed; retry scheduled"),
      );
    tick();
    this.timer = setInterval(tick, 30_000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  sync(): Promise<void> {
    if (!this.running)
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async run(): Promise<void> {
    const totalDeadline = Date.now() + 300_000;
    const erpDeadline = totalDeadline - 30_000;
    const lease = await this.acquireLease();
    if (!lease) {
      this.logger.debug(
        "Arrival sync lease is held by another worker; skipping run",
      );
      return;
    }

    try {
      let cursor: string | undefined = lease.cursor?.trim() || undefined;
      const seen = new Set<string>();
      for (let pageNo = 0; pageNo < 100; pageNo++) {
        if (Date.now() >= erpDeadline) {
          await this.saveSyncState(lease, cursor ?? null);
          return;
        }
        let page;
        try {
          page = await this.erp.arrivalPage(100, cursor);
        } catch (error) {
          if (cursor !== undefined && this.isInvalidCursorError(error)) {
            await this.saveSyncState(lease, null);
            cursor = undefined;
            seen.clear();
            page = await this.erp.arrivalPage(100, undefined);
          } else {
            throw error;
          }
        }
        const issues = (page.issues ?? []).map((raw) =>
          arrivalSourceIssueSchema.safeParse(raw),
        );
        const reported = new Set(
          issues.flatMap((issue) =>
            issue.success ? [issue.data.personUid] : [],
          ),
        );
        for (const raw of page.items) {
          if (Date.now() >= erpDeadline) {
            await this.saveSyncState(lease, cursor ?? null);
            return;
          }
          const item = arrivalStateSchema.safeParse(raw);
          if (!item.success) {
            const candidate =
              raw && typeof raw === "object"
                ? (raw as Record<string, unknown>)
                : {};
            const person =
              typeof candidate.personUid === "string" &&
              z.string().uuid().safeParse(candidate.personUid).success
                ? candidate.personUid.toLowerCase()
                : "unknown";
            const revision =
              typeof candidate.revision === "number" &&
              Number.isSafeInteger(candidate.revision) &&
              candidate.revision > 0
                ? candidate.revision
                : null;
            await this.recordIssue(person, revision, "ARRIVAL_STATE_INVALID");
            continue;
          }
          try {
            const accepted = await this.projection.apply(item.data);
            if (accepted && !reported.has(item.data.personUid))
              await this.prisma.igArrivalIssue.updateMany({
                where: {
                  personHash: this.personHash(item.data.personUid),
                  active: true,
                },
                data: { active: false },
              });
          } catch (error) {
            const code =
              error instanceof Error &&
              [
                "ARRIVAL_PERSON_CODE_CONFLICT",
                "ARRIVAL_REVISION_CONFLICT",
                "ARRIVAL_MEMBER_OWNER_CONFLICT",
              ].includes(error.message)
                ? error.message
                : "ARRIVAL_PROJECTION_CONFLICT";
            await this.recordIssue(
              item.data.personUid,
              item.data.revision,
              code,
            );
          }
        }
        for (const issue of issues) {
          if (issue.success)
            await this.recordIssue(issue.data.personUid, null, issue.data.code);
          else
            await this.recordIssue(
              "unknown",
              null,
              "ARRIVAL_SOURCE_ISSUE_INVALID",
            );
        }
        if (page.nextCursor === null) {
          await this.saveSyncState(lease, null, new Date());
          return;
        }
        if (seen.has(page.nextCursor) || page.nextCursor === cursor)
          throw new Error("ARRIVAL_CURSOR_REPEAT");
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      await this.saveSyncState(lease, cursor ?? null);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("ARRIVAL_SYNC_FENCING_CONFLICT")
      ) {
        this.logger.warn(error.message);
        return;
      }
      throw error;
    } finally {
      try {
        await this.deliverPending(totalDeadline);
      } catch (e) {
        this.logger.warn(
          `Failed final deliverPending: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      try {
        await this.releaseLease(lease);
      } catch (err) {
        this.logger.warn(
          `Failed to release arrival sync lease: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  private async acquireLease(): Promise<SyncLease | null> {
    const lockToken = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 300_000);

    return await this.prisma.$transaction(async (tx) => {
      let row = await tx.igArrivalSyncState.findUnique({
        where: { id: "singleton" },
      });

      if (!row) {
        row = await tx.igArrivalSyncState.create({
          data: {
            id: "singleton",
            lockToken,
            lockExpiresAt: expiresAt,
            generation: 1n,
          },
        });
        return {
          lockToken,
          generation: 1n,
          cursor: row.cursor ?? null,
        };
      }

      const isLocked =
        row.lockToken !== null &&
        row.lockExpiresAt !== null &&
        row.lockExpiresAt > now &&
        row.lockToken !== lockToken;

      if (isLocked) {
        return null;
      }

      const currentGen = BigInt(row.generation ?? 0n);
      const nextGeneration = currentGen + 1n;
      const updated = await tx.igArrivalSyncState.updateMany({
        where: {
          id: "singleton",
          generation: currentGen,
        },
        data: {
          lockToken,
          lockExpiresAt: expiresAt,
          generation: nextGeneration,
        },
      });

      if (updated.count === 0) {
        return null;
      }

      return {
        lockToken,
        generation: nextGeneration,
        cursor: row.cursor ?? null,
      };
    });
  }
  private async releaseLease(lease: SyncLease): Promise<void> {
    await this.prisma.igArrivalSyncState.updateMany({
      where: {
        id: "singleton",
        lockToken: lease.lockToken,
        generation: lease.generation,
      },
      data: {
        lockToken: null,
        lockExpiresAt: null,
      },
    });
  }
  private isInvalidCursorError(error: unknown): boolean {
    if (
      error instanceof BadRequestException &&
      (error.message === "INVALID_CURSOR" ||
        (typeof error.getResponse() === "object" &&
          (error.getResponse() as Record<string, unknown>)?.message ===
            "INVALID_CURSOR") ||
        error.getResponse() === "INVALID_CURSOR")
    ) {
      return true;
    }
    if (error instanceof Error && error.message === "INVALID_CURSOR") {
      return true;
    }
    return false;
  }
  private async saveSyncState(
    lease: SyncLease,
    cursor: string | null,
    completedAt?: Date | null,
  ): Promise<void> {
    const updated = await this.prisma.igArrivalSyncState.updateMany({
      where: {
        id: "singleton",
        lockToken: lease.lockToken,
        generation: lease.generation,
      },
      data: {
        cursor,
        ...(completedAt !== undefined ? { completedAt } : {}),
      },
    });

    if (updated.count === 0) {
      throw new Error(
        `ARRIVAL_SYNC_FENCING_CONFLICT: sync lease (gen ${lease.generation}) lost or superseded`,
      );
    }
  }
  private personHash(personUid: string): string {
    return createHash("sha256").update(personUid.toLowerCase()).digest("hex");
  }
  private async recordIssue(
    personUid: string,
    revision: number | null,
    code: string,
  ): Promise<void> {
    const personHash = this.personHash(personUid);
    const id = createHash("sha256")
      .update(`${personHash}:${revision ?? 0}:${code}`)
      .digest("hex");
    await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.igArrivalIssue.createMany({
        data: [
          {
            id,
            personHash,
            revision: revision === null ? null : BigInt(revision),
            code,
          },
        ],
        skipDuplicates: true,
      });
      if (!inserted.count) {
        await tx.igArrivalIssue.updateMany({
          where: { id, active: false },
          data: { active: true },
        });
        return;
      }
      await this.audit.logInTransaction(tx, {
        actorId: "system:arrival-sync",
        action: "DATA_IMPORTED",
        entityType: "IgArrivalSourceIssue",
        entityId: id,
        after: { codes: [code] },
      });
    });
  }
  private async deliverPending(deadline: number): Promise<void> {
    const endpoint = this.config.get<string>("EDO_ARRIVAL_CONTEXTS_URL")?.trim(),
      token = this.config.get<string>("EDO_ADAPTATION_SYNC_TOKEN")?.trim();
    if (!endpoint || !token) return;
    let url: URL;
    try {
      url = new URL(endpoint);
      if (
        url.pathname !== "/surveys-service/api/internal/edo/arrival-contexts" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            this.config.get("NODE_ENV") !== "production"
          ))
      )
        throw new Error("ARRIVAL_SYNC_URL_INVALID");
    } catch (err) {
      this.logger.warn(
        `Arrival context endpoint invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const rows = await this.prisma.igArrivalPerson.findMany({
      where: {
        syncPending: true,
        igVerified: true,
        bindingError: null,
        revision: { gt: 0 },
      },
      take: 100,
      orderBy: [{ updatedAt: "asc" }, { personUid: "asc" }],
    });
    for (const row of rows) {
      if (Date.now() >= deadline) return;
      const where = {
        personUid: row.personUid,
        revision: row.revision,
        sourceHash: row.sourceHash,
        syncPending: true,
        bindingError: null,
        igVerified: true,
      };
      try {
        const item = arrivalStateSchema.parse(row.sourcePayload);
        if (
          BigInt(item.revision) !== row.revision ||
          item.personUid !== row.personUid
        )
          throw new Error("ARRIVAL_PAYLOAD_MISMATCH");
        let response: Response;
        try {
          response = await fetch(url, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(item),
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(10_000, deadline - Date.now())),
            ),
            redirect: "error",
          });
        } catch (fetchErr) {
          await this.prisma.igArrivalPerson.updateMany({
            where,
            data: { syncError: "ARRIVAL_SURVEYS_UNCONFIRMED" },
          });
          this.logger.warn(
            `Surveys service unreachable during arrival context delivery: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          );
          break;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          await this.prisma.igArrivalPerson.updateMany({
            where,
            data: { syncError: "ARRIVAL_SURVEYS_UNCONFIRMED" },
          });
          this.logger.warn(
            `Surveys service returned HTTP ${response.status} during arrival context delivery`,
          );
          if (response.status >= 500) {
            break;
          }
          continue;
        }
        const reader = response.body.getReader();
        let length = 0;
        const chunks: Buffer[] = [];
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.length;
            if (length > 8192) throw new Error("ARRIVAL_RECEIPT_TOO_LARGE");
            chunks.push(Buffer.from(part.value));
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const receipt = acknowledgement.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        if (
          receipt.personUid.toLowerCase() !== item.personUid ||
          receipt.revision !== item.revision ||
          receipt.state !== item.state ||
          (receipt.currentArrivalMemberUid?.toLowerCase() !==
            item.currentArrivalMemberUid &&
            !(
              receipt.currentArrivalMemberUid === null &&
              item.currentArrivalMemberUid === null
            ))
        )
          throw new Error("ARRIVAL_RECEIPT_MISMATCH");
        await this.prisma.igArrivalPerson.updateMany({
          where,
          data: {
            syncPending: false,
            syncedRevision: row.revision,
            syncError: null,
          },
        });
      } catch (err) {
        await this.prisma.igArrivalPerson.updateMany({
          where,
          data: { syncError: "ARRIVAL_SURVEYS_UNCONFIRMED" },
        });
        this.logger.warn(
          `Failed to confirm arrival context for ${row.personUid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
