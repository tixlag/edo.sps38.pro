import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { CandidatePreviousDocumentsSyncService } from "../src/documents/candidate-previous-documents-sync.service";
const db = process.env.EDO_TARGETED_TEST_DATABASE_URL;
if (db && db !== "mysql://edo:edo_disposable@127.0.0.1:3307/edo")
  throw new Error("Refuse non-disposable database");
describe.skipIf(!db)("historical document ownership in MariaDB", () => {
  const prisma = new PrismaService({ datasourceUrl: db });
  const id = `owner-${randomUUID()}`,
    erpUid = randomUUID(),
    personOne = randomUUID(),
    personTwo = randomUUID();
  const audit = { logInTransaction: vi.fn() };
  const service = new CandidatePreviousDocumentsSyncService(
    prisma,
    {} as never,
    {} as never,
    audit as never,
  );
  const doc = (personUid: string) => ({
    id: "20260101|passport",
    personUid,
    documentUid: "6ffb1fd5-8341-11eb-ba8b-002590854e7f",
    title: "Passport",
    fields: { number: "ERP" },
    expiresAt: null,
    isInvalid: false,
    originalAvailable: true,
    recheckStatus: "REQUIRES_REVIEW",
  });
  afterAll(async () => {
    await prisma.candidatePreviousDocumentFieldEdit.deleteMany({
      where: { previousDocument: { candidateId: id } },
    });
    await prisma.candidatePreviousDocument.deleteMany({
      where: { candidateId: id },
    });
    await prisma.candidate.deleteMany({ where: { id } });
    await prisma.$disconnect();
  });
  it("keeps same-owner edits and isolates them after rebinding the person", async () => {
    await prisma.candidate.create({
      data: {
        id,
        identityKey: `candidate:${erpUid}`,
        erpUid,
        personUid: personOne,
        citizenship: "ru",
        reviewGroup: "RU",
      },
    });
    await service.syncPreviousDocuments(id, "test", "", undefined, undefined, {
      preloadedDocuments: { items: [doc(personOne)] },
    });
    const first = await prisma.candidatePreviousDocument.findFirstOrThrow({
      where: { candidateId: id },
    });
    await prisma.candidatePreviousDocumentFieldEdit.create({
      data: {
        previousDocumentId: first.id,
        name: "number",
        value: "LOCAL",
        kind: "text",
        editedBy: "reviewer",
      },
    });
    await service.syncPreviousDocuments(id, "test", "", undefined, undefined, {
      preloadedDocuments: { items: [doc(personOne)] },
    });
    expect(
      (
        await prisma.candidatePreviousDocument.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).fields,
    ).toMatchObject({ number: "LOCAL" });
    await prisma.candidate.update({
      where: { id },
      data: { personUid: personTwo },
    });
    await service.syncPreviousDocuments(id, "test", "", undefined, undefined, {
      preloadedDocuments: { items: [doc(personTwo)] },
    });
    const rows = await prisma.candidatePreviousDocument.findMany({
      where: { candidateId: id },
      include: { fieldEdits: true },
    });
    expect(rows).toHaveLength(2);
    const older = rows.find((row) => row.id === first.id)!;
    const newer = rows.find((row) => row.sourcePersonUid === personTwo)!;
    expect(older.originalAvailable).toBe(false);
    expect(older.fieldEdits).toHaveLength(1);
    expect(newer.id).not.toBe(first.id);
    expect(newer.fields).toMatchObject({ number: "ERP" });
    expect(newer.fieldEdits).toHaveLength(0);
  });
});
