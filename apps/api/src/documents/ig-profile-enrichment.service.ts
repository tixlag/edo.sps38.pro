import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ErpCandidateClient } from "./erp-candidate.client";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { CandidateWorkspaceService } from "../communications/candidate-workspace.service";
import { snapshotUpdateInput } from "./candidate-profile";

interface FailureState {
  attempts: number;
  retryAfter: number;
}

@Injectable()
export class IgProfileEnrichmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgProfileEnrichmentService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly failures = new Map<string, FailureState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly erp: ErpWorkspaceClient,
    private readonly config: ConfigService,
    @Optional() private readonly candidates?: ErpCandidateClient,
    @Optional() private readonly workspace?: CandidateWorkspaceService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>("EDO_ARRIVAL_SYNC_ENABLED") !== "true") return;
    const tick = () =>
      void this.sync().catch((err) =>
        this.logger.warn(`IG profile enrichment tick failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    // Initial run after short delay to let server boot
    setTimeout(tick, 5_000);
    this.timer = setInterval(tick, 30_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  sync(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    const candidates = await this.prisma.candidate.findMany({
      where: {
        reviewGroup: "IG",
        code1c: { not: null },
        personUid: { not: null },
        chatUuid: null,
        OR: [
          { profileSyncedAt: null },
          { positionCode: null },
          { previousDocumentsSyncedAt: null },
        ],
      },
      take: 20,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    });

    const now = Date.now();
    for (const candidate of candidates) {
      const failure = this.failures.get(candidate.id);
      if (failure && now < failure.retryAfter) {
        continue;
      }

      try {
        await this.enrichCandidate(candidate.id);
        this.failures.delete(candidate.id);
      } catch (error) {
        const attempts = (failure?.attempts ?? 0) + 1;
        // Bounded backoff: 30s, 60s, 120s, up to 600s max
        const backoffMs = Math.min(30_000 * Math.pow(2, attempts - 1), 600_000);
        this.failures.set(candidate.id, {
          attempts,
          retryAfter: now + backoffMs,
        });
        this.logger.warn(
          `Enrichment failed for candidate ${candidate.id} (attempt ${attempts}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async enrichCandidate(candidateId: string): Promise<{ profileSynced: boolean; documentsSynced: boolean }> {
    const candidate = await this.prisma.candidate.findUniqueOrThrow({
      where: { id: candidateId },
    });

    if (
      candidate.reviewGroup !== "IG" ||
      !candidate.code1c ||
      !candidate.personUid ||
      candidate.chatUuid
    ) {
      return { profileSynced: false, documentsSynced: false };
    }

    let profileSynced = false;
    let documentsSynced = false;

    // Step 1: Profile enrichment if not synced or position missing
    if (!candidate.profileSyncedAt || !candidate.positionCode) {
      if (this.candidates) {
        const identity = await this.erp.identity(candidate.code1c);
        if (
          identity.reviewGroup !== "IG" ||
          identity.recipientType !== "person" ||
          identity.code1C !== candidate.code1c ||
          identity.personUid?.toLowerCase() !== candidate.personUid.toLowerCase()
        ) {
          throw new Error("ERP_PERSON_IDENTITY_MISMATCH");
        }

        const snapshot = await this.candidates.findByEmployeeCode(
          candidate.code1c,
          AbortSignal.timeout(10_000),
        );

        const candidateCode1C = (snapshot as { code1C?: string; code1c?: string }).code1C ?? (snapshot as { code1C?: string; code1c?: string }).code1c;
        if (candidateCode1C && candidateCode1C !== candidate.code1c) {
          throw new Error("ERP_PROFILE_CODE_MISMATCH");
        }

        const updateData = snapshotUpdateInput(snapshot);
        if (updateData) {
          // Rule: Never treat defaulted ru citizenship as confirmed for IG candidate
          if (updateData.citizenship?.toLowerCase() === "ru" || snapshot.citizenshipProvided === false) {
            delete updateData.citizenship;
          }

          await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${candidateId} FOR UPDATE`;
            const current = await tx.candidate.findUniqueOrThrow({
              where: { id: candidateId },
            });
            if (
              current.reviewGroup !== "IG" ||
              current.code1c !== candidate.code1c ||
              current.personUid !== candidate.personUid
            ) {
              throw new Error("ERP_PERSON_IDENTITY_MISMATCH");
            }

            await tx.candidate.update({
              where: { id: candidateId },
              data: {
                ...updateData,
                profileSyncedAt: new Date(),
              },
            });

            await this.audit.logInTransaction(tx, {
              actorId: "system:profile-enrichment",
              action: "DATA_IMPORTED",
              entityType: "Candidate",
              entityId: candidateId,
              after: {
                profileSyncedAt: true,
                positionCode: updateData.positionCode ?? current.positionCode,
              },
            });
          });
          profileSynced = true;
        }
      }
    } else {
      profileSynced = true;
    }

    // Step 2: Document history enrichment if not synced
    if (!candidate.previousDocumentsSyncedAt && this.workspace) {
      await this.workspace.syncPreviousDocumentsInternal(
        candidateId,
        "system:profile-enrichment",
      );
      documentsSynced = true;
    } else if (candidate.previousDocumentsSyncedAt) {
      documentsSynced = true;
    }

    return { profileSynced, documentsSynced };
  }
}
