import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
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
import { CandidateEnrichmentDto } from "./dto/candidate-enrichment.dto";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichment: IgProfileEnrichmentService,
    private readonly access: DocumentAccessService,
    private readonly config: ConfigService,
  ) {}
  private get backgroundEnabled(): boolean {
    return this.config.get<string>("EDO_ARRIVAL_SYNC_ENABLED") === "true";
  }
  onModuleInit() {
    const tick = () => {
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
    // One scoped read for the visible page; never fan out to ERP in an HTTP request.
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
      select: { id: true, previousDocumentsSyncedAt: true },
    });
    const cutoff = Date.now() - 5 * 60_000;
    const staleIds = candidates
      .filter(
        (c) =>
          !c.previousDocumentsSyncedAt ||
          c.previousDocumentsSyncedAt.getTime() < cutoff,
      )
      .map((c) => c.id);
    if (staleIds.length) {
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

  private async claim(lane: "priority" | "background") {
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
          });
          if (job?.priority) return null;
        }
      }
      if (!job) return null;
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
      return { ...job, token, lane };
    });
  }
  async runLane(lane: "priority" | "background"): Promise<void> {
    const job = await this.claim(lane);
    if (!job) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 600_000);
    const assertLease = async (client?: Prisma.TransactionClient) => {
      controller.signal.throwIfAborted();
      const db = client ?? this.prisma;
      const rows = await db.$queryRaw<
        { leaseToken: string | null; leaseExpiresAt: Date | null }[]
      >`
        SELECT leaseToken,leaseExpiresAt FROM ig_enrichment_jobs WHERE candidateId=${job.candidateId} FOR UPDATE`;
      if (
        rows[0]?.leaseToken !== job.token ||
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
              leaseToken: job.token,
              leaseExpiresAt: { gt: now },
            },
            data: { leaseExpiresAt: expires },
          });
          if (count.count !== 1) throw new Error("ENRICHMENT_LEASE_LOST");
          const laneCount = await tx.igEnrichmentLane.updateMany({
            where: {
              id: lane,
              leaseToken: job.token,
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
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM ig_enrichment_lanes WHERE id=${lane} FOR UPDATE`;
        const updated = await tx.igEnrichmentJob.updateMany({
          where: {
            candidateId: job.candidateId,
            leaseToken: job.token,
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
        if (updated.count)
          await tx.candidate.update({
            where: { id: job.candidateId },
            data: {
              profileSyncAttempts: attempts,
              profileSyncNextAttemptAt: complete ? null : retryAt,
            },
          });
        await tx.igEnrichmentLane.updateMany({
          where: { id: lane, leaseToken: job.token },
          data: { leaseToken: null, leaseExpiresAt: null },
        });
      });
    }
  }
}
