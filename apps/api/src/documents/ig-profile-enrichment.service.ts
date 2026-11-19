import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ErpCandidateClient, normalizeErpCandidate } from "./erp-candidate.client";
import { erpIdentitySchema } from "./erp-workspace.client";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { CandidatePreviousDocumentsSyncService } from "./candidate-previous-documents-sync.service";
import type { Prisma } from "@prisma/client";
import { candidateReviewGroup } from "./review-group";
import { snapshotUpdateInput } from "./candidate-profile";

@Injectable()
export class IgProfileEnrichmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly erp: ErpWorkspaceClient,
    _config: ConfigService,
    private readonly candidates: ErpCandidateClient,
    private readonly previousDocsSync: CandidatePreviousDocumentsSyncService,
  ) {}

  async enrichCandidate(
    candidateId: string,
    options?: {
      signal?: AbortSignal;
      assertLease?: (tx?: Prisma.TransactionClient) => Promise<void>;
      preloadedDocuments?: unknown;
      preloadedIdentity?: unknown;
      preloadedProfile?: unknown;
      preloadedEmploymentHistory?: unknown;
      forceRefresh?: boolean;
      refreshProfile?: boolean;
      refreshDocuments?: boolean;
    },
  ): Promise<{ profileSynced: boolean; documentsSynced: boolean }> {
    const candidate = await this.prisma.candidate.findUniqueOrThrow({
      where: { id: candidateId },
    });

    // RU documents belong to the candidate UUID, before any person/employee link exists.
    if (candidateReviewGroup(candidate) === "RU") {
      if (!candidate.erpUid)
        return { profileSynced: false, documentsSynced: false };
      await this.previousDocsSync.syncPreviousDocuments(
        candidateId,
        "system:profile-enrichment",
        "",
        candidate,
        undefined,
        options,
      );
      return { profileSynced: true, documentsSynced: true };
    }

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
    const targeted = options?.refreshProfile !== undefined || options?.refreshDocuments !== undefined;
    if (targeted && (options?.refreshProfile || options?.refreshDocuments) && options.preloadedIdentity === undefined)
      throw new Error("ERP_BATCH_IDENTITY_REQUIRED");
    if (targeted && options?.refreshProfile && options.preloadedProfile === undefined)
      throw new Error("ERP_BATCH_PROFILE_REQUIRED");
    if (targeted && options?.refreshDocuments && (options.preloadedDocuments === undefined || options.preloadedEmploymentHistory === undefined))
      throw new Error("ERP_BATCH_DOCUMENTS_REQUIRED");

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
    if (options?.refreshProfile || options?.forceRefresh || (!targeted && !isProfileComplete(candidate))) {
      if (this.candidates) {
        const identity = options?.preloadedIdentity !== undefined
          ? erpIdentitySchema.parse(options.preloadedIdentity)
          : await this.erp.identity(candidate.code1c, options?.signal);
        if (
          identity.reviewGroup !== "IG" ||
          identity.recipientType !== "person" ||
          identity.code1C !== candidate.code1c ||
          identity.personUid?.toLowerCase() !==
            candidate.personUid.toLowerCase()
        ) {
          throw new Error("ERP_PERSON_IDENTITY_MISMATCH");
        }

        const snapshot = options?.preloadedProfile !== undefined
          ? normalizeErpCandidate(options.preloadedProfile, undefined, candidate.code1c)
          : await this.candidates
              .findByEmployeeCode(candidate.code1c, options?.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
                : AbortSignal.timeout(10_000))
              .catch(() => { options?.signal?.throwIfAborted(); return undefined; });

        const candidateCode1C =
          snapshot &&
          ((snapshot as { code1C?: string; code1c?: string }).code1C ??
            (snapshot as { code1C?: string; code1c?: string }).code1c);
        if (candidateCode1C && candidateCode1C !== candidate.code1c) {
          throw new Error("ERP_PROFILE_CODE_MISMATCH");
        }

        const updateData = snapshot ? snapshotUpdateInput(snapshot) : undefined;
        if (updateData) {
          // Rule: Never treat defaulted ru citizenship as confirmed for IG candidate
          if (
            updateData.citizenship?.toLowerCase() === "ru" ||
            snapshot?.citizenshipProvided === false
          ) {
            delete updateData.citizenship;
          }

          await this.prisma.$transaction(async (tx) => {
            await options?.assertLease?.(tx);
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

            const effectiveCitizenship =
              updateData.citizenship ?? current.citizenship;
            const effectivePositionCode =
              updateData.positionCode ?? current.positionCode;
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
    if (options?.refreshDocuments || options?.forceRefresh || (!targeted && !candidate.previousDocumentsSyncedAt)) {
      if (options)
        await this.previousDocsSync.syncPreviousDocuments(
          candidateId,
          "system:profile-enrichment",
          "",
          undefined,
          undefined,
          options,
        );
      else
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
