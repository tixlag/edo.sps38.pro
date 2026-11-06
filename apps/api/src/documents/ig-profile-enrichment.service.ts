import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ErpCandidateClient } from "./erp-candidate.client";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { CandidatePreviousDocumentsSyncService } from "./candidate-previous-documents-sync.service";
import { snapshotUpdateInput } from "./candidate-profile";

@Injectable()
export class IgProfileEnrichmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgProfileEnrichmentService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly erp: ErpWorkspaceClient,
    private readonly config: ConfigService,
    private readonly candidates: ErpCandidateClient,
    private readonly previousDocsSync: CandidatePreviousDocumentsSyncService,
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
    const now = new Date();
    const candidates = await this.prisma.candidate.findMany({
      where: {
        reviewGroup: "IG",
        code1c: { not: null },
        personUid: { not: null },
        chatUuid: null,
        OR: [
          { profileSyncedAt: null },
          { positionCode: null },
          { citizenship: null },
          { previousDocumentsSyncedAt: null },
        ],
        AND: [
          {
            OR: [
              { profileSyncNextAttemptAt: null },
              { profileSyncNextAttemptAt: { lte: now } },
            ],
          },
        ],
      },
      take: 20,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    });

    for (const candidate of candidates) {
      try {
        const { profileSynced, documentsSynced } = await this.enrichCandidate(candidate.id);
        if (profileSynced && documentsSynced) {
          await this.prisma.candidate.update({
            where: { id: candidate.id },
            data: {
              profileSyncNextAttemptAt: null,
              profileSyncAttempts: 0,
            },
          });
        } else {
          const attempts = (candidate.profileSyncAttempts ?? 0) + 1;
          const backoffMs = Math.min(30_000 * Math.pow(2, Math.min(attempts - 1, 6)), 600_000);
          await this.prisma.candidate.update({
            where: { id: candidate.id },
            data: {
              profileSyncAttempts: attempts,
              profileSyncNextAttemptAt: new Date(Date.now() + backoffMs),
            },
          });
        }
      } catch (error) {
        const attempts = (candidate.profileSyncAttempts ?? 0) + 1;
        const backoffMs = Math.min(30_000 * Math.pow(2, Math.min(attempts - 1, 6)), 600_000);
        await this.prisma.candidate.update({
          where: { id: candidate.id },
          data: {
            profileSyncAttempts: attempts,
            profileSyncNextAttemptAt: new Date(Date.now() + backoffMs),
          },
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

    const isProfileComplete = (c: {
      citizenship: string | null;
      positionCode: string | null;
      profileSyncedAt: Date | null;
    }) => {
      return Boolean(
        c.profileSyncedAt &&
        c.positionCode &&
        c.citizenship &&
        c.citizenship.toLowerCase() !== "ru",
      );
    };

    // Step 1: Profile enrichment if profile is incomplete
    if (!isProfileComplete(candidate)) {
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

            const effectiveCitizenship = updateData.citizenship ?? current.citizenship;
            const effectivePositionCode = updateData.positionCode ?? current.positionCode;
            const profileComplete = Boolean(
              effectivePositionCode &&
              effectiveCitizenship &&
              effectiveCitizenship.toLowerCase() !== "ru",
            );

            await tx.candidate.update({
              where: { id: candidateId },
              data: {
                ...updateData,
                profileSyncedAt: profileComplete ? new Date() : null,
              },
            });

            await this.audit.logInTransaction(tx, {
              actorId: "system:profile-enrichment",
              action: "DATA_IMPORTED",
              entityType: "Candidate",
              entityId: candidateId,
              after: {
                profileSyncedAt: profileComplete,
                positionCode: effectivePositionCode,
                citizenship: effectiveCitizenship,
              },
            });
            profileSynced = profileComplete;
          });
        }
      }
    } else {
      profileSynced = true;
    }

    // Step 2: Document history enrichment if not synced
    if (!candidate.previousDocumentsSyncedAt) {
      await this.previousDocsSync.syncPreviousDocuments(
        candidateId,
        "system:profile-enrichment",
      );
      documentsSynced = true;
    } else {
      documentsSynced = true;
    }

    return { profileSynced, documentsSynced };
  }
}
