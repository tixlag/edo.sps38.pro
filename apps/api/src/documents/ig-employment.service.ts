import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { candidateReviewGroup } from "./review-group";
import { ErpCandidateClient } from "./erp-candidate.client";
import { candidateIdentityTransaction } from "./candidate-identity";

export interface IgGrantEvent {
  id: string;
  code1c?: string;
  employeeCode1c?: string;
  citizenship: string;
  createdAt?: string;
  personUid?: string;
  enabled?: boolean;
}

export type ApplyGrantResult = {
  candidateId: string | null;
  known: boolean;
};

export function grantPayloadFingerprint(payload: {
  code1c: string;
  citizenship?: string | null;
  personUid?: string | null;
  enabled?: boolean | null;
}): string {
  const normCode1c = (payload.code1c ?? "").trim();
  const normCitizenship = (payload.citizenship ?? "").trim().toLowerCase();
  const normPersonUid = (payload.personUid ?? "").trim().toLowerCase();
  const normEnabled = payload.enabled !== false;
  const canonical = `${normCode1c}|${normCitizenship}|${normPersonUid}|${normEnabled}`;
  return createHash("sha256").update(canonical).digest("hex");
}

@Injectable()
export class IgEmploymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly audit: AuditService,
    @Optional() private readonly candidates?: ErpCandidateClient,
  ) {}

  async applyGrant(event: IgGrantEvent): Promise<ApplyGrantResult> {
    const code1c = (event.employeeCode1c ?? event.code1c ?? "").trim();
    if (!code1c) throw new BadRequestException("EMPLOYEE_CODE1C_REQUIRED");

    const normCitizenship = (event.citizenship ?? "").trim().toLowerCase();
    const normPersonUid = (event.personUid ?? "").trim().toLowerCase() || null;
    const normEnabled = event.enabled !== false;
    const currentPayloadHash = grantPayloadFingerprint({
      code1c,
      citizenship: normCitizenship,
      personUid: normPersonUid,
      enabled: normEnabled,
    });

    const identity = await this.erp.identity(code1c);
    if (
      identity.reviewGroup !== "IG" ||
      identity.recipientType !== "person" ||
      !identity.personUid ||
      identity.code1C !== code1c ||
      (normPersonUid &&
        identity.personUid.toLowerCase() !== normPersonUid) ||
      normCitizenship === "ru"
    )
      throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
    const profile = await this.candidates
      ?.findByEmployeeCode(code1c, AbortSignal.timeout(10_000))
      .catch(() => undefined);
    const position =
      profile?.position && typeof profile.position === "object"
        ? profile.position
        : undefined;
    const hadDismissal =
      typeof this.erp.employmentHistory === "function"
        ? await this.erp
            .employmentHistory(code1c, identity.personUid)
            .then((history) =>
              history.items.some((item) => item.eventType === "DISMISSAL"),
            )
            .catch(() => false)
        : false;
    return candidateIdentityTransaction(this.prisma, async (tx) => {
      await tx.igEmploymentState.upsert({
        where: { code1c },
        create: { code1c },
        update: {},
      });
      await tx.$queryRaw`SELECT code1c FROM ig_employment_states WHERE code1c = ${code1c} FOR UPDATE`;
      const processed = await tx.igGrantEvent.findUnique({
        where: { id: event.id },
      });
      if (processed) {
        if (processed.payloadHash) {
          if (processed.payloadHash !== currentPayloadHash)
            throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
        } else {
          if (processed.code1c !== code1c)
            throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
          if (
            processed.personUid &&
            normPersonUid &&
            processed.personUid.toLowerCase() !== normPersonUid
          )
            throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
          if (
            processed.citizenship &&
            normCitizenship &&
            processed.citizenship.toLowerCase() !== normCitizenship
          )
            throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
          if (
            processed.enabled !== undefined &&
            processed.enabled !== null &&
            processed.enabled !== normEnabled
          )
            throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
          const existingCandidate =
            processed.candidateId && tx.candidate?.findUnique
              ? await tx.candidate.findUnique({
                  where: { id: processed.candidateId },
                })
              : null;
          if (
            existingCandidate &&
            normPersonUid &&
            existingCandidate.personUid &&
            existingCandidate.personUid.toLowerCase() !== normPersonUid
          )
            throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
          if (
            existingCandidate &&
            normCitizenship &&
            existingCandidate.citizenship &&
            existingCandidate.citizenship.toLowerCase() !== normCitizenship
          )
            throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
        }
        return {
          candidateId: processed.candidateId,
          known: Boolean(processed.candidateId),
        };
      }
      const state = await tx.igEmploymentState.findUniqueOrThrow({
        where: { code1c },
        include: { currentCandidate: true },
      });
      let current = state.currentCandidate;
      if (current) {
        await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${current.id} FOR UPDATE`;
        current = await tx.candidate.findUniqueOrThrow({
          where: { id: current.id },
        });
      }
      if (
        current &&
        (candidateReviewGroup(current) !== "IG" ||
          current.code1c !== code1c ||
          (current.personUid && current.personUid !== identity.personUid) ||
          (normPersonUid &&
            current.personUid &&
            current.personUid.toLowerCase() !== normPersonUid))
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      if (event.enabled === false) {
        if (current) {
          await tx.igGrantEvent.create({
            data: {
              id: event.id,
              code1c,
              candidateId: current.id,
              personUid: normPersonUid,
              citizenship: normCitizenship,
              enabled: false,
              payloadHash: currentPayloadHash,
            },
          });
          await this.audit.logInTransaction(tx, {
            actorId: "system:adaptation",
            action: "DATA_IMPORTED",
            entityType: "Candidate",
            entityId: current.id,
            correlationId: event.id,
            after: { source: "ADAPTATION_ACCESS", enabled: false },
          });
          return { candidateId: current.id, known: true };
        }
        await tx.igGrantEvent.create({
          data: {
            id: event.id,
            code1c,
            candidateId: null,
            personUid: normPersonUid,
            citizenship: normCitizenship,
            enabled: false,
            payloadHash: currentPayloadHash,
          },
        });
        return { candidateId: null, known: false };
      }
      if (!current) {
        const projection = await tx.lkEmployee.findUnique({
          where: { code1c },
        });
        current = await tx.candidate.create({
          data: {
            identityKey: `ig:${event.id}`,
            code1c,
            personUid: identity.personUid,
            reviewGroup: "IG",
            citizenship: normCitizenship,
            fullName:
              profile?.fullName ?? profile?.name ?? projection?.fullName,
            birthDate: profile?.birthDate
              ? new Date(`${profile.birthDate}T00:00:00.000Z`)
              : projection?.birthday,
            positionCode:
              position?.code ??
              profile?.positionCode ??
              projection?.positionCode1c,
            positionName:
              position?.name ??
              profile?.positionName ??
              projection?.positionName,
            locationId: projection?.lastLocationId,
            isReemployment:
              hadDismissal ||
              !!state.currentCandidate ||
              !!(await tx.candidate.findFirst({
                where: { code1c, chatUuid: null },
              })),
          },
        });
      } else if (!current.personUid) {
        current = await tx.candidate.update({
          where: { id: current.id },
          data: { personUid: identity.personUid, reviewGroup: "IG" },
        });
      }
      await tx.igEmploymentState.update({
        where: { code1c },
        data: { currentCandidateId: current.id },
      });
      await tx.igGrantEvent.create({
        data: {
          id: event.id,
          code1c,
          candidateId: current.id,
          personUid: normPersonUid,
          citizenship: normCitizenship,
          enabled: true,
          payloadHash: currentPayloadHash,
        },
      });
      await this.audit.logInTransaction(tx, {
        actorId: "system:adaptation",
        action: "DATA_IMPORTED",
        entityType: "Candidate",
        entityId: current.id,
        correlationId: event.id,
        after: { source: "ADAPTATION_ACCESS" },
      });
      return { candidateId: current.id, known: true };
    });
  }
}
