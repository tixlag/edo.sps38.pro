import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Candidate, ErpChangeInbox, Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.module";
import { CandidateCatalogProjectionService } from "./candidate-catalog-projection.service";
import {
  ErpChangeInboxService,
  pendingCategories,
  type ErpChangeCategory,
} from "./erp-change-inbox";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { IgArrivalFactsProjectionService } from "./ig-arrival-facts-projection.service";
import { IgArrivalProjectionService } from "./ig-arrival-projection.service";
import { IgArrivalSyncWorker } from "./ig-arrival-sync.worker";
import { IgProfileEnrichmentService } from "./ig-profile-enrichment.service";
import { publishReviewChanges } from "./review-change-notifications";
import { candidateReviewGroup } from "./review-group";

const LEASE_MS = 120_000;
const MAINTENANCE_INTERVAL = 30_000;

type Settlement = {
  applied: Set<ErpChangeCategory>;
  deferred: Set<ErpChangeCategory>;
  candidateId?: string;
  retryWidth?: number;
};
type LeaseCheck = (tx?: Prisma.TransactionClient) => Promise<void>;
type ResourceBatch<T> = { items: T[] };
type CandidateProfileItem = Awaited<
  ReturnType<ErpWorkspaceClient["candidateProfilesBatch"]>
>["items"][number];

function isCandidateTombstone(item: CandidateProfileItem) {
  return (
    "deleted" in item ||
    ("profile" in item &&
      item.profile.erpUid.toLowerCase() === item.candidateUid.toLowerCase() &&
      item.profile.deleted)
  );
}

async function batchOrEmpty<T>(
  ids: readonly unknown[],
  read: () => Promise<ResourceBatch<T>>,
): Promise<T[]> {
  if (!ids.length) return [];
  try {
    return (await read()).items;
  } catch {
    // Missing snapshots stay pending. Another kind of data can still settle.
    return [];
  }
}

async function processItems<T>(items: T[], apply: (item: T) => Promise<void>) {
  const pending = [...items];
  const work = async () => {
    for (;;) {
      const item = pending.shift();
      if (!item) return;
      await apply(item);
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(4, items.length) }, work),
  );
}

@Injectable()
export class ErpEventSyncService {
  private readonly logger = new Logger(ErpEventSyncService.name);
  private readonly exporter: IgArrivalSyncWorker;
  private maintenance?: Promise<void>;
  private exportingArrivals?: Promise<void>;
  private nextMaintenance = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: ErpChangeInboxService,
    private readonly erp: ErpWorkspaceClient,
    private readonly projection: CandidateCatalogProjectionService,
    private readonly arrivals: IgArrivalFactsProjectionService,
    private readonly enrichment: IgProfileEnrichmentService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    legacyArrivals: IgArrivalProjectionService,
  ) {
    this.exporter = new IgArrivalSyncWorker(
      prisma,
      erp,
      legacyArrivals,
      config,
      audit,
    );
  }

  private get enabled() {
    return ["verify", "events"].includes(
      this.config.get("ERP_CHANGE_SYNC_MODE") ?? "",
    );
  }

  // This runs on the existing queue's background tick, including when ERP is down.
  maintenanceTick(): void {
    if (!this.enabled || this.maintenance || Date.now() < this.nextMaintenance)
      return;
    this.nextMaintenance = Date.now() + MAINTENANCE_INTERVAL;
    this.maintenance = Promise.allSettled([
      this.inbox.resumeLinkedPeople(),
      this.exportArrivals(),
      this.publishPending(),
    ])
      .then((results) => {
        if (results.some((result) => result.status === "rejected"))
          this.logger.warn("ERP event delivery maintenance will retry");
      })
      .finally(() => {
        this.maintenance = undefined;
      });
  }

  private exportArrivals(): Promise<void> {
    return (this.exportingArrivals ??= this.exporter
      .exportPending(Date.now() + 20_000)
      .finally(() => {
        this.exportingArrivals = undefined;
      }));
  }

  async run(signal: AbortSignal): Promise<boolean> {
    if (!this.enabled) return false;
    const token = randomUUID();
    const rows = await this.prisma.$transaction(async (tx) => {
      // The existing background lane is shared with legacy and reconciliation jobs.
      const now = new Date();
      const due = await this.inbox.due(tx);
      if (!due.length) return [];
      const claim = await tx.igEnrichmentLane.updateMany({
        where: {
          id: "background",
          OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        },
      });
      if (!claim.count) return [];
      const first = due[0];
      return due
        .filter(
          (row) =>
            row.target === first.target && row.batchWidth === first.batchWidth,
        )
        .slice(0, first.batchWidth);
    });
    if (!rows.length) return false;
    const runAbort = new AbortController();
    const workSignal = AbortSignal.any([
      signal,
      runAbort.signal,
      AbortSignal.timeout(600_000),
    ]);
    const assertLease: LeaseCheck = async (tx = this.prisma) => {
      workSignal.throwIfAborted();
      const [row] = await tx.$queryRaw<
        Array<{ leaseToken: string | null; leaseExpiresAt: Date | null }>
      >`
        SELECT leaseToken, leaseExpiresAt FROM ig_enrichment_lanes WHERE id = 'background' FOR UPDATE
      `;
      if (
        row?.leaseToken !== token ||
        !row.leaseExpiresAt ||
        row.leaseExpiresAt <= new Date()
      )
        throw new Error("ERP_CHANGE_LEASE_LOST");
    };
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.prisma
        .$transaction(async (tx) => {
          const now = new Date(),
            leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
          const renewed = await tx.igEnrichmentLane.updateMany({
            where: {
              id: "background",
              leaseToken: token,
              leaseExpiresAt: { gt: now },
            },
            data: { leaseExpiresAt },
          });
          if (!renewed.count) throw new Error("ERP_CHANGE_LEASE_LOST");
          await tx.igEnrichmentJob.updateMany({
            where: { leaseToken: token, leaseExpiresAt: { gt: now } },
            data: { leaseExpiresAt },
          });
        })
        .catch(() => runAbort.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, MAINTENANCE_INTERVAL);
    heartbeat.unref();
    try {
      if (rows[0].target === "PERSON")
        await this.processPeople(rows, token, workSignal, assertLease);
      else await this.processCandidates(rows, token, workSignal, assertLease);
      await this.publishPending();
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await this.prisma.igEnrichmentLane.updateMany({
        where: { id: "background", leaseToken: token },
        data: { leaseToken: null, leaseExpiresAt: null },
      });
    }
    return true;
  }

  private newSettlement(): Settlement {
    return { applied: new Set(), deferred: new Set() };
  }

  private async publishPending() {
    const rows = await this.inbox.notifications();
    if (!rows.length) return;
    const published = await publishReviewChanges(
      this.redis,
      rows.map((row) => ({
        group: row.target === "PERSON" ? "IG" : "RU",
        candidateId: row.notifyCandidateId ?? undefined,
      })),
    );
    if (published) await this.inbox.acknowledgeNotifications(rows);
  }

  private async processCandidates(
    rows: ErpChangeInbox[],
    token: string,
    signal: AbortSignal,
    assertLease: LeaseCheck,
  ) {
    const existing = await this.prisma.candidate.findMany({
      where: { erpUid: { in: rows.map((row) => row.uid) } },
    });
    const owners = new Map(
      existing.map((row) => [row.erpUid?.toLowerCase(), row]),
    );
    const profileUids = rows
      .filter((row) => row.profileRevision || !owners.has(row.uid))
      .map((row) => row.uid);
    const documentUids = rows
      .filter((row) => row.documentsRevision)
      .map((row) => row.uid);
    const { profiles, projected } = await this.projectCandidateProfiles(
      profileUids,
      token,
      signal,
      assertLease,
    );
    const documents = await batchOrEmpty(documentUids, () =>
      this.erp.personDocumentsBatch(documentUids, signal),
    );
    const profileByUid = new Map(
      profiles.map((item) => [item.candidateUid.toLowerCase(), item]),
    );
    const docsByUid = new Map(
      documents.map((item) => [item.candidateUid.toLowerCase(), item]),
    );

    await processItems(rows, async (row) => {
      signal.throwIfAborted();
      const result = this.newSettlement();
      try {
        const profile = profileByUid.get(row.uid);
        const docs = docsByUid.get(row.uid);
        if (
          (profile &&
            "error" in profile &&
            profile.error.code === "ERP_BATCH_SIZE_OR_TIMEOUT") ||
          (docs &&
            "error" in docs &&
            docs.error.code === "ERP_BATCH_SIZE_OR_TIMEOUT")
        )
          result.retryWidth = Math.max(1, Math.floor(rows.length / 2));
        const previous = owners.get(row.uid);
        if (profile && isCandidateTombstone(profile)) {
          result.candidateId = projected.get(row.uid) ?? previous?.id;
          result.applied = new Set(pendingCategories(row));
        } else {
          const projectedId = projected.get(row.uid);
          result.candidateId = projectedId ?? previous?.id;
          if (projectedId && row.profileRevision) result.applied.add("PROFILE");
          if (
            row.documentsRevision &&
            docs &&
            "documents" in docs &&
            result.candidateId
          ) {
            const owner = await this.prisma.candidate.findUnique({
              where: { id: result.candidateId },
            });
            if (
              owner?.erpUid?.toLowerCase() === row.uid &&
              !owner.erpDeleted &&
              candidateReviewGroup(owner) === "RU"
            ) {
              const complete = await this.withCardLease(
                owner,
                token,
                true,
                signal,
                (check) =>
                  this.enrichment.enrichCandidate(owner.id, {
                    signal,
                    assertLease: check,
                    preloadedDocuments: docs.documents,
                  }),
              );
              if (complete?.documentsSynced) result.applied.add("DOCUMENTS");
            }
          }
        }
      } catch {
        this.logger.warn("ERP candidate event remains pending");
      }
      await this.inbox
        .settle(row, result, assertLease)
        .catch(() =>
          this.logger.warn("ERP candidate event settlement will retry"),
        );
    });
  }

  private async projectCandidateProfiles(
    uids: string[],
    owner: string,
    signal: AbortSignal,
    assertLease: LeaseCheck,
  ) {
    const none = {
      profiles: [] as CandidateProfileItem[],
      projected: new Map<string, string>(),
    };
    if (uids.length === 0) return none;
    // Share the import lock through the network read and projection. A catalog
    // page begun before a change cannot overwrite a newer event projection.
    const lock = "edo:candidate-catalog:lock";
    try {
      if (!(await this.redis.setNxPxStrict(lock, owner, 60_000))) return none;
    } catch {
      // The document category remains independently processable.
      return none;
    }
    const lost = new AbortController();
    const profileSignal = AbortSignal.any([signal, lost.signal]);
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = this.redis
        .compareAndExpire(lock, owner, 60_000)
        .then((ok) => {
          if (!ok) lost.abort();
        })
        .catch(() => lost.abort())
        .finally(() => {
          renewing = undefined;
        });
    }, 20_000);
    heartbeat.unref();
    try {
      const profiles = await batchOrEmpty(uids, () =>
        this.erp.candidateProfilesBatch(uids, profileSignal),
      );
      profileSignal.throwIfAborted();
      const selected = profiles.flatMap((item) =>
        "profile" in item &&
        !item.profile.deleted &&
        item.profile.erpUid.toLowerCase() === item.candidateUid.toLowerCase()
          ? [item.profile]
          : [],
      );
      const applied = await this.projection.applyRows(selected, owner, {
        beforeWrite: async (tx) => {
          profileSignal.throwIfAborted();
          await assertLease(tx);
        },
        onConflict: () =>
          this.logger.warn("ERP event candidate identity conflict"),
      });
      // Confirmed tombstones use the same profile coordination lease.
      const deleted = profiles
        .filter(isCandidateTombstone)
        .map((item) => item.candidateUid.toLowerCase());
      if (deleted.length)
        await this.prisma.$transaction(async (tx) => {
          profileSignal.throwIfAborted();
          await assertLease(tx);
          const rows = await tx.candidate.findMany({
            where: { erpUid: { in: deleted }, erpDeleted: false },
            select: { id: true, erpUid: true },
          });
          for (const row of rows) {
            const changed = await tx.candidate.updateMany({
              where: { id: row.id, erpUid: row.erpUid, erpDeleted: false },
              data: { erpDeleted: true },
            });
            if (changed.count)
              await this.audit.logInTransaction(tx, {
                action: "DATA_IMPORTED",
                entityType: "CandidateCatalog",
                entityId: row.id,
                correlationId: owner,
                after: { erpDeleted: true },
              });
          }
        });
      return {
        profiles,
        projected: new Map(
          applied.map((item) => [item.erpUid.toLowerCase(), item.candidateId]),
        ),
      };
    } catch {
      this.logger.warn("ERP profile batch remains pending");
      return none;
    } finally {
      clearInterval(heartbeat);
      await renewing;
      await this.redis.compareAndDelStrict(lock, owner).catch(() => undefined);
    }
  }

  private async processPeople(
    rows: ErpChangeInbox[],
    token: string,
    signal: AbortSignal,
    assertLease: LeaseCheck,
  ) {
    const requested = rows.map((row) => ({
      personUid: row.uid,
      changes: pendingCategories(row),
    }));
    const items = await batchOrEmpty(requested, () =>
      this.erp.igPersonSnapshotBatch(requested, signal),
    );
    const byPerson = new Map(
      items.map((item) => [item.personUid.toLowerCase(), item]),
    );
    let appliedArrivals = false;
    await processItems(rows, async (row) => {
      signal.throwIfAborted();
      const result = this.newSettlement();
      try {
        const item = byPerson.get(row.uid);
        if (item && "deleted" in item) {
          await assertLease();
          const candidateId = await this.arrivals.applyTargetedDeletion(
            row.uid,
          );
          result.candidateId = candidateId ?? undefined;
          result.applied = new Set(pendingCategories(row));
          appliedArrivals = true;
        } else if (item && "identity" in item) {
          const identity = item.identity;
          if (
            identity.personUid?.toLowerCase() !== row.uid ||
            identity.reviewGroup !== "IG" ||
            identity.recipientType !== "person" ||
            identity.chatUuid ||
            identity.erpUid
          )
            throw new Error("ERP_PERSON_IDENTITY_MISMATCH");
          await assertLease();
          if (
            row.arrivalsRevision &&
            item.arrivals &&
            item.arrivalsComplete === true &&
            item.arrivals.personUid.toLowerCase() === row.uid &&
            item.arrivals.code1c === identity.code1C
          ) {
            await this.arrivals.applyTargeted(item.arrivals, identity, true);
            result.applied.add("ARRIVALS");
            appliedArrivals = true;
          }
          await this.prisma.igArrivalPerson.createMany({
            data: [
              {
                personUid: row.uid,
                code1c: identity.code1C,
                state: "NONE",
                igVerified: true,
                syncPending: false,
                sourcePayload: {},
                sourceHash: "",
              },
            ],
            skipDuplicates: true,
          });
          const person = await this.prisma.igArrivalPerson.findUniqueOrThrow({
            where: { personUid: row.uid },
            include: { candidate: true },
          });
          if (
            person.code1c !== identity.code1C ||
            person.bindingError ||
            !person.igVerified
          )
            throw new Error("ERP_PERSON_IDENTITY_CONFLICT");
          const owner = person.candidate;
          if (!owner) {
            if (row.profileRevision && item.profile)
              result.deferred.add("PROFILE");
            if (
              row.documentsRevision &&
              item.documents &&
              item.employmentHistory
            )
              result.deferred.add("DOCUMENTS");
          } else {
            if (
              owner.personUid !== row.uid ||
              owner.code1c !== identity.code1C ||
              owner.reviewGroup !== "IG" ||
              owner.erpUid ||
              owner.chatUuid
            )
              throw new Error("ERP_PERSON_IDENTITY_CONFLICT");
            result.candidateId = owner.id;
            const wantsProfile = !!(row.profileRevision && item.profile);
            const wantsDocuments = !!(
              row.documentsRevision &&
              item.documents &&
              item.employmentHistory
            );
            if (wantsProfile || wantsDocuments) {
              const complete = await this.withCardLease(
                owner,
                token,
                wantsDocuments,
                signal,
                (check) =>
                  this.enrichment.enrichCandidate(owner.id, {
                    signal,
                    assertLease: check,
                    refreshProfile: wantsProfile,
                    refreshDocuments: wantsDocuments,
                    preloadedIdentity: identity,
                    preloadedProfile: item.profile,
                    preloadedDocuments: item.documents,
                    preloadedEmploymentHistory: item.employmentHistory,
                  }),
              );
              if (wantsProfile && complete?.profileSynced)
                result.applied.add("PROFILE");
              if (wantsDocuments && complete?.documentsSynced)
                result.applied.add("DOCUMENTS");
            }
          }
        } else if (
          item &&
          "error" in item &&
          item.error.code === "ERP_BATCH_SIZE_OR_TIMEOUT"
        ) {
          result.retryWidth = Math.max(1, Math.floor(rows.length / 2));
        }
      } catch {
        this.logger.warn("ERP person event remains pending");
      }
      await this.inbox
        .settle(row, result, assertLease)
        .catch(() =>
          this.logger.warn("ERP person event settlement will retry"),
        );
    });
    if (appliedArrivals)
      void this.exportArrivals().catch(() =>
        this.logger.warn("Arrival context delivery will retry"),
      );
  }

  private async withCardLease(
    owner: Candidate,
    token: string,
    refreshDocuments: boolean,
    signal: AbortSignal,
    run: (
      assertLease: LeaseCheck,
    ) => Promise<{ profileSynced: boolean; documentsSynced: boolean }>,
  ) {
    const where = { candidateId: owner.id };
    const previous = await this.prisma.$transaction(async (tx) => {
      await tx.igEnrichmentJob.createMany({
        data: [where],
        skipDuplicates: true,
      });
      await tx.$queryRaw`SELECT candidateId FROM ig_enrichment_jobs WHERE candidateId = ${owner.id} FOR UPDATE`;
      const job = await tx.igEnrichmentJob.findUniqueOrThrow({ where });
      if (
        job.status === "RUNNING" &&
        job.leaseExpiresAt &&
        job.leaseExpiresAt > new Date()
      )
        return null;
      await tx.igEnrichmentJob.update({
        where,
        data: {
          status: "RUNNING",
          leaseToken: token,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        },
      });
      return job;
    });
    if (!previous) return undefined;
    const assertLease: LeaseCheck = async (tx = this.prisma) => {
      signal.throwIfAborted();
      const [job] = await tx.$queryRaw<
        Array<{ leaseToken: string | null; leaseExpiresAt: Date | null }>
      >`
        SELECT leaseToken, leaseExpiresAt FROM ig_enrichment_jobs WHERE candidateId = ${owner.id} FOR UPDATE
      `;
      if (
        job?.leaseToken !== token ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt <= new Date()
      )
        throw new Error("ERP_CHANGE_CARD_LEASE_LOST");
    };
    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
      result = await run(assertLease);
      return result;
    } finally {
      const ready =
        refreshDocuments && result?.documentsSynced && result.profileSynced;
      await this.prisma.igEnrichmentJob.updateMany({
        where: { ...where, leaseToken: token },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
          status: ready
            ? "READY"
            : previous.status === "RUNNING"
              ? "RETRY"
              : previous.status,
        },
      });
    }
  }
}
