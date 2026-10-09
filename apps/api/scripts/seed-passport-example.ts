import "reflect-metadata";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { PrismaClient, type Prisma } from "@prisma/client";
import sharp from "sharp";
import { StorageService } from "../src/storage/storage.service";
import { AuditService } from "../src/audit/audit.service";
import { ocrResultSchema } from "../src/ocr/ocr.service";

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
  // This explicit fixture must never populate a production database or remote S3.
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
  ) {
    throw new Error(
      "Passport example requires NODE_ENV=development, local database edo and local S3",
    );
  }
  if (!Number.isSafeInteger(locationId) || locationId < 1)
    throw new Error("Invalid --location-id");
  const fixture = ocrResultSchema.parse(
    JSON.parse(
      await readFile(join(root, "docs/examples/passport-ocr.json"), "utf8"),
    ),
  );
  if (
    fixture.outcome !== "SUCCEEDED" ||
    fixture.source !== "STUB" ||
    fixture.raw.synthetic !== true
  )
    throw new Error("Expected an explicitly synthetic successful OCR example");
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
        existing.versions.length !== 1 ||
        existing.versions[0].ocrSource !== "STUB")
    )
      throw new Error(
        "Existing document differs from fixture; nothing overwritten",
      );
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
        existing &&
        existing.versions[0].files.find((file) => file.ordinal === ordinal)
          ?.sha256 !== sha256
      )
        throw new Error(
          "Existing file differs from fixture; nothing overwritten",
        );
      files.push({
        ordinal,
        filename,
        storageKey: storage.keyFor(documentId, 1, filename),
        mimeType: "image/png",
        sizeBytes: body.length,
        pageCount: 1,
        sha256,
        path,
      });
    }
    // Recreate the same fixture objects after an ephemeral local S3 restart;
    // retain any manual review/field changes in the database on repeated runs.
    stage = "s3-upload";
    for (const file of files)
      await storage.upload(
        file.storageKey,
        file.path,
        file.mimeType,
        file.sizeBytes,
        AbortSignal.timeout(15_000),
      );
    stage = "database-create";
    if (!existing)
      await prisma.$transaction(async (tx) => {
        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
        });
        if (employee)
          throw new Error(
            "Existing employee differs from fixture; nothing overwritten",
          );
        stage = "employee-create";
        await tx.employee.create({
          data: {
            id: employeeId,
            fullName: fixture.fields.holder_name!,
            country: "Россия",
            position: "Тестовый сотрудник",
            status: "IN_REVIEW",
            stage: "Проверка паспорта · учебный пример",
            locationId,
            lkEmployeeCode1c: exampleCode1c,
          },
        });
        stage = "candidate-create";
        const candidate = await tx.candidate.create({
          data: {
            chatUuid: "00000000-0000-4000-8000-000000000098",
            locationId,
            code1c: exampleCode1c,
          },
        });
        stage = "type-upsert";
        const type = await tx.documentType.upsert({
          where: { code: "PASSPORT" },
          create: { code: "PASSPORT", title: "Паспорт" },
          update: {},
        });
        stage = "document-create";
        await tx.document.create({
          data: {
            id: documentId,
            candidateId: candidate.id,
            documentTypeId: type.id,
            status: "IN_REVIEW",
            versions: {
              create: {
                version: 1,
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
                },
                files: {
                  create: files.map(({ path: _path, ...file }) => file),
                },
                fields: {
                  create: Object.entries(fixture.fields).map(
                    ([name, value]) => ({ name, originalValue: value, value }),
                  ),
                },
                job: {
                  create: {
                    candidateId: candidate.id,
                    idempotencyKey: "local-passport-example-v1",
                    fingerprint: createHash("sha256")
                      .update(JSON.stringify(fixture))
                      .digest("hex"),
                    status: "SUCCEEDED",
                    attempts: 1,
                    correlationId: "local-passport-example",
                  },
                },
              },
            },
          },
        });
        stage = "audit-create";
        for (const action of [
          "EMPLOYEE_CREATED",
          "DOCUMENT_UPLOADED",
          "DOCUMENT_OCR_COMPLETED",
          "CANDIDATE_LINKED",
        ] as const)
          await audit.logInTransaction(tx, {
            actorId: "local-example",
            action,
            entityType:
              action === "EMPLOYEE_CREATED"
                ? "Employee"
                : action === "CANDIDATE_LINKED"
                  ? "Candidate"
                  : "Document",
            entityId:
              action === "EMPLOYEE_CREATED"
                ? employeeId
                : action === "CANDIDATE_LINKED"
                  ? candidate.id
                  : documentId,
            correlationId: "local-passport-example",
            after: {
              synthetic: true,
              source: "STUB",
              locationId,
              status: "IN_REVIEW",
            },
          });
      });
    console.log(
      `Учебный пример: https://edo.localhost:12443/employees/${employeeId}`,
    );
    console.log(
      existing
        ? "Оригиналы восстановлены; исправления и подтверждение сохранены."
        : `Паспорт: 2 страницы, OCR завершено (STUB), ожидает проверки. Объект доступа: ${locationId}.`,
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
  if (error instanceof Error) {
    const diagnostic = error.message.match(
      /(?:Data truncated for column '[a-zA-Z_]+'|Unknown column '[a-zA-Z_.]+'|Unknown argument `[a-zA-Z_]+`|Column count doesn't match value count|Cannot add or update a child row|MysqlError \{ code: [0-9]+)/,
    );
    if (diagnostic) console.error(diagnostic[0]);
  }
  process.exitCode = 1;
});
