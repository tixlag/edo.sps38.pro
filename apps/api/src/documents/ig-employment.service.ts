import { ConflictException, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { candidateReviewGroup } from "./review-group";
import { ErpCandidateClient } from "./erp-candidate.client";
import { candidateIdentityTransaction } from "./candidate-identity";

export interface IgGrantEvent {
  id: string;
  employeeCode1c: string;
  citizenship: string;
  createdAt: string;
}

@Injectable()
export class IgEmploymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly audit: AuditService,
    @Optional() private readonly candidates?: ErpCandidateClient,
  ) {}

  async applyGrant(event: IgGrantEvent): Promise<string> {
    const code1c = event.employeeCode1c;
    const identity = await this.erp.identity(code1c);
    if (
      identity.reviewGroup !== "IG" ||
      identity.recipientType !== "person" ||
      !identity.personUid ||
      identity.code1C !== code1c
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
        if (processed.code1c !== code1c)
          throw new ConflictException("IG_GRANT_EVENT_CONFLICT");
        return processed.candidateId;
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
          (current.personUid && current.personUid !== identity.personUid))
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      const sentBeforeCompletion =
        !!current?.igCompletedAt &&
        new Date(event.createdAt).getTime() <= current.igCompletedAt.getTime();
      if (!current || (current.igCompletedAt && !sentBeforeCompletion)) {
        const projection = await tx.lkEmployee.findUnique({
          where: { code1c },
        });
        current = await tx.candidate.create({
          data: {
            identityKey: `ig:${event.id}`,
            code1c,
            personUid: identity.personUid,
            reviewGroup: "IG",
            citizenship: event.citizenship.toLowerCase(),
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
        data: { id: event.id, code1c, candidateId: current.id },
      });
      await this.audit.logInTransaction(tx, {
        actorId: "system:adaptation",
        action: "DATA_IMPORTED",
        entityType: "Candidate",
        entityId: current.id,
        correlationId: event.id,
        after: { source: "ADAPTATION_ACCESS" },
      });
      return current.id;
    });
  }
}
