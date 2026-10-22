import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { DocumentIngestionService } from "../src/documents/document-ingestion.service";
import { ManualDocumentService } from "../src/documents/manual-document.service";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "../src/documents/candidate-identity";
import { CandidateCatalogService } from "../src/communications/candidate-catalog.service";
import type { StagedUpload } from "../src/documents/document-upload.service";

const db = process.env.EDO_TEST_DATABASE_URL ?? "";
if (
  db &&
  !/^mysql:\/\/[^@/]+@(127\.0\.0\.1|localhost):(3307|3308)\/edo(\?|$)/.test(db)
)
  throw new Error("Refusing non-disposable candidate identity DB");
const suite = describe.skipIf(!db);
const namespace = `identity-test-${randomUUID()}`;
let prisma: PrismaService, audit: AuditService, manual: ManualDocumentService;
const typeUid = randomUUID();
const ids = new Set<string>();
function stage(chatUuid?: string, erpUid?: string): StagedUpload {
  return {
    directory: "unused",
    documentTypeCode: "unused",
    metadata: {
      documentUid: typeUid,
      chat_uuid: chatUuid,
      position_code_1c: "TEST-POSITION",
      citizenship: "ru",
      ...(erpUid ? { candidateSnapshot: { erpUid } } : {}),
      documentFields: {},
    },
    files: [
      {
        id: randomUUID(),
        ordinal: 0,
        filename: "synthetic.pdf",
        mimeType: "application/pdf",
        path: "unused",
        sizeBytes: 4,
        sha256: "synthetic-test-hash",
        pageCount: 1,
      },
    ],
  };
}
async function catalog(erpUid: string, chatUuid: string | null) {
  const erp = {
    configured: () => true,
    catalog: async () => ({
      items: [
        {
          erpUid,
          chatUuid,
          fullName: "Synthetic candidate",
          projectCode: null,
          projectName: null,
          positionCode: null,
          positionName: null,
          deleted: false,
        },
      ],
      nextCursor: null,
    }),
  };
  const redis = {
    setNxPxStrict: async () => true,
    getStrict: async () => null,
    compareAndExpire: async () => true,
    compareAndDelStrict: async () => true,
    evalStrict: async () => 1,
    set: async () => undefined,
  };
  await new CandidateCatalogService(
    prisma,
    redis as never,
    erp as never,
    audit,
    {} as never,
    new ConfigService(),
  ).sync();
  const row = await prisma.candidate.findUniqueOrThrow({ where: { erpUid } });
  ids.add(row.id);
  return row;
}
function barrier(parties: number) {
  let arrivals = 0,
    release!: () => void;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++arrivals === parties) release();
    await all;
  };
}
suite("candidate ownership and legacy receipts on disposable MariaDB", () => {
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    audit = new AuditService(prisma);
    await prisma.documentType.create({
      data: {
        erpUid: typeUid,
        code: namespace,
        title: "Synthetic test document",
        allRu: true,
        catalogSyncedAt: new Date(),
      },
    });
    manual = new ManualDocumentService(
      prisma,
      {
        keyFor: (doc: string, version: number, file: string) =>
          `${namespace}/${doc}/${version}/${file}`,
        upload: async () => undefined,
      } as never,
      audit,
      { ensure: async () => undefined } as never,
    );
  });
  afterAll(async () => {
    if (!prisma) return;
    const documents = await prisma.document.findMany({
      where: { candidateId: { in: [...ids] } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: [...ids, ...documents.map((row) => row.id)] } },
          { correlationId: namespace },
        ],
      },
    });
    await prisma.candidate.deleteMany({ where: { id: { in: [...ids] } } });
    await prisma.documentType.deleteMany({ where: { erpUid: typeUid } });
    await prisma.$disconnect();
  });
  it("keeps the imported Candidate.id through canonical link and document upload, preserves namespace and receipt", async () => {
    const erpUid = randomUUID(),
      chatUuid = randomUUID(),
      key = randomUUID();
    const imported = await catalog(erpUid, null);
    await candidateIdentityTransaction(prisma, (tx) =>
      resolveCandidateIdentity(tx, {
        expectedId: imported.id,
        erpUid,
        chatUuid,
        identityKey: `erp-candidate:${erpUid}`,
      }),
    );
    const staged = stage(chatUuid, erpUid);
    const uploaded = await manual.upload(staged, key, namespace);
    expect(uploaded.candidateId).toBe(imported.id);
    expect(await manual.upload(staged, key, namespace)).toEqual(uploaded);
    expect(
      await prisma.candidate.count({
        where: { OR: [{ erpUid }, { chatUuid }] },
      }),
    ).toBe(1);
    expect(
      (await prisma.candidate.findUniqueOrThrow({ where: { id: imported.id } }))
        .identityKey,
    ).toBe(`erp-candidate:${erpUid}`);
    expect(
      (
        await prisma.documentSubmission.findUniqueOrThrow({
          where: { id: uploaded.submissionId },
        })
      ).identityKey,
    ).toBe(`chat:${chatUuid}`);
    expect(
      await prisma.documentVersion.count({
        where: { documentId: uploaded.documentId },
      }),
    ).toBe(1);
  });
  it("attaches a later ERP import to the existing chat owner without moving documents or receipts", async () => {
    const chatUuid = randomUUID(),
      erpUid = randomUUID(),
      staged = stage(chatUuid),
      key = randomUUID();
    const uploaded = await manual.upload(staged, key, namespace);
    ids.add(uploaded.candidateId);
    const imported = await catalog(erpUid, chatUuid);
    expect(imported.id).toBe(uploaded.candidateId);
    expect(await manual.upload(staged, key, namespace)).toEqual(uploaded);
    expect(imported.identityKey).toBe(`chat:${chatUuid}`);
  });
  it("returns a legacy receipt after the same context gains resolver-only erpUid", async () => {
    const chatUuid = randomUUID(),
      erpUid = randomUUID(),
      staged = stage(chatUuid),
      key = randomUUID();
    staged.metadata!.candidateSnapshot = { fullName: "Synthetic candidate" };
    const uploaded = await manual.upload(staged, key, namespace);
    ids.add(uploaded.candidateId);
    const before = await prisma.documentSubmission.findUniqueOrThrow({
      where: { id: uploaded.submissionId },
    });
    const legacyFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          metadata: { ...staged.metadata, documentFields: {} },
          files: staged.files.map(
            ({ filename, mimeType, sha256, pageCount }) => ({
              filename,
              mimeType,
              sha256,
              pageCount,
            }),
          ),
        }),
      )
      .digest("hex");
    expect(before.fingerprint).toBe(legacyFingerprint);
    staged.metadata!.candidateSnapshot.erpUid = erpUid;
    expect(await manual.upload(staged, key, namespace)).toEqual(uploaded);
    const conflicting = await catalog(erpUid, null);
    expect(conflicting.id).not.toBe(uploaded.candidateId);
    await expect(manual.upload(staged, key, namespace)).rejects.toThrow(
      "CANDIDATE_IDENTITY_CONFLICT",
    );
    expect(
      await prisma.documentVersion.count({
        where: { documentId: uploaded.documentId },
      }),
    ).toBe(1);
  });
  it("serializes parallel import and first upload using real erpUid/chat unique constraints", async () => {
    const erpUid = randomUUID(),
      chatUuid = randomUUID(),
      meet = barrier(2);
    const originalFindMany = prisma.candidate.findMany.bind(prisma.candidate);
    // Both transactions first observe absence before either inserts; Prisma tx
    // clients share their own delegates, so use an explicit transaction barrier.
    const writers = [
      { identityKey: `erp-candidate:${erpUid}`, erpUid },
      { identityKey: `chat:${chatUuid}`, erpUid, chatUuid },
    ];
    const owners = await Promise.all(
      writers.map((identity) => {
        let first = true;
        return candidateIdentityTransaction(prisma, async (tx) => {
          if (first) {
            first = false;
            const empty = await tx.candidate.findMany({ where: { erpUid } });
            expect(empty).toHaveLength(0);
            await meet();
          }
          return resolveCandidateIdentity(tx, identity);
        });
      }),
    );
    expect(owners[0].id).toBe(owners[1].id);
    ids.add(owners[0].id);
    expect(
      await originalFindMany({ where: { OR: [{ erpUid }, { chatUuid }] } }),
    ).toHaveLength(1);
    const uploaded = await manual.upload(
      stage(chatUuid, erpUid),
      randomUUID(),
      namespace,
    );
    expect(uploaded.candidateId).toBe(owners[0].id);
  });
  it("keeps real catalog imports and uploads on one owner when they run concurrently", async () => {
    for (let round = 0; round < 3; round++) {
      const erpUid = randomUUID(),
        chatUuid = randomUUID(),
        key = randomUUID();
      const meet = barrier(2);
      const [imported, uploaded] = await Promise.all([
        (async () => {
          await meet();
          return catalog(erpUid, null);
        })(),
        (async () => {
          await meet();
          return manual.upload(stage(chatUuid, erpUid), key, namespace);
        })(),
      ]);
      ids.add(uploaded.candidateId);
      expect(uploaded.candidateId).toBe(imported.id);
      expect(
        await prisma.candidate.count({
          where: { OR: [{ erpUid }, { chatUuid }] },
        }),
      ).toBe(1);
      expect(
        await prisma.documentVersion.count({
          where: { documentId: uploaded.documentId },
        }),
      ).toBe(1);
      expect(
        await manual.upload(stage(chatUuid, erpUid), key, namespace),
      ).toEqual(uploaded);
    }
  });
  it("resolves an employee-link callback through trusted ERP identity without replacing the case", async () => {
    const erpUid = randomUUID(),
      chatUuid = randomUUID(),
      code1c = `CODE-${randomUUID()}`;
    const imported = await catalog(erpUid, null);
    const ingestion = new DocumentIngestionService(
      prisma,
      {} as never,
      {} as never,
      audit,
      { candidateDto: (row: unknown) => row } as never,
      { resolveIdentityByChat: async () => erpUid } as never,
    );
    expect(await ingestion.link(chatUuid, code1c, namespace)).toMatchObject({
      id: imported.id,
      erpUid,
      chatUuid,
      code1c,
    });
    await expect(
      ingestion.link(chatUuid, "OTHER-CODE", namespace),
    ).rejects.toThrow("another code1c");
    expect(
      await prisma.candidate.count({
        where: { OR: [{ erpUid }, { chatUuid }] },
      }),
    ).toBe(1);
  });
  it("does not auto-merge existing conflicting owners or alter their history", async () => {
    const erpUid = randomUUID(),
      chatUuid = randomUUID();
    const first = await catalog(erpUid, null);
    const uploaded = await manual.upload(
      stage(chatUuid),
      randomUUID(),
      namespace,
    );
    ids.add(uploaded.candidateId);
    await expect(
      candidateIdentityTransaction(prisma, (tx) =>
        resolveCandidateIdentity(tx, {
          erpUid,
          chatUuid,
          identityKey: `erp-candidate:${erpUid}`,
        }),
      ),
    ).rejects.toThrow("CANDIDATE_IDENTITY_CONFLICT");
    expect(
      await prisma.candidate.count({
        where: { id: { in: [first.id, uploaded.candidateId] } },
      }),
    ).toBe(2);
    expect(
      await prisma.documentVersion.count({
        where: { documentId: uploaded.documentId },
      }),
    ).toBe(1);
  });
  it("permits separate cases for one code1c without imposing employee uniqueness", async () => {
    const code1c = `CODE-${randomUUID()}`;
    const first = await candidateIdentityTransaction(prisma, (tx) =>
      resolveCandidateIdentity(tx, { identityKey: `employee:${code1c}` }),
    );
    ids.add(first.id);
    const second = await candidateIdentityTransaction(prisma, (tx) =>
      resolveCandidateIdentity(tx, { identityKey: `chat:${randomUUID()}` }),
    );
    ids.add(second.id);
    await prisma.candidate.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { code1c },
    });
    expect(await prisma.candidate.count({ where: { code1c } })).toBe(2);
  });
});
