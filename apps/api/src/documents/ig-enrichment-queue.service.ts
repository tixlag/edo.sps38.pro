import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Candidate } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { DocumentAccessService } from "./document-access.service";
import {
  candidateReviewGroup,
  requireReviewGroup,
  reviewGroupWhere,
} from "./review-group";
import { IgProfileEnrichmentService } from "./ig-profile-enrichment.service";
import {
  CandidateBatchStatusDto,
  CandidateEnrichmentDto,
  ENRICHMENT_STATES,
} from "./dto/candidate-enrichment.dto";
import {
  RuEnrichmentNotificationsService,
  type RuEnrichmentItem,
} from "./ru-enrichment-notifications.service";
import {
  ErpWorkspaceClient,
  previousDocumentsBatchSchema,
  uuid,
} from "./erp-workspace.client";
import { CandidatePreviousDocumentsSyncService } from "./candidate-previous-documents-sync.service";
import type { z } from "zod";
import { ErpEventSyncService } from "./erp-event-sync.service";

const LEASE_MS = 120_000;
const igEligible: Prisma.CandidateWhereInput = {
  reviewGroup: "IG",
  code1c: { not: null },
  personUid: { not: null },
  chatUuid: null,
  erpUid: null,
  OR: [{ citizenship: null }, { citizenship: { not: "ru" } }],
};
const eligible: Prisma.CandidateWhereInput = {
  OR: [
    igEligible,
    {
      erpUid: { not: null },
      AND: [reviewGroupWhere("RU")],
    },
  ],
};
function profileReady(c: Candidate) {
  if (candidateReviewGroup(c) === "RU") return !!c.erpUid;
  return !!(
    c.profileSyncedAt &&
    c.positionCode &&
    c.citizenship &&
    c.citizenship.toLowerCase() !== "ru"
  );
}

@Injectable()
export class IgEnrichmentQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgEnrichmentQueueService.name);
  private timer?: ReturnType<typeof setInterval>;
  private readonly running = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopping = false;
  private preferErpChanges = true;
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichment: IgProfileEnrichmentService,
    private readonly access: DocumentAccessService,
    private readonly config: ConfigService,
    private readonly erp: ErpWorkspaceClient,
    private readonly previousDocs: CandidatePreviousDocumentsSyncService,
    private readonly notifications?: RuEnrichmentNotificationsService,
    @Optional() private readonly erpChanges?: ErpEventSyncService,
  ) {}
  private get backgroundEnabled(): boolean {
    return this.config.get<string>("EDO_ARRIVAL_SYNC_ENABLED") === "true";
  }
  onModuleInit() {
    const tick = () => {
      this.erpChanges?.maintenanceTick();
      for (const lane of ["priority", "background"] as const) {
        if (this.running.has(lane) || this.stopping) continue;
        const work = this.runLane(lane)
          .catch(() =>
            this.logger.warn("Employee enrichment failed; retry scheduled"),
          )
          .finally(() => this.running.delete(lane));
        this.running.set(lane, work);
      }
    };
    this.timer = setInterval(tick, 5_000);
    this.timer.unref();
    tick();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.running.values());
  }
  async status(id: string): Promise<CandidateEnrichmentDto> {
    const [c, job] = await Promise.all([
      this.prisma.candidate.findUniqueOrThrow({ where: { id } }),
      this.prisma.igEnrichmentJob.findUnique({ where: { candidateId: id } }),
    ]);
    const ready = profileReady(c),
      docs = c.previousDocumentsSyncedAt !== null;
    const state =
      ready && docs && (!job || job.status === "READY")
        ? "READY"
        : job?.status === "RUNNING" &&
            job.leaseExpiresAt &&
            job.leaseExpiresAt > new Date()
          ? "RUNNING"
          : job?.status === "RETRY"
            ? "RETRY"
            : "PENDING";
    return {
      status: state,
      profileReady: ready,
      documentsReady: docs,
      retryAt: state === "RETRY" ? job!.nextAttemptAt.toISOString() : null,
    };
  }
  async request(
    id: string,
    principal: AuthPrincipal,
  ): Promise<CandidateEnrichmentDto> {
    const c = await this.access.candidate(id, principal);
    const group = candidateReviewGroup(c);
    requireReviewGroup(principal, group);
    if (
      group === "RU"
        ? !c.erpUid
        : c.reviewGroup !== "IG" ||
          !c.code1c ||
          !c.personUid ||
          c.chatUuid ||
          c.erpUid ||
          c.citizenship?.toLowerCase() === "ru"
    )
      throw new ConflictException("ERP_PERSON_IDENTITY_REQUIRED");
    if (
      c.previousDocumentsSyncedAt &&
      ((group === "IG" && profileReady(c)) ||
        (group === "RU" &&
          Date.now() - c.previousDocumentsSyncedAt.getTime() < 5 * 60_000))
    )
      return this.status(id);
    // Upsert only promotes priority; reopening never resets attempts or cooldown.
    await this.prisma.$transaction(async (tx) => {
      await tx.igEnrichmentJob.upsert({
        where: { candidateId: id },
        create: { candidateId: id, priority: true, requestedAt: new Date(0) },
        update: { priority: true, requestedAt: new Date(0) },
      });
      await tx.igEnrichmentJob.updateMany({
        where: { candidateId: id, status: "READY" },
        data: {
          status: "PENDING",
          nextAttemptAt: new Date(),
          attempts: 0,
        },
      });
    });
    return this.status(id);
  }
  async requestBatch(ids: string[], principal: AuthPrincipal) {
    requireReviewGroup(principal, "RU");
    // One scoped read for the visible page; jobs are queued for background batch refresh.
    const candidates = await this.prisma.candidate.findMany({
      where: {
        AND: [
          this.access.candidateWhere(principal),
          reviewGroupWhere("RU"),
          {
            id: { in: [...new Set(ids)] },
            erpUid: { not: null },
            erpDeleted: false,
          },
        ],
      },
      select: { id: true, erpUid: true, previousDocumentsSyncedAt: true },
    });
    const eventMode = this.config.get?.<string>("ERP_CHANGE_SYNC_MODE") === "events";
    const cutoff = Date.now() - 20 * 60_000;
    const staleIds = candidates
      .filter(
        (c) =>
          !c.previousDocumentsSyncedAt ||
          c.previousDocumentsSyncedAt.getTime() < cutoff,
      )
      .map((c) => c.id);
    if (!eventMode && staleIds.length) {
      await this.prisma.$transaction(async (tx) => {
        await tx.igEnrichmentJob.createMany({
          data: staleIds.map((candidateId) => ({
            candidateId,
            priority: false,
          })),
          skipDuplicates: true,
        });
        await tx.igEnrichmentJob.updateMany({
          where: { candidateId: { in: staleIds }, status: "READY" },
          data: {
            status: "PENDING",
            requestedAt: new Date(),
            nextAttemptAt: new Date(),
            attempts: 0,
          },
        });
      });
    }
    const pending = await this.prisma.igEnrichmentJob.findMany({
      where: {
        candidateId: { in: candidates.map((c) => c.id) },
        status: { in: ["PENDING", "RUNNING", "RETRY"] },
      },
      select: { candidateId: true },
    });
    return { pendingCandidateIds: pending.map((job) => job.candidateId) };
  }

  async batchStatus(
    ids: string[],
    principal: AuthPrincipal,
  ): Promise<CandidateBatchStatusDto> {
    requireReviewGroup(principal, "RU");
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return { items: [] };
    }
    const candidates = await this.prisma.candidate.findMany({
      where: {
        AND: [
          this.access.candidateWhere(principal),
          reviewGroupWhere("RU"),
          {
            id: { in: uniqueIds },
            erpDeleted: false,
          },
        ],
      },
      select: {
        id: true,
        erpUid: true,
        citizenship: true,
        chatUuid: true,
        reviewGroup: true,
        previousDocumentsSyncedAt: true,
        profileSyncedAt: true,
        positionCode: true,
      },
    });
    if (candidates.length === 0) {
      return { items: [] };
    }
    const candidateIds = candidates.map((c) => c.id);
    const jobs = await this.prisma.igEnrichmentJob.findMany({
      where: { candidateId: { in: candidateIds } },
      select: {
        candidateId: true,
        status: true,
        leaseExpiresAt: true,
        nextAttemptAt: true,
      },
    });
    const jobMap = new Map(jobs.map((j) => [j.candidateId, j]));
    const now = new Date();
    const items = candidates.map((c) => {
      const job = jobMap.get(c.id);
      const ready = profileReady(c as Candidate);
      const docs = c.previousDocumentsSyncedAt !== null;
      let status: (typeof ENRICHMENT_STATES)[number];
      let retryAt: string | null = null;
      if (ready && docs && (!job || job.status === "READY")) {
        status = "READY";
      } else if (
        job?.status === "RUNNING" &&
        job.leaseExpiresAt &&
        job.leaseExpiresAt > now
      ) {
        status = "RUNNING";
      } else if (job?.status === "RETRY") {
        status = "RETRY";
        retryAt = job.nextAttemptAt ? job.nextAttemptAt.toISOString() : null;
      } else {
        status = "PENDING";
      }
      return {
        candidateId: c.id,
        status,
        retryAt,
      };
    });
    return { items };
  }

  private async claim(
    lane: "priority" | "background",
  ): Promise<
    | {
        kind: "single";
        job: any;
        token: string;
        lane: "priority" | "background";
      }
    | {
        kind: "ru-batch";
        jobs: any[];
        token: string;
        lane: "background";
      }
    | null
  > {
    const token = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { leaseToken: string | null; leaseExpiresAt: Date | null }[]
      >`
        SELECT leaseToken,leaseExpiresAt FROM ig_enrichment_lanes WHERE id=${lane} FOR UPDATE`;
      const now = new Date();
      if (!rows[0]) throw new Error("ENRICHMENT_LANES_NOT_MIGRATED");
      if (
        rows[0].leaseToken &&
        rows[0].leaseExpiresAt &&
        rows[0].leaseExpiresAt > now
      )
        return null;
      let job = await tx.igEnrichmentJob.findFirst({
        where: {
          priority: lane === "priority",
          nextAttemptAt: { lte: now },
          candidate: eligible,
          OR: [
            { status: { in: ["PENDING", "RETRY"] } },
            { status: "RUNNING", leaseExpiresAt: { lte: now } },
          ],
        },
        include: { candidate: true },
        orderBy: [{ requestedAt: "asc" }, { candidateId: "asc" }],
      });
      if (!job && lane === "background" && this.backgroundEnabled) {
        const c = await tx.candidate.findFirst({
          where: {
            AND: [
              igEligible,
              {
                OR: [
                  { profileSyncedAt: null },
                  { positionCode: null },
                  { citizenship: null },
                  { previousDocumentsSyncedAt: null },
                ],
              },
              {
                OR: [
                  { profileSyncNextAttemptAt: null },
                  { profileSyncNextAttemptAt: { lte: now } },
                ],
              },
              {
                OR: [
                  { enrichmentJob: null },
                  { enrichmentJob: { status: "READY" } },
                ],
              },
            ],
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        });
        if (c) {
          // An interactive request may have appeared since candidate discovery.
          // Only create a missing job or requeue an idle READY job; never reset a lease.
          await tx.igEnrichmentJob.createMany({
            data: [{ candidateId: c.id }],
            skipDuplicates: true,
          });
          await tx.igEnrichmentJob.updateMany({
            where: { candidateId: c.id, status: "READY" },
            data: {
              status: "PENDING",
              requestedAt: now,
              nextAttemptAt: now,
            },
          });
          job = await tx.igEnrichmentJob.findUnique({
            where: { candidateId: c.id },
            include: { candidate: true },
          });
          if (job?.priority) return null;
        }
      }
      if (!job) return null;

      // In background lane, if the candidate is RU, batch up to 50 ready RU candidates.
      if (
        lane === "background" &&
        job.candidate &&
        candidateReviewGroup(job.candidate) === "RU" &&
        job.candidate.erpUid
      ) {
        const batchJobs = await tx.igEnrichmentJob.findMany({
          where: {
            priority: false,
            nextAttemptAt: { lte: now },
            candidate: {
              erpUid: { not: null },
              AND: [reviewGroupWhere("RU")],
            },
            OR: [
              { status: { in: ["PENDING", "RETRY"] } },
              { status: "RUNNING", leaseExpiresAt: { lte: now } },
            ],
          },
          include: { candidate: true },
          orderBy: [{ requestedAt: "asc" }, { candidateId: "asc" }],
          take: 50,
        });
        const expires = new Date(Date.now() + LEASE_MS);
        const claimed = await tx.igEnrichmentJob.updateMany({
          where: {
            candidateId: { in: batchJobs.map((j) => j.candidateId) },
            priority: false,
            OR: [
              { status: { in: ["PENDING", "RETRY"] } },
              { status: "RUNNING", leaseExpiresAt: { lte: now } },
            ],
          },
          data: { status: "RUNNING", leaseToken: token, leaseExpiresAt: expires },
        });
        if (!claimed.count) return null;
        await tx.igEnrichmentLane.update({
          where: { id: lane },
          data: { leaseToken: token, leaseExpiresAt: expires },
        });
        return { kind: "ru-batch", jobs: batchJobs, token, lane };
      }

      // A promoted background job can be seen by both lanes; CAS protects its owner.
      const expires = new Date(Date.now() + LEASE_MS);
      const claimed = await tx.igEnrichmentJob.updateMany({
        where: {
          candidateId: job.candidateId,
          priority: lane === "priority",
          OR: [
            { status: { in: ["PENDING", "RETRY"] } },
            { status: "RUNNING", leaseExpiresAt: { lte: now } },
          ],
        },
        data: { status: "RUNNING", leaseToken: token, leaseExpiresAt: expires },
      });
      if (!claimed.count) return null;
      await tx.igEnrichmentLane.update({
        where: { id: lane },
        data: { leaseToken: token, leaseExpiresAt: expires },
      });
      return { kind: "single", job, token, lane };
    });
  }

  private async runErpChanges(): Promise<boolean> {
    if (!this.erpChanges || this.stopping) return false;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await this.erpChanges.run(controller.signal);
    } finally {
      this.controllers.delete(controller);
    }
  }

  async runLane(lane: "priority" | "background"): Promise<void> {
    if (lane === "background" && this.preferErpChanges && await this.runErpChanges()) {
      this.preferErpChanges = false;
      return;
    }
    if (lane === "background") this.preferErpChanges = true;
    const claim = await this.claim(lane);
    if (!claim) {
      if (lane === "background") await this.runErpChanges();
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 600_000);

    if (claim.kind === "ru-batch") {
      const candidateIds = claim.jobs.map((j) => j.candidateId);
      const assertLease = async (
        candidateId: string,
        client?: Prisma.TransactionClient,
      ) => {
        controller.signal.throwIfAborted();
        const db = client ?? this.prisma;
        const rows = await db.$queryRaw<
          { leaseToken: string | null; leaseExpiresAt: Date | null }[]
        >`
          SELECT leaseToken,leaseExpiresAt FROM ig_enrichment_jobs WHERE candidateId=${candidateId} FOR UPDATE`;
        if (
          rows[0]?.leaseToken !== claim.token ||
          !rows[0].leaseExpiresAt ||
          rows[0].leaseExpiresAt <= new Date()
        )
          throw new Error("ENRICHMENT_LEASE_LOST");
      };
      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void this.prisma
          .$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM ig_enrichment_lanes WHERE id=${lane} FOR UPDATE`;
            const now = new Date(),
              expires = new Date(Date.now() + LEASE_MS);
            const count = await tx.igEnrichmentJob.updateMany({
              where: {
                candidateId: { in: candidateIds },
                leaseToken: claim.token,
                leaseExpiresAt: { gt: now },
              },
              data: { leaseExpiresAt: expires },
            });
            if (count.count === 0) throw new Error("ENRICHMENT_LEASE_LOST");
            const laneCount = await tx.igEnrichmentLane.updateMany({
              where: {
                id: lane,
                leaseToken: claim.token,
                leaseExpiresAt: { gt: now },
              },
              data: { leaseExpiresAt: expires },
            });
            if (laneCount.count !== 1) throw new Error("ENRICHMENT_LEASE_LOST");
          })
          .catch(() => controller.abort())
          .finally(() => {
            heartbeatRunning = false;
          });
      }, 30_000);
      heartbeat.unref();

      const succeeded = new Set<string>();
      try {
        const candidatesWithErp = claim.jobs.filter(
          (j) =>
            j.candidate?.erpUid && uuid.safeParse(j.candidate.erpUid).success,
        );
        let batchResult: z.infer<typeof previousDocumentsBatchSchema> | null =
          null;
        if (
          candidatesWithErp.length &&
          typeof this.erp.personDocumentsBatch === "function"
        ) {
          try {
            batchResult = await this.erp.personDocumentsBatch(
              candidatesWithErp.map((j) => j.candidate.erpUid!),
              controller.signal,
            );
          } catch (error) {
            this.logger.warn(
              `ERP personDocumentsBatch failed in background: ${error}`,
            );
          }
        }

        for (const job of claim.jobs) {
          controller.signal.throwIfAborted();
          const erpUid = job.candidate?.erpUid?.toLowerCase();
          if (!erpUid) {
            continue;
          }

          // If personDocumentsBatch threw and batchResult is null, do not bombard ERP with 50 single requests.
          if (
            batchResult === null &&
            typeof this.erp.personDocumentsBatch === "function"
          ) {
            continue;
          }

          const batchItem = batchResult?.items.find(
            (item) => item.candidateUid.toLowerCase() === erpUid,
          );

          if (!batchItem || "error" in batchItem || !("documents" in batchItem)) {
            continue;
          }

          const preloadedDocuments = batchItem.documents;

          try {
            const result = await this.enrichment.enrichCandidate(
              job.candidateId,
              {
                signal: controller.signal,
                assertLease: (tx) => assertLease(job.candidateId, tx),
                preloadedDocuments,
              },
            );
            if (result.profileSynced && result.documentsSynced) {
              succeeded.add(job.candidateId);
            }
          } catch (error) {
            this.logger.warn(
              `Employee enrichment pending (${job.candidateId}); retry scheduled: ${error}`,
            );
          }
        }
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        this.controllers.delete(controller);
        const now = new Date();
        const settled: RuEnrichmentItem[] = [];
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM ig_enrichment_lanes WHERE id=${lane} FOR UPDATE`;
          for (const job of claim.jobs) {
            const complete = succeeded.has(job.candidateId);
            const attempts = complete ? 0 : job.attempts + 1;
            const retryAt = new Date(
              Date.now() +
                Math.min(30_000 * 2 ** Math.min(attempts - 1, 6), 600_000),
            );
            const updated = await tx.igEnrichmentJob.updateMany({
              where: {
                candidateId: job.candidateId,
                leaseToken: claim.token,
                leaseExpiresAt: { gt: now },
              },
              data: {
                status: complete ? "READY" : "RETRY",
                attempts,
                nextAttemptAt: retryAt,
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
            if (updated.count) {
              await tx.candidate.update({
                where: { id: job.candidateId },
                data: {
                  profileSyncAttempts: attempts,
                  profileSyncNextAttemptAt: complete ? null : retryAt,
                },
              });
              settled.push({
                candidateId: job.candidateId,
                status: complete ? "READY" : "RETRY",
                retryAt: complete ? null : retryAt.toISOString(),
              });
            }
          }
          await tx.igEnrichmentLane.updateMany({
            where: { id: lane, leaseToken: claim.token },
            data: { leaseToken: null, leaseExpiresAt: null },
          });
        });
        if (settled.length > 0 && this.notifications) {
          await this.notifications.publish({ items: settled });
        }
      }
      return;
    }

    const job = claim.job;
    const assertLease = async (client?: Prisma.TransactionClient) => {
      controller.signal.throwIfAborted();
      const db = client ?? this.prisma;
      const rows = await db.$queryRaw<
        { leaseToken: string | null; leaseExpiresAt: Date | null }[]
      >`
        SELECT leaseToken,leaseExpiresAt FROM ig_enrichment_jobs WHERE candidateId=${job.candidateId} FOR UPDATE`;
      if (
        rows[0]?.leaseToken !== claim.token ||
        !rows[0].leaseExpiresAt ||
        rows[0].leaseExpiresAt <= new Date()
      )
        throw new Error("ENRICHMENT_LEASE_LOST");
    };
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void this.prisma
        .$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM ig_enrichment_lanes WHERE id=${lane} FOR UPDATE`;
          const now = new Date(),
            expires = new Date(Date.now() + LEASE_MS);
          const count = await tx.igEnrichmentJob.updateMany({
            where: {
              candidateId: job.candidateId,
              leaseToken: claim.token,
              leaseExpiresAt: { gt: now },
            },
            data: { leaseExpiresAt: expires },
          });
          if (count.count !== 1) throw new Error("ENRICHMENT_LEASE_LOST");
          const laneCount = await tx.igEnrichmentLane.updateMany({
            where: {
              id: lane,
              leaseToken: claim.token,
              leaseExpiresAt: { gt: now },
            },
            data: { leaseExpiresAt: expires },
          });
          if (laneCount.count !== 1) throw new Error("ENRICHMENT_LEASE_LOST");
        })
        .catch(() => controller.abort())
        .finally(() => {
          heartbeatRunning = false;
        });
    }, 30_000);
    heartbeat.unref();
    let complete = false;
    try {
      const result = await this.enrichment.enrichCandidate(job.candidateId, {
        signal: controller.signal,
        assertLease,
      });
      complete = result.profileSynced && result.documentsSynced;
    } catch {
      this.logger.warn(
        `Employee enrichment pending (${job.candidateId}); retry scheduled`,
      );
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.controllers.delete(controller);
      const attempts = complete ? 0 : job.attempts + 1;
      const retryAt = new Date(
        Date.now() + Math.min(30_000 * 2 ** Math.min(attempts - 1, 6), 600_000),
      );
      let settled = false;
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM ig_enrichment_lanes WHERE id=${lane} FOR UPDATE`;
        const updated = await tx.igEnrichmentJob.updateMany({
          where: {
            candidateId: job.candidateId,
            leaseToken: claim.token,
            leaseExpiresAt: { gt: new Date() },
          },
          data: {
            status: complete ? "READY" : "RETRY",
            attempts,
            nextAttemptAt: retryAt,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (updated.count) {
          settled = true;
          await tx.candidate.update({
            where: { id: job.candidateId },
            data: {
              profileSyncAttempts: attempts,
              profileSyncNextAttemptAt: complete ? null : retryAt,
            },
          });
        }
        await tx.igEnrichmentLane.updateMany({
          where: { id: lane, leaseToken: claim.token },
          data: { leaseToken: null, leaseExpiresAt: null },
        });
      });
      if (
        settled &&
        job.candidate &&
        candidateReviewGroup(job.candidate) === "RU" &&
        this.notifications
      ) {
        await this.notifications.publish({
          items: [
            {
              candidateId: job.candidateId,
              status: complete ? "READY" : "RETRY",
              retryAt: complete ? null : retryAt.toISOString(),
            },
          ],
        });
      }
    }
  }
}
