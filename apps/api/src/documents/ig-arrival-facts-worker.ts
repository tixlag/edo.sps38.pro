import { z } from "zod";
import {
  arrivalFactsPageSchema,
  arrivalFactsPersonSchema,
} from "./ig-arrival-facts-contract";
import type {
  IgArrivalFactsProjectionService,
  ArrivalFactsLease,
} from "./ig-arrival-facts-projection.service";
import type { ErpWorkspaceClient } from "./erp-workspace.client";

const sourceIssue = z.object({
  personUid: z.string().uuid().nullable(),
  code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
  sourceKey: z.string().max(128).nullable().optional(),
});

export async function syncArrivalFacts(
  erp: Pick<ErpWorkspaceClient, "arrivalFactsPage">,
  projection: Pick<
    IgArrivalFactsProjectionService,
    "apply" | "finish" | "recordIssue"
  >,
  lease: ArrivalFactsLease,
  deadline: number,
  progress: {
    cursor?: string;
    incomplete?: boolean;
    checkpoint?: (
      cursor: string | null,
      incomplete: boolean,
    ) => Promise<unknown>;
  } = {},
): Promise<void> {
  let cursor = progress.cursor;
  let complete = !progress.incomplete;
  const seen = new Set<string>();
  const seenPeople = new Set<string>();
  while (Date.now() < deadline) {
    const page = arrivalFactsPageSchema.parse(
      await erp.arrivalFactsPage(1, cursor),
    );
    const issues = page.issues.map((issue) => sourceIssue.safeParse(issue));
    const items = page.items.map((item) =>
      arrivalFactsPersonSchema.safeParse(item),
    );
    const parsedItems = items.flatMap((result) =>
      result.success ? [result.data] : [],
    );
    for (let index = 0; index < items.length; index++) {
      if (items[index].success) continue;
      complete = false;
      const raw = page.items[index] as { personUid?: unknown } | null;
      const uid =
        typeof raw?.personUid === "string" &&
        z.string().uuid().safeParse(raw.personUid).success
          ? raw.personUid.toLowerCase()
          : null;
      await projection.recordIssue(uid, "ARRIVAL_STATE_INVALID", lease);
    }
    const parsedIssues = issues.flatMap((result) =>
      result.success ? [result.data] : [],
    );
    if (parsedIssues.length !== issues.length) {
      complete = false;
      await projection.recordIssue(null, "ARRIVAL_SOURCE_ISSUE_INVALID", lease);
    }
    for (const issue of parsedIssues) {
      if (issue.code !== "DUPLICATE_ARRIVAL_MEMBER_UID") {
        complete = false;
        await projection.recordIssue(
          issue.personUid?.toLowerCase() ?? null,
          issue.code,
          lease,
        );
        continue;
      }
      const person = parsedItems.find(
        (item) => item.personUid === issue.personUid?.toLowerCase(),
      );
      if (
        !issue.sourceKey ||
        !person?.participations.some(
          (fact) =>
            fact.sourceKey === issue.sourceKey &&
            fact.arrivalMemberUid !== null,
        )
      ) {
        complete = false;
        await projection.recordIssue(
          issue.personUid?.toLowerCase() ?? null,
          "ARRIVAL_SOURCE_ISSUE_INVALID",
          lease,
        );
      }
    }
    for (const item of parsedItems) {
      if (seenPeople.has(item.personUid))
        throw new Error("ARRIVAL_PERSON_REPEAT");
      seenPeople.add(item.personUid);
      if (Date.now() >= deadline) return;
      const personIssues = parsedIssues.filter(
        (issue) => issue.personUid?.toLowerCase() === item.personUid,
      );
      try {
        await projection.apply(item, lease, personIssues);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("ARRIVAL_SYNC_FENCING_CONFLICT")
        )
          throw error;
        complete = false;
        await projection.recordIssue(
          item.personUid,
          "ARRIVAL_PROJECTION_CONFLICT",
          lease,
        );
      }
    }
    if (page.nextCursor === null) {
      if (complete) await projection.finish(lease);
      else await progress.checkpoint?.(null, true);
      return;
    }
    if (seen.has(page.nextCursor) || page.nextCursor === cursor)
      throw new Error("ARRIVAL_CURSOR_REPEAT");
    seen.add(page.nextCursor);
    await progress.checkpoint?.(page.nextCursor, !complete);
    cursor = page.nextCursor;
  }
}

import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { IgArrivalProjectionService } from "./ig-arrival-projection.service";
import { IgArrivalSyncWorker } from "./ig-arrival-sync.worker";
import { ErpWorkspaceClient as WorkspaceClient } from "./erp-workspace.client";
import { IgArrivalFactsProjectionService as FactsProjection } from "./ig-arrival-facts-projection.service";

@Injectable()
export class IgArrivalFactsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgArrivalFactsWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: WorkspaceClient,
    private readonly projection: FactsProjection,
    private readonly config: ConfigService,
    private readonly legacyProjection: IgArrivalProjectionService,
    private readonly audit: AuditService,
  ) {}
  onModuleInit(): void {
    if (this.config.get<string>("EDO_ARRIVAL_SYNC_ENABLED") !== "true") return;
    const tick = () =>
      void this.sync().catch(() =>
        this.logger.warn(
          "Arrival facts synchronization failed; retry scheduled",
        ),
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
    const token = randomUUID();
    const lease = await this.prisma.$transaction(async (tx) => {
      await tx.igArrivalSyncState.createMany({
        data: [{ id: "singleton" }],
        skipDuplicates: true,
      });
      const rows = await tx.$queryRaw<
        {
          lockToken: string | null;
          generation: bigint;
          lockExpiresAt: Date | null;
          cursor: string | null;
          factsScanGeneration: bigint | null;
          factsScanIncomplete: boolean;
        }[]
      >`SELECT lockToken,generation,lockExpiresAt,\`cursor\`,factsScanGeneration,factsScanIncomplete FROM ig_arrival_sync_state WHERE id='singleton' FOR UPDATE`;
      const row = rows[0];
      if (row.lockToken && row.lockExpiresAt && row.lockExpiresAt > new Date())
        return null;
      const generation = row.generation + 1n;
      const resume = !!row.cursor && row.factsScanGeneration !== null;
      const scanGeneration = resume ? row.factsScanGeneration! : generation;
      await tx.igArrivalSyncState.update({
        where: { id: "singleton" },
        data: {
          lockToken: token,
          generation,
          lockExpiresAt: new Date(Date.now() + 300_000),
          factsScanGeneration: scanGeneration,
          ...(resume ? {} : { cursor: null, factsScanIncomplete: false }),
        },
      });
      return {
        lockToken: token,
        generation,
        scanGeneration,
        cursor: resume ? row.cursor! : undefined,
        incomplete: resume && !!row.factsScanIncomplete,
      };
    });
    if (!lease) return;
    try {
      await syncArrivalFacts(
        this.erp,
        this.projection,
        lease,
        Date.now() + 270_000,
        {
          cursor: lease.cursor,
          incomplete: lease.incomplete,
          checkpoint: async (cursor, incomplete) => {
            const result = await this.prisma.igArrivalSyncState.updateMany({
              where: {
                id: "singleton",
                lockToken: token,
                generation: lease.generation,
                lockExpiresAt: { gt: new Date() },
                factsScanGeneration: lease.scanGeneration,
              },
              data: cursor
                ? { cursor, factsScanIncomplete: incomplete }
                : {
                    cursor: null,
                    factsScanIncomplete: false,
                    factsScanGeneration: null,
                  },
            });
            if (result.count !== 1)
              throw new Error("ARRIVAL_SYNC_FENCING_CONFLICT");
          },
        },
      );
    } finally {
      const exporter = new IgArrivalSyncWorker(
        this.prisma,
        this.erp,
        this.legacyProjection,
        this.config,
        this.audit,
      );
      try {
        await exporter.exportPending(Date.now() + 20_000);
      } catch {
        this.logger.warn("Arrival context delivery failed; retry scheduled");
      }
      await this.prisma.igArrivalSyncState.updateMany({
        where: {
          id: "singleton",
          lockToken: token,
          generation: lease.generation,
        },
        data: { lockToken: null, lockExpiresAt: null },
      });
    }
  }
}
