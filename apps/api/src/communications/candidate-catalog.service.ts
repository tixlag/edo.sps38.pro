import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.module";
import { AuditService } from "../audit/audit.service";
import { DocumentAccessService } from "../documents/document-access.service";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "../documents/candidate-identity";
import { toCandidateProfile } from "../documents/candidate-profile";
import type { AuthPrincipal } from "../auth/auth-principal";
import { ErpCommunicationsClient } from "./erp-communications.client";
import type { CommunicationCandidatesQueryDto } from "./communications.dto";

@Injectable()
export class CandidateCatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CandidateCatalogService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly erp: ErpCommunicationsClient,
    private readonly audit: AuditService,
    private readonly access: DocumentAccessService,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    if (
      this.config.get<string>("CANDIDATE_CATALOG_SYNC_ENABLED") !== "true" ||
      !this.erp.configured()
    )
      return;
    const run = () => {
      void this.sync().catch(() =>
        this.logger.warn(
          "Candidate catalog sync failed; cached catalog retained",
        ),
      );
    };
    run();
    this.timer = setInterval(run, 300000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    const owner = randomUUID(),
      lock = "edo:candidate-catalog:lock";
    if (!(await this.redis.setNxPxStrict(lock, owner, 60000))) return;
    const deadline = Date.now() + 240000;
    const seen = new Set<string>();
    let cursor: string | undefined;
    try {
      const checkpointKey = "edo:candidate-catalog:checkpoint";
      const checkpoint = await this.redis.getStrict(checkpointKey);
      if (checkpoint) {
        cursor = checkpoint;
        seen.add(checkpoint);
      }
      const checkpointAt = async (value: string) => {
        const saved = await this.redis.evalStrict(
          "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[2], ARGV[2], 'EX', 86400) return 1",
          [lock, checkpointKey],
          [owner, value],
        );
        if (saved !== 1) throw new Error("CATALOG_LOCK_LOST");
      };
      for (let page = 0; page < 1000; page++) {
        // Large catalogs continue from the last committed page on the next
        // tick. An interrupted page is replayed idempotently, never skipped.
        if (this.stopped || Date.now() > deadline) return;
        const result = await this.erp.catalog(cursor);
        // No writes after losing coordination. Each transaction is bounded; lease
        // renewal is required before each page and each candidate write.
        for (const row of result.items) {
          if (!(await this.redis.compareAndExpire(lock, owner, 60000)))
            throw new Error("CATALOG_LOCK_LOST");
          try {
            await candidateIdentityTransaction(this.prisma, async (tx) => {
              const existing = await resolveCandidateIdentity(tx, {
                erpUid: row.erpUid,
                chatUuid: row.chatUuid,
                identityKey: row.chatUuid
                  ? `chat:${row.chatUuid}`
                  : `erp-candidate:${row.erpUid}`,
              });
              const location = row.projectCode
                ? await tx.lkLocation.findUnique({
                    where: { code1c: row.projectCode },
                  })
                : null;
              const data = {
                erpUid: row.erpUid,
                erpDeleted: row.deleted,
                chatUuid: row.chatUuid ?? existing?.chatUuid ?? null,
                fullName: row.fullName || null,
                projectCode: row.projectCode,
                projectName: row.projectName,
                positionCode: row.positionCode,
                positionName: row.positionName,
                locationId:
                  location?.deleted === false ? location.locationId : null,
                catalogSyncedAt: new Date(),
              };
              const changed =
                !existing.catalogSyncedAt ||
                Object.entries(data).some(
                  ([field, value]) =>
                    field !== "catalogSyncedAt" &&
                    existing[field as keyof typeof existing] !== value,
                );
              const candidate = await tx.candidate.update({
                where: { id: existing.id },
                data,
              });
              if (changed)
                await this.audit.logInTransaction(tx, {
                  action: "DATA_IMPORTED",
                  entityType: "CandidateCatalog",
                  entityId: candidate.id,
                  correlationId: owner,
                  after: { erpUid: row.erpUid, deleted: row.deleted },
                });
            });
          } catch (error) {
            if (!(error instanceof ConflictException)) throw error;
            this.logger.warn(
              "Candidate identity conflict; projection retained for manual reconciliation",
            );
          }
        }
        if (result.nextCursor === null) {
          await checkpointAt("");
          await this.redis.set(
            "edo:candidate-catalog:last-success",
            new Date().toISOString(),
          );
          return;
        }
        if (!result.items.length || seen.has(result.nextCursor))
          throw new Error("CATALOG_CURSOR_STALLED");
        seen.add(result.nextCursor);
        await checkpointAt(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error("CATALOG_PAGE_LIMIT");
    } finally {
      await this.redis.compareAndDelStrict(lock, owner);
    }
  }
  async list(principal: AuthPrincipal, query: CommunicationCandidatesQueryDto) {
    const limit = query.limit ?? 50;
    let after: { name: string | null; id: string } | undefined;
    if (query.cursor) {
      try {
        const raw = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString(),
        ) as { name: unknown; id: unknown };
        if (
          (raw.name !== null && typeof raw.name !== "string") ||
          typeof raw.id !== "string"
        )
          throw new Error();
        after = { name: raw.name as string | null, id: raw.id };
      } catch {
        throw new BadRequestException("Invalid candidate cursor");
      }
    }
    const items = await this.prisma.candidate.findMany({
      where: {
        AND: [
          this.access.candidateWhere(principal),
          { erpDeleted: false },
          ...(query.q?.trim()
            ? [{ fullName: { contains: query.q.trim() } }]
            : []),
          ...(after
            ? [
                {
                  OR:
                    after.name === null
                      ? [
                          { fullName: null, id: { gt: after.id } },
                          { fullName: { not: null } },
                        ]
                      : [
                          { fullName: { gt: after.name } },
                          { fullName: after.name, id: { gt: after.id } },
                        ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      take: limit + 1,
    });
    const page = items.slice(0, limit),
      last = page.at(-1);
    return {
      items: page.map((row) => toCandidateProfile(row)!),
      nextCursor:
        items.length > limit && last
          ? Buffer.from(
              JSON.stringify({ name: last.fullName, id: last.id }),
            ).toString("base64url")
          : null,
      syncedAt: await this.redis.get("edo:candidate-catalog:last-success"),
    };
  }
}
