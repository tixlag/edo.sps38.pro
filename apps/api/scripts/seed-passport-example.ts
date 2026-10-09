import "reflect-metadata";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { PrismaClient, type Prisma } from "@prisma/client";
import sharp from "sharp";
import { StorageService } from "../src/storage/storage.service";
import { AuditService } from "../src/audit/audit.service";
import { validateOcrResult } from "../src/ocr/ocr.service";

const root = join(__dirname, "..", "..", "..");
config({ path: join(root, ".env"), quiet: true });
const employeeId = "emp-passport-example";
const documentId = "doc-passport-example";
const exampleCode1c = "LOCAL-EXAMPLE-PASSPORT";
let stage = "configuration";
const locationArgument = process.argv
  .slice(2)
  .find((value) => value.startsWith("--location-id="));
const locationId = Number(locationArgument?.split("=")[1] ?? 98);

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? "");
  const endpoint = new URL(process.env.S3_ENDPOINT ?? "");
  const loopback = (host: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (
    process.env.NODE_ENV !== "development" ||
    database.protocol !== "mysql:" ||
    database.pathname !== "/edo" ||
    !loopback(database.hostname) ||
    !loopback(endpoint.hostname)
  )
    throw new Error(
      "Passport example requires development, local database edo and local S3",
    );
  if (!Number.isSafeInteger(locationId) || locationId < 1)
    throw new Error("Invalid --location-id");
  const fixture = validateOcrResult(
    JSON.parse(
      await readFile(join(root, "docs/examples/passport-ocr.json"), "utf8"),
    ),
    [
      { ordinal: 0, pageCount: 1 },
      { ordinal: 1, pageCount: 1 },
    ],
  );
  if (
    fixture.outcome !== "SUCCEEDED" ||
    fixture.source !== "STUB" ||
    fixture.raw.synthetic !== true
  )
    throw new Error("Expected a synthetic successful OCR example");
  const prisma = new PrismaClient();
  const storage = new StorageService(new ConfigService(process.env));
  const audit = new AuditService(prisma as never);
  try {
    stage = "database-read";
    const existing = await prisma.document.findUnique({
      where: { id: documentId },
      include: { candidate: true, versions: { include: { files: true } } },
    });
    if (
      existing &&
      (existing.candidate?.code1c !== exampleCode1c ||
        existing.versions.some((version) => version.ocrSource !== "STUB"))
    )
      throw new Error(
        "Existing document differs from fixture; nothing overwritten",
      );
    const target = existing?.versions.find(
      (version) =>
        (version.ocrRaw as Record<string, unknown> | null)?.exampleVersion ===
        fixture.raw.exampleVersion,
    );
    const exampleVersion =
      target?.version ?? (existing?.currentVersion ?? 0) + 1;
    if (existing && existing.currentVersion > exampleVersion)
      throw new Error("A newer example version exists; nothing overwritten");
    stage = "render-files";
    const cache = join(root, ".cache/passport-example");
    await mkdir(cache, { recursive: true });
    const files: Array<
      Omit<Prisma.DocumentVersionFileCreateManyInput, "versionId"> & {
        path: string;
      }
    > = [];
    for (const [ordinal, name] of ["main", "registration"].entries()) {
      const filename = `passport-${name}.png`;
      const path = join(cache, filename);
      await sharp(
        await readFile(join(root, `docs/examples/passport-${name}.svg`)),
      )
        .png()
        .toFile(path);
      const body = await readFile(path);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (
        target &&
        target.files.find((file) => file.ordinal === ordinal)?.sha256 !== sha256
      )
        throw new Error(
          "Existing file differs from fixture; nothing overwritten",
        );
      files.push({
        id: randomUUID(),
        ordinal,
        filename,
        storageKey: storage.keyFor(documentId, exampleVersion, filename),
        mimeType: "image/png",
        sizeBytes: body.length,
        pageCount: 1,
        sha256,
        path,
      });
    }
    stage = "s3-upload";
    // Repeat runs restore the same objects, never reset field edits or approval.
    for (const file of files)
      await storage.upload(
        file.storageKey,
        file.path,
        file.mimeType,
        file.sizeBytes,
        AbortSignal.timeout(15_000),
      );
    if (!target) {
      stage = "database-create";
      await prisma.$transaction(async (tx) => {
        let candidateId = existing?.candidateId;
        if (!existing) {
          if (await tx.employee.findUnique({ where: { id: employeeId } }))
            throw new Error("Existing employee differs from fixture");
          await tx.employee.create({
            data: {
              id: employeeId,
              fullName: "Иванов Иван Иванович",
              country: "Россия",
              position: "Тестовый сотрудник",
              status: "IN_REVIEW",
              stage: "Проверка паспорта · учебный пример",
              locationId,
              lkEmployeeCode1c: exampleCode1c,
            },
          });
          const candidate = await tx.candidate.create({
            data: {
              chatUuid: "00000000-0000-4000-8000-000000000098",
              locationId,
              code1c: exampleCode1c,
            },
          });
          candidateId = candidate.id;
          const type = await tx.documentType.upsert({
            where: { code: "PASSPORT" },
            create: { code: "PASSPORT", title: "Паспорт" },
            update: {},
          });
          await tx.document.create({
            data: {
              id: documentId,
              candidateId,
              documentTypeId: type.id,
              status: "IN_REVIEW",
              currentVersion: exampleVersion,
            },
          });
          for (const [action, entityType, entityId] of [
            ["EMPLOYEE_CREATED", "Employee", employeeId],
            ["CANDIDATE_LINKED", "Candidate", candidateId],
          ] as const)
            await audit.logInTransaction(tx, {
              actorId: "local-example",
              action,
              entityType,
              entityId,
              correlationId: "local-passport-example",
              after: { synthetic: true, locationId },
            });
        }
        if (!candidateId) throw new Error("Example candidate missing");
        await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`;
        const current = await tx.document.findUniqueOrThrow({
          where: { id: documentId },
        });
        if (current.currentVersion > exampleVersion)
          throw new Error("Newer upload preserved");
        const version = await tx.documentVersion.create({
          data: {
            documentId,
            version: exampleVersion,
            storageKey: files[0].storageKey,
            mimeType: "image/png",
            sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
            status: "IN_REVIEW",
            ocrSource: "STUB",
            ocrRaw: {
              ...fixture.raw,
              outcome: fixture.outcome,
              source: fixture.source,
              fields: fixture.fields,
              regions: fixture.regions ?? [],
            },
          },
        });
        await tx.documentVersionFile.createMany({
          data: files.map(({ path: _path, ...file }) => ({
            ...file,
            versionId: version.id,
          })),
        });
        const fields = Object.entries(fixture.fields).map(([name, value]) => ({
          id: randomUUID(),
          versionId: version.id,
          name,
          originalValue: value,
          value,
        }));
        await tx.documentVersionField.createMany({ data: fields });
        const regions = (fixture.regions ?? []).map((region) => {
          const field = fields.find((item) => item.name === region.fieldName);
          const file = files.find(
            (item) => item.ordinal === region.fileOrdinal,
          );
          if (!field || !file?.id) throw new Error("Invalid example region");
          return {
            fieldId: field.id,
            fileId: file.id,
            pageNumber: region.pageNumber,
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            text: region.text ?? null,
          };
        });
        if (regions.length) await tx.ocrRegion.createMany({ data: regions });
        await tx.ocrJob.create({
          data: {
            candidateId,
            versionId: version.id,
            idempotencyKey: `local-passport-example-v${exampleVersion}`,
            fingerprint: createHash("sha256")
              .update(JSON.stringify(fixture))
              .digest("hex"),
            status: "SUCCEEDED",
            attempts: 1,
            correlationId: "local-passport-example",
          },
        });
        await tx.document.update({
          where: { id: documentId },
          data: { currentVersion: exampleVersion, status: "IN_REVIEW" },
        });
        for (const action of [
          "DOCUMENT_UPLOADED",
          "DOCUMENT_OCR_COMPLETED",
        ] as const)
          await audit.logInTransaction(tx, {
            actorId: "local-example",
            action,
            entityType: "Document",
            entityId: documentId,
            correlationId: "local-passport-example",
            before: { version: existing?.currentVersion ?? null },
            after: {
              synthetic: true,
              source: "STUB",
              version: exampleVersion,
              status: "IN_REVIEW",
              regionCount: regions.length,
            },
          });
      });
    }
    console.log(
      `Учебный пример: https://edo.localhost:12443/employees/${employeeId}`,
    );
    console.log(
      target
        ? "Оригиналы восстановлены; исправления и подтверждение сохранены."
        : `Версия ${exampleVersion}: 2 страницы, 10 областей OCR, ошибка в номере для ручной проверки. Предыдущие версии сохранены.`,
    );
  } finally {
    storage.onModuleDestroy();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Не удалось создать учебный пример. Проверьте локальную БД, S3 и отсутствие конфликтующих записей.",
  );
  console.error(
    "Этап:",
    stage,
    "категория:",
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.name
        : "Unknown",
  );
  process.exitCode = 1;
});
