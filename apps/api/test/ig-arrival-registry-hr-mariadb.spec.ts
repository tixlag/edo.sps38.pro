import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { IgArrivalRegistryService } from "../src/documents/ig-arrival-registry.service";
import { MIGRATION_UID } from "../src/ocr/ocr-profile";
import { EMPLOYMENT_PATENT_UID } from "../src/documents/reemployment-document-policy";
const db = process.env.EDO_HR_TEST_DATABASE_URL;
if (db && db !== "mysql://root:edo-registry-test-only@127.0.0.1:32772/edo")
  throw new Error("Refuse non-task database");
describe.skipIf(!db)(
  "IG registry HR requirements on clean disposable MariaDB",
  () => {
    const personUid = randomUUID(),
      member = randomUUID(),
      location = randomUUID(),
      code1c = `hr-${randomUUID()}`;
    const reviewer = { accessRules: { "20011": [] } } as never;
    let prisma: PrismaService,
      registry: IgArrivalRegistryService,
      candidateId: string,
      typeIds: string[];
    beforeAll(async () => {
      prisma = new PrismaService({ datasourceUrl: db });
      registry = new IgArrivalRegistryService(prisma);
      const types = await Promise.all(
        [MIGRATION_UID, EMPLOYMENT_PATENT_UID, randomUUID()].map((erpUid, i) =>
          prisma.documentType.create({
            data: {
              code: `HR_${i}_${randomUUID()}`,
              title: `Required ${i}`,
              erpUid,
              allForeign: true,
              catalogSyncedAt: new Date(),
            },
          }),
        ),
      );
      typeIds = types.map((t) => t.id);
      const candidate = await prisma.candidate.create({
        data: {
          identityKey: `hr:${personUid}`,
          code1c,
          personUid,
          reviewGroup: "IG",
          citizenship: "uz",
          positionCode: "position",
          profileSyncedAt: new Date(),
        },
      });
      candidateId = candidate.id;
      await prisma.igArrivalPerson.create({
        data: {
          personUid,
          code1c,
          candidateId,
          revision: 1n,
          state: "CURRENT",
          sourceHash: "x",
          sourcePayload: {},
          igVerified: true,
          members: {
            create: {
              arrivalMemberUid: member,
              arrivalDate: "2026-11-05",
              locationUid: location,
              locationCode1c: null,
              locationName: "Site",
              lastSeenRevision: 1n,
              cancelled: false,
            },
          },
        },
      });
      await prisma.igArrivalPerson.update({
        where: { personUid },
        data: { currentMemberUid: member },
      });
    });
    afterAll(async () => {
      if (!prisma) return;
      await prisma.igArrivalPerson.deleteMany({ where: { personUid } });
      await prisma.document.deleteMany({ where: { candidateId } });
      await prisma.candidatePreviousDocument.deleteMany({
        where: { candidateId },
      });
      await prisma.candidate.deleteMany({ where: { id: candidateId } });
      await prisma.documentType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.$disconnect();
    });
    it("reports missing required documents rather than declaring an incomplete approved subset complete", async () => {
      const doc = await prisma.document.create({
        data: {
          candidateId,
          documentTypeId: typeIds[0],
          status: "APPROVED",
          versions: {
            create: { version: 1, status: "APPROVED", storageKey: "test" },
          },
        },
      });
      try {
        const group = (await registry.groups(reviewer, { q: code1c })).items[0];
        const page = await registry.participations(reviewer, {
          q: code1c,
          groupKey: group.groupKey,
        });
        expect(page.items[0]).toMatchObject({
          requirements: {
            known: true,
            required: 3,
            present: 1,
            accepted: 1,
            review: 0,
            returned: 0,
            missing: 2,
            completed: false,
            nextAction: "MISSING",
          },
          action: "OPEN_CARD",
          reviewAvailable: 0,
        });
        expect(page.items[0].documentStatus).toBe("IN_PROGRESS");
        expect(
          (
            await registry.groups(reviewer, {
              q: code1c,
              documentStatus: "APPROVED",
            })
          ).items,
        ).toEqual([]);
      } finally {
        await prisma.document.delete({ where: { id: doc.id } });
      }
    });
    it("treats approved and signed version pairs as accepted while retaining delivery diagnostics", async () => {
      const docs = [];
      try {
        for (let i = 0; i < 3; i++)
          docs.push(
            await prisma.document.create({
              data: {
                candidateId,
                documentTypeId: typeIds[i],
                status: i === 1 ? "SIGNED" : "APPROVED",
                versions: {
                  create: {
                    version: 1,
                    status: i === 0 ? "SIGNED" : "APPROVED",
                    storageKey: "test",
                  },
                },
              },
            }),
          );
        const group = (await registry.groups(reviewer, { q: code1c })).items[0];
        const row = (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
          })
        ).items[0];
        expect(row).toMatchObject({
          documentStatus: "APPROVED",
          deliveryNeedsAttention: true,
          requirements: {
            known: true,
            required: 3,
            accepted: 3,
            completed: true,
            nextAction: "COMPLETE",
          },
        });
        expect(
          (
            await registry.groups(reviewer, {
              q: code1c,
              requirementsAction: "COMPLETE",
            })
          ).items,
        ).toHaveLength(1);
      } finally {
        await prisma.document.deleteMany({
          where: { id: { in: docs.map((d) => d.id) } },
        });
      }
    });
    it("keeps returned and review counts independent and prioritizes available review", async () => {
      const docs = [];
      try {
        docs.push(
          await prisma.document.create({
            data: {
              candidateId,
              documentTypeId: typeIds[0],
              status: "RETURNED",
              versions: {
                create: { version: 1, status: "RETURNED", storageKey: "test" },
              },
            },
          }),
        );
        docs.push(
          await prisma.document.create({
            data: {
              candidateId,
              documentTypeId: typeIds[1],
              status: "IN_REVIEW",
              versions: {
                create: { version: 1, status: "IN_REVIEW", storageKey: "test" },
              },
            },
          }),
        );
        const group = (
          await registry.groups(reviewer, {
            q: code1c,
            requirementsAction: "REVIEW",
          })
        ).items[0];
        expect(group.participationCount).toBe(1);
        const row = (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
            requirementsAction: "REVIEW",
          })
        ).items[0];
        expect(row).toMatchObject({
          reviewAvailable: 1,
          action: "REVIEW",
          documentStatus: "RETURNED",
          requirements: {
            known: true,
            review: 1,
            returned: 1,
            missing: 1,
            nextAction: "REVIEW",
            completed: false,
          },
        });
        expect(
          (
            await registry.groups(reviewer, {
              q: code1c,
              requirementsAction: "COMPLETE",
            })
          ).items,
        ).toEqual([]);
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { positionCode: null },
        });
        const unknown = (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
          })
        ).items[0];
        expect(unknown).toMatchObject({
          action: "REVIEW",
          reviewAvailable: 1,
          requirements: {
            known: false,
            required: null,
            completed: null,
            nextAction: "REVIEW",
          },
        });
      } finally {
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { positionCode: "position" },
        });
        await prisma.document.deleteMany({
          where: { id: { in: docs.map((d) => d.id) } },
        });
      }
    });
    it("recognises only usable prior evidence and respects JSON boolean semantics", async () => {
      const type = await prisma.documentType.findUniqueOrThrow({
        where: { id: typeIds[2] },
      });
      const previous = await prisma.candidatePreviousDocument.create({
        data: {
          candidateId,
          sourceId: randomUUID(),
          documentUid: type.erpUid,
          title: "prior",
          fields: { isInvalid: "true" },
          originalAvailable: true,
          originalVerified: true,
          status: "CONFIRMED",
        },
      });
      try {
        const group = (await registry.groups(reviewer, { q: code1c })).items[0];
        const read = async () =>
          (
            await registry.participations(reviewer, {
              q: code1c,
              groupKey: group.groupKey,
            })
          ).items[0];
        expect(await read()).toMatchObject({
          requirements: { accepted: 1, present: 1, missing: 2 },
        });
        await prisma.candidatePreviousDocument.update({
          where: { id: previous.id },
          data: { fields: { isInvalid: true } },
        });
        expect(await read()).toMatchObject({
          requirements: { accepted: 0, present: 0, missing: 3 },
        });
        await prisma.candidatePreviousDocument.update({
          where: { id: previous.id },
          data: { fields: {}, expiresAt: new Date("2000-01-01") },
        });
        expect(await read()).toMatchObject({
          requirements: { accepted: 0, present: 0, missing: 3 },
        });
        await prisma.candidatePreviousDocument.update({
          where: { id: previous.id },
          data: { expiresAt: null, originalVerified: false },
        });
        expect(await read()).toMatchObject({
          requirements: { accepted: 0, present: 0, missing: 3 },
        });
        await prisma.candidatePreviousDocument.update({
          where: { id: previous.id },
          data: { originalVerified: true, originalAvailable: false },
        });
        expect(await read()).toMatchObject({
          requirements: { accepted: 0, missing: 3 },
        });
        await prisma.candidatePreviousDocument.update({
          where: { id: previous.id },
          data: { originalAvailable: true, status: "REQUIRES_REVIEW" },
        });
        expect(await read()).toMatchObject({
          requirements: { accepted: 0, missing: 3 },
        });
        await prisma.candidatePreviousDocument.update({
          where: { id: previous.id },
          data: { status: "CONFIRMED", expiresAt: new Date("2099-01-01") },
        });
        expect(await read()).toMatchObject({
          requirements: { accepted: 1, missing: 2 },
        });
      } finally {
        await prisma.candidatePreviousDocument.delete({
          where: { id: previous.id },
        });
      }
    });
    it("does not treat a stale partial catalog as known", async () => {
      const old = await prisma.documentType.findUniqueOrThrow({
        where: { id: typeIds[2] },
      });
      try {
        await prisma.documentType.update({
          where: { id: old.id },
          data: { catalogSyncedAt: new Date("2000-01-01") },
        });
        const group = (await registry.groups(reviewer, { q: code1c })).items[0];
        const row = (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
          })
        ).items[0];
        expect(row).toMatchObject({
          documentStatus: "UNKNOWN",
          requirements: {
            known: false,
            completed: null,
            nextAction: "UNKNOWN",
          },
        });
      } finally {
        await prisma.documentType.update({
          where: { id: old.id },
          data: { catalogSyncedAt: old.catalogSyncedAt },
        });
      }
    });

    it("matches ERP stage precedence, optional positions, projects and countries without double counting", async () => {
      const typeId = typeIds[2];
      const rule = await prisma.documentTypeStageRule.create({
        data: {
          documentTypeId: typeId,
          stage: 1,
          positions: { create: { code1c: "position", required: false } },
          projects: { create: { code1c: "project-hit" } },
          countries: { create: { code: "kg" } },
        },
      });
      const second = await prisma.documentTypeStageRule.create({
        data: {
          documentTypeId: typeId,
          stage: 2,
          projects: { create: { code1c: "project-hit" } },
        },
      });
      try {
        const read = async () => {
          const group = (await registry.groups(reviewer, { q: code1c }))
            .items[0];
          return (
            await registry.participations(reviewer, {
              q: code1c,
              groupKey: group.groupKey,
            })
          ).items[0];
        };
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { projectCode: "other" },
        });
        expect(await read()).toMatchObject({
          requirements: { known: true, required: 2 },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { projectCode: "project-hit" },
        });
        expect(await read()).toMatchObject({
          requirements: { known: true, required: 3 },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { projectCode: "other", citizenship: "kg" },
        });
        expect(await read()).toMatchObject({
          requirements: { known: true, required: 3 },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { projectCode: null, citizenship: "uz" },
        });
        expect(await read()).toMatchObject({
          requirements: { known: false, required: null },
        });
      } finally {
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { projectCode: null, citizenship: "uz" },
        });
        await prisma.documentTypeStageRule.deleteMany({
          where: { id: { in: [rule.id, second.id] } },
        });
      }
    });
    it("does not decide requirements while unknown sex affects MILITARY applicability", async () => {
      const military = await prisma.documentType.create({
        data: {
          code: "MILITARY",
          title: "Military",
          erpUid: randomUUID(),
          allForeign: true,
          catalogSyncedAt: new Date(),
        },
      });
      try {
        const read = async () => {
          const group = (await registry.groups(reviewer, { q: code1c }))
            .items[0];
          return (
            await registry.participations(reviewer, {
              q: code1c,
              groupKey: group.groupKey,
            })
          ).items[0];
        };
        expect(await read()).toMatchObject({
          requirements: { known: false, required: null },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { sexKnown: true, sex: "female" },
        });
        expect(await read()).toMatchObject({
          requirements: { known: true, required: 3 },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { sex: "male" },
        });
        expect(await read()).toMatchObject({
          requirements: { known: true, required: 4 },
        });
      } finally {
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { sexKnown: false, sex: null },
        });
        await prisma.documentType.delete({ where: { id: military.id } });
      }
    });
    it("never reuses old migration card or patent and never masks returned new material", async () => {
      const types = await prisma.documentType.findMany({
        where: { id: { in: [typeIds[0], typeIds[1]] } },
      });
      const prior = [];
      try {
        for (const t of types)
          prior.push(
            await prisma.candidatePreviousDocument.create({
              data: {
                candidateId,
                sourceId: randomUUID(),
                documentUid: t.erpUid,
                title: "old",
                fields: {},
                originalAvailable: true,
                originalVerified: true,
                status: "CONFIRMED",
              },
            }),
          );
        const group = (await registry.groups(reviewer, { q: code1c })).items[0];
        const row = (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
          })
        ).items[0];
        expect(row).toMatchObject({
          requirements: { known: true, accepted: 0, missing: 3 },
        });
      } finally {
        await prisma.candidatePreviousDocument.deleteMany({
          where: { id: { in: prior.map((x) => x.id) } },
        });
      }
    });

    it("surfaces an optional returned document even when all required documents are complete", async () => {
      const optional = await prisma.documentType.create({
        data: {
          code: `OPTIONAL_${randomUUID()}`,
          title: "Optional",
          erpUid: randomUUID(),
          catalogSyncedAt: new Date(),
        },
      });
      try {
        for (const typeId of typeIds)
          await prisma.document.create({
            data: {
              candidateId,
              documentTypeId: typeId,
              status: "APPROVED",
              versions: {
                create: { version: 1, status: "APPROVED", storageKey: "test" },
              },
            },
          });
        await prisma.document.create({
          data: {
            candidateId,
            documentTypeId: optional.id,
            status: "RETURNED",
            versions: {
              create: { version: 1, status: "RETURNED", storageKey: "test" },
            },
          },
        });
        const group = (
          await registry.groups(reviewer, {
            q: code1c,
            requirementsAction: "RETURNED",
          })
        ).items[0];
        expect(group).toBeDefined();
        const row = (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
            requirementsAction: "RETURNED",
          })
        ).items[0];
        expect(row.requirements).toMatchObject({
          known: true,
          required: 3,
          accepted: 3,
          returned: 0,
          completed: true,
          nextAction: "RETURNED",
        });
      } finally {
        await prisma.document.deleteMany({ where: { candidateId } });
        await prisma.documentType.delete({ where: { id: optional.id } });
      }
    });

    it("includes review-only work in attention filter and matching group count", async () => {
      const doc = await prisma.document.create({
        data: {
          candidateId,
          documentTypeId: typeIds[0],
          status: "IN_REVIEW",
          versions: {
            create: { version: 1, status: "IN_REVIEW", storageKey: "test" },
          },
        },
      });
      try {
        const group = (
          await registry.groups(reviewer, { q: code1c, needsAttention: true })
        ).items[0];
        expect(group).toMatchObject({
          participationCount: 1,
          needsAttentionCount: 1,
        });
        const page = await registry.participations(reviewer, {
          q: code1c,
          needsAttention: true,
          groupKey: group.groupKey,
        });
        expect(page.items[0]).toMatchObject({
          needsAttention: true,
          action: "REVIEW",
        });
      } finally {
        await prisma.document.delete({ where: { id: doc.id } });
      }
    });

    it("paginates 51 participants with disjoint pages and full group totals", async () => {
      const prefix = `many-${randomUUID()}`,
        site = randomUUID();
      const people = Array.from({ length: 51 }, (_, i) => ({
        personUid: randomUUID(),
        memberUid: randomUUID(),
        code1c: `${prefix}-${String(i).padStart(2, "0")}`,
      }));
      try {
        await prisma.igArrivalPerson.createMany({
          data: people.map((x) => ({
            personUid: x.personUid,
            code1c: x.code1c,
            revision: 1n,
            state: "CURRENT",
            sourceHash: "x",
            sourcePayload: {},
            igVerified: true,
          })),
        });
        await prisma.igArrivalMember.createMany({
          data: people.map((x) => ({
            arrivalMemberUid: x.memberUid,
            personUid: x.personUid,
            arrivalDate: "2026-11-06",
            locationUid: site,
            locationName: "Bulk",
            lastSeenRevision: 1n,
            cancelled: false,
          })),
        });
        for (const x of people)
          await prisma.igArrivalPerson.update({
            where: { personUid: x.personUid },
            data: { currentMemberUid: x.memberUid },
          });
        const group = (await registry.groups(reviewer, { q: prefix })).items[0];
        expect(group).toMatchObject({
          participationCount: 51,
          totalParticipationCount: 51,
        });
        const first = await registry.participations(reviewer, {
          q: prefix,
          groupKey: group.groupKey,
          limit: 50,
        });
        expect(first.items).toHaveLength(50);
        expect(first.nextCursor).toBeTruthy();
        const second = await registry.participations(reviewer, {
          q: prefix,
          groupKey: group.groupKey,
          limit: 50,
          cursor: first.nextCursor!,
        });
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        expect(
          new Set(
            [...first.items, ...second.items].map((x) => x.arrivalMemberUid),
          ).size,
        ).toBe(51);
        const filtered = (
          await registry.groups(reviewer, { q: people[0].code1c })
        ).items[0];
        expect(filtered).toMatchObject({
          participationCount: 1,
          totalParticipationCount: 51,
        });
      } finally {
        await prisma.igArrivalPerson.deleteMany({
          where: { personUid: { in: people.map((x) => x.personUid) } },
        });
      }
    });

    it("treats active source revision conflicts as unknown completeness", async () => {
      const issueId = createHash("sha256").update(randomUUID()).digest("hex");
      await prisma.igArrivalIssue.create({
        data: {
          id: issueId,
          personHash: createHash("sha256").update(personUid).digest("hex"),
          code: "ARRIVAL_REVISION_CONFLICT",
          active: true,
        },
      });
      try {
        const group = (await registry.groups(reviewer, { q: code1c })).items[0];
        const row = (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
          })
        ).items[0];
        expect(row).toMatchObject({
          requirements: { known: false, completed: null },
          needsAttention: true,
        });
      } finally {
        await prisma.igArrivalIssue.delete({ where: { id: issueId } });
      }
    });
    it("never claims a complete set for empty catalog, requirement conflict, missing position or unbound candidate", async () => {
      const read = async () => {
        const group = (await registry.groups(reviewer, { q: code1c })).items[0];
        return (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
          })
        ).items[0];
      };
      try {
        await prisma.documentType.updateMany({
          where: { id: { in: typeIds } },
          data: { catalogSyncedAt: null },
        });
        expect(await read()).toMatchObject({
          documentStatus: "UNKNOWN",
          requirements: { known: false, completed: null },
        });
        await prisma.documentType.updateMany({
          where: { id: { in: typeIds } },
          data: { catalogSyncedAt: new Date() },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { igRequirementsConflict: true },
        });
        expect(await read()).toMatchObject({
          requirements: { known: false, completed: null },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { igRequirementsConflict: false, positionCode: null },
        });
        expect(await read()).toMatchObject({
          requirements: { known: false, completed: null },
        });
        await prisma.igArrivalPerson.update({
          where: { personUid },
          data: { candidateId: null },
        });
        expect(await read()).toMatchObject({
          candidateId: null,
          action: "NONE",
          requirements: { known: false, completed: null },
        });
      } finally {
        await prisma.igArrivalPerson.update({
          where: { personUid },
          data: { candidateId },
        });
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { igRequirementsConflict: false, positionCode: "position" },
        });
        await prisma.documentType.updateMany({
          where: { id: { in: typeIds } },
          data: { catalogSyncedAt: new Date() },
        });
      }
    });
  },
);
