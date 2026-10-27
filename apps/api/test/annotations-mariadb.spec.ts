import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { StorageService } from "../src/storage/storage.service";
import { AnnotationSourceService } from "../src/annotations/annotation-source.service";
import { AnnotationService } from "../src/annotations/annotation.service";
import { AnnotationCatalogService } from "../src/annotations/annotation-catalog.service";
import { AnnotationProfile } from "../src/annotations/annotation.dto";
import type { AuthPrincipal } from "../src/auth/auth-principal";
const url = process.env.EDO_ANNOTATION_TEST_DATABASE_URL ?? "";
if (url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "mysql:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !parsed.port ||
    ["3306", "12002"].includes(parsed.port) ||
    parsed.pathname !== "/edo"
  )
    throw new Error("Refusing non-isolated annotation test MariaDB");
}
const suite = describe.skipIf(!url),
  prefix = `annotation-test-${randomUUID()}`;
const principal = (
  name: string,
  rules: Record<string, string[]> = { "20002": [] },
): AuthPrincipal => ({
  uuid: `${prefix}-${name}`.slice(0, 64),
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: rules,
});
const author = principal("a"),
  other = principal("b"),
  admin = principal("admin", { "20009": [] }),
  foreign = principal("ig", { "20011": [] });
let prisma: PrismaService,
  audit: AuditService,
  sources: AnnotationSourceService,
  service: AnnotationService,
  catalogs: AnnotationCatalogService,
  catalogId: string,
  typeId: string,
  bytes: Buffer;
const objects = new Map<string, Buffer>(),
  documents: string[] = [],
  families: string[] = [];
async function fixture(citizenship = "ru") {
  const key = `${prefix}/${randomUUID()}.png`;
  objects.set(key, bytes);
  const candidate = await prisma.candidate.create({
    data: {
      identityKey: `${prefix}-${randomUUID().slice(0, 20)}`,
      citizenship,
      locationId: null,
    },
  });
  const document = await prisma.document.create({
    data: {
      candidateId: candidate.id,
      documentTypeId: typeId,
      status: "IN_REVIEW",
      versions: {
        create: {
          version: 1,
          status: "IN_REVIEW",
          storageKey: key,
          mimeType: "image/png",
          citizenship,
          files: {
            create: {
              ordinal: 0,
              storageKey: key,
              filename: "synthetic.png",
              mimeType: "image/png",
              sizeBytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        },
      },
    },
    include: { versions: { include: { files: true } } },
  });
  documents.push(document.id);
  return document;
}
async function claimed() {
  const doc = await fixture();
  const annotation = await service.claim(
    { documentId: doc.id, version: 1, catalogId },
    author,
  );
  return { doc, annotation };
}
suite("annotation real MariaDB transactions", () => {
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url } } });
    await prisma.$connect();
    audit = new AuditService(prisma);
    const access = new DocumentAccessService(prisma);
    const storage = {
      read: async (key: string) => {
        const data = objects.get(key);
        if (!data) throw new Error("MISSING");
        return data;
      },
      previewUrl: async () => "https://example.invalid/private-preview",
    } as unknown as StorageService;
    sources = new AnnotationSourceService(prisma, storage, access);
    service = new AnnotationService(prisma, audit, access, sources);
    catalogs = new AnnotationCatalogService(prisma, audit);
    bytes = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const type = await prisma.documentType.create({
      data: { code: prefix.slice(0, 64), title: "Synthetic annotation test" },
    });
    typeId = type.id;
    const draft = await catalogs.create(
      {
        documentTypeCode: type.code,
        profile: AnnotationProfile.RU,
        title: "Synthetic fields",
        fields: [
          {
            key: "literal",
            label: "Literal",
            ordinal: 0,
            multiline: true,
            businessFieldName: null,
          },
        ],
      },
      admin,
    );
    catalogId = draft.id;
    const family = await prisma.annotationCatalog.findUniqueOrThrow({
      where: { id: catalogId },
    });
    families.push(family.familyId);
    await catalogs.mutate(catalogId, 0, undefined, true, false, admin);
    await service.setPreference(true, author);
    await service.setPreference(true, other);
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.document.deleteMany({ where: { id: { in: documents } } });
    await prisma.candidate.deleteMany({
      where: { identityKey: { startsWith: prefix } },
    });
    await prisma.annotationCatalog.deleteMany({
      where: { familyId: { in: families } },
    });
    await prisma.annotationCatalogFamily.deleteMany({
      where: { id: { in: families } },
    });
    await prisma.documentType.deleteMany({ where: { id: typeId } });
    await prisma.annotationPreference.deleteMany({
      where: { actorId: { in: [author.uuid, other.uuid, admin.uuid] } },
    });
    await prisma.auditLog.deleteMany({
      where: { actorId: { in: [author.uuid, other.uuid, admin.uuid] } },
    });
    await prisma.$disconnect();
  });
  it("serializes two competing claims and same-author retries without location grants", async () => {
    const doc = await fixture();
    const results = await Promise.allSettled([
      service.claim({ documentId: doc.id, version: 1, catalogId }, author),
      service.claim({ documentId: doc.id, version: 1, catalogId }, other),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejection.reason.getStatus()).toBe(409);
    expect(
      await prisma.documentAnnotation.count({
        where: { versionId: doc.versions[0].id },
      }),
    ).toBe(1);
    const won = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<
      Awaited<ReturnType<AnnotationService["claim"]>>
    >;
    const owner = won.value.authorId === author.uuid ? author : other;
    expect(
      (
        await service.claim(
          { documentId: doc.id, version: 1, catalogId },
          owner,
        )
      ).id,
    ).toBe(won.value.id);
  });
  it("rejects cross-group reads and claims independently of location scope", async () => {
    const doc = await fixture();
    await expect(
      service.claim({ documentId: doc.id, version: 1, catalogId }, foreign),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.list({ documentId: doc.id }, foreign)).items).toEqual(
      [],
    );
  });
  it("keeps published catalog immutable across ERP field replacement", async () => {
    const original = await prisma.annotationCatalogField.findMany({
      where: { catalogId },
    });
    await prisma.documentTypeField.create({
      data: {
        documentTypeId: typeId,
        name: "different_erp_key",
        kind: "text",
        required: true,
        ordinal: 0,
      },
    });
    await prisma.documentTypeField.deleteMany({
      where: { documentTypeId: typeId },
    });
    expect(
      await prisma.annotationCatalogField.findMany({ where: { catalogId } }),
    ).toEqual(original);
    await expect(
      catalogs.mutate(
        catalogId,
        1,
        { revision: 1, title: "Illegal", fields: [] },
        false,
        false,
        admin,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("allows completion after business approval and historic approved source retention", async () => {
    const { doc, annotation } = await claimed();
    const saved = await service.mutate(annotation.id, "save", 0, author, {
      fields: [{ key: "literal", disposition: "NOT_PRESENT", lines: [] }],
    });
    await service.setPreference(false, author);
    await prisma.documentVersion.update({
      where: { id: doc.versions[0].id },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "APPROVED", currentVersion: 2 },
    });
    const submitted = await service.mutate(
      annotation.id,
      "submit",
      saved.revision,
      author,
    );
    const before = await prisma.annotationSnapshot.findMany({
      where: { annotationId: annotation.id },
    });
    const accepted = await service.mutate(
      annotation.id,
      "accept",
      submitted.revision,
      admin,
    );
    expect(accepted.status).toBe("ACCEPTED");
    const acceptedSnapshot = await prisma.annotationSnapshot.findFirstOrThrow({
      where: { annotationId: annotation.id, status: "ACCEPTED" },
    });
    const payload = acceptedSnapshot.payload as unknown as {
      annotation: { candidateId: string; candidateCode1c: string | null };
    };
    expect(payload.annotation.candidateId).toBe(doc.candidateId);
    expect(payload.annotation.candidateCode1c).toBeNull();
    await prisma.candidate.update({
      where: { id: doc.candidateId! },
      data: { code1c: "updated-after-acceptance" },
    });
    expect(
      (
        await prisma.annotationSnapshot.findUniqueOrThrow({
          where: { id: acceptedSnapshot.id },
        })
      ).payload,
    ).toEqual(acceptedSnapshot.payload);
    expect(
      await prisma.annotationSnapshot.count({
        where: { annotationId: annotation.id },
      }),
    ).toBe(2);
    expect(
      await prisma.annotationSnapshot.findUnique({
        where: { id: before[0].id },
      }),
    ).toEqual(before[0]);
    await expect(
      service.mutate(annotation.id, "save", accepted.revision, author, {
        fields: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
        .status,
    ).toBe("APPROVED");
    await service.setPreference(true, author);
  });
  it("returns 409 on concurrent optimistic saves and retains exactly one revision", async () => {
    const { annotation } = await claimed();
    const result = await Promise.allSettled([
      service.mutate(annotation.id, "save", 0, author, {
        fields: [{ key: "literal", disposition: "NOT_PRESENT", lines: [] }],
      }),
      service.mutate(annotation.id, "save", 0, author, {
        fields: [{ key: "literal", disposition: "UNREADABLE", lines: [] }],
      }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        result.find((r) => r.status === "rejected") as PromiseRejectedResult
      ).reason.getStatus(),
    ).toBe(409);
    expect(
      (
        await prisma.documentAnnotation.findUniqueOrThrow({
          where: { id: annotation.id },
        })
      ).revision,
    ).toBe(1);
  });
  it("rolls claim and saved field rows back if audit insertion fails", async () => {
    const failingAudit = {
      logInTransaction: async () => {
        throw new Error("AUDIT_UNAVAILABLE");
      },
    } as unknown as AuditService;
    const broken = new AnnotationService(
        prisma,
        failingAudit,
        new DocumentAccessService(prisma),
        sources,
      ),
      doc = await fixture();
    await expect(
      broken.claim({ documentId: doc.id, version: 1, catalogId }, author),
    ).rejects.toThrow("AUDIT_UNAVAILABLE");
    expect(
      await prisma.documentAnnotation.count({
        where: { versionId: doc.versions[0].id },
      }),
    ).toBe(0);
    const annotation = await service.claim(
      { documentId: doc.id, version: 1, catalogId },
      author,
    );
    await expect(
      broken.mutate(annotation.id, "save", 0, author, {
        fields: [{ key: "literal", disposition: "NOT_PRESENT", lines: [] }],
      }),
    ).rejects.toThrow("AUDIT_UNAVAILABLE");
    expect(
      (
        await prisma.documentAnnotation.findUniqueOrThrow({
          where: { id: annotation.id },
        })
      ).revision,
    ).toBe(0);
    expect(
      await prisma.annotationFieldAnswer.count({
        where: { annotationId: annotation.id },
      }),
    ).toBe(0);
  });
  it("blocks submission when source bytes disappear or files are deleted", async () => {
    const { doc, annotation } = await claimed();
    await service.mutate(annotation.id, "save", 0, author, {
      fields: [{ key: "literal", disposition: "NOT_PRESENT", lines: [] }],
    });
    const key = doc.versions[0].storageKey,
      original = objects.get(key)!;
    objects.delete(key);
    await expect(
      service.mutate(annotation.id, "submit", 1, author),
    ).rejects.toMatchObject({ status: 409 });
    objects.set(key, original);
    await prisma.documentVersionFile.update({
      where: { id: doc.versions[0].files[0].id },
      data: { deletedAt: new Date() },
    });
    await expect(
      service.mutate(annotation.id, "submit", 1, author),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.annotationSnapshot.count({
        where: { annotationId: annotation.id },
      }),
    ).toBe(0);
  });
  it("returns and reassigns work while retaining submitted snapshots", async () => {
    const { annotation } = await claimed();
    await service.mutate(annotation.id, "save", 0, author, {
      fields: [{ key: "literal", disposition: "NOT_PRESENT", lines: [] }],
    });
    const submitted = await service.mutate(annotation.id, "submit", 1, author);
    const snapshot = await prisma.annotationSnapshot.findFirstOrThrow({
      where: { annotationId: annotation.id },
    });
    const returned = await service.mutate(
      annotation.id,
      "changes",
      submitted.revision,
      admin,
      { note: "Check the second line" },
    );
    expect(returned.note).toBe("Check the second line");
    const reassigned = await service.mutate(
      annotation.id,
      "reassign",
      returned.revision,
      admin,
      { authorId: other.uuid },
    );
    expect(reassigned).toMatchObject({ status: "DRAFT", authorId: other.uuid });
    await expect(
      service.mutate(annotation.id, "save", reassigned.revision, author, {
        fields: [],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await service.mutate(annotation.id, "save", reassigned.revision, other, {
      fields: [{ key: "literal", disposition: "UNREADABLE", lines: [] }],
    });
    expect(
      await prisma.annotationSnapshot.findUnique({
        where: { id: snapshot.id },
      }),
    ).toEqual(snapshot);
  });
  it("uses explicitly published OTHER fallback only while no exact profile is published", async () => {
    const type = await prisma.documentType.findUniqueOrThrow({
      where: { id: typeId },
    });
    const generic = await catalogs.create(
      {
        documentTypeCode: type.code,
        profile: AnnotationProfile.OTHER,
        title: "Generic physical fields",
        fields: [
          {
            key: "literal",
            label: "Literal",
            ordinal: 0,
            multiline: true,
            businessFieldName: null,
          },
        ],
      },
      admin,
    );
    families.push(
      (
        await prisma.annotationCatalog.findUniqueOrThrow({
          where: { id: generic.id },
        })
      ).familyId,
    );
    await catalogs.mutate(generic.id, 0, undefined, true, false, admin);
    const doc = await fixture("uz");
    await prisma.candidate.update({
      where: { id: doc.candidateId! },
      data: { chatUuid: randomUUID() },
    });
    const work = await service.claim(
      { documentId: doc.id, version: 1, catalogId: generic.id },
      author,
    );
    expect(work.schema.profile).toBe("OTHER");
    expect(work.sources.profile).toBe("UZ");
    const specific = await catalogs.create(
      {
        documentTypeCode: type.code,
        profile: AnnotationProfile.UZ,
        title: "UZ physical fields",
        fields: [
          {
            key: "literal",
            label: "Literal",
            ordinal: 0,
            multiline: true,
            businessFieldName: null,
          },
        ],
      },
      admin,
    );
    families.push(
      (
        await prisma.annotationCatalog.findUniqueOrThrow({
          where: { id: specific.id },
        })
      ).familyId,
    );
    await catalogs.mutate(specific.id, 0, undefined, true, false, admin);
    const next = await fixture("uz");
    await prisma.candidate.update({
      where: { id: next.candidateId! },
      data: { chatUuid: randomUUID() },
    });
    await expect(
      service.claim(
        { documentId: next.id, version: 1, catalogId: generic.id },
        author,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await service.claim(
          { documentId: next.id, version: 1, catalogId: specific.id },
          author,
        )
      ).schema.profile,
    ).toBe("UZ");
  });
  it("serializes catalog drafts and allows revisioned draft deletion", async () => {
    const type = await prisma.documentType.findUniqueOrThrow({
      where: { id: typeId },
    });
    const dto = {
      documentTypeCode: type.code,
      profile: AnnotationProfile.RU,
      title: "Next schema",
      fields: [
        {
          key: "new_literal",
          label: "Literal",
          ordinal: 0,
          multiline: false,
          businessFieldName: null,
        },
      ],
    };
    const results = await Promise.allSettled([
      catalogs.create(dto, admin),
      catalogs.create(dto, admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        results.find((r) => r.status === "rejected") as PromiseRejectedResult
      ).reason.getStatus(),
    ).toBe(409);
    const draft = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
        id: string;
      }>
    ).value;
    await catalogs.mutate(draft.id, 0, undefined, false, true, admin);
    expect(
      await prisma.annotationCatalog.findUnique({ where: { id: draft.id } }),
    ).toBeNull();
  });
});
