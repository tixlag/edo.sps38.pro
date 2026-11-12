import { NestFactory } from "@nestjs/core";
import { join } from "path";
import { config as dotenvConfig } from "dotenv";
import { ErpRetryModule } from "./erp-retry.module";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { DocumentPdfService } from "./document-pdf.service";
import { DocumentDeliveryService } from "./document-delivery.service";
import { isJpegContainer, jpegImageEnd } from "./container-normalization";
import { isInvalidFileContent } from "./erp-retry-selection";

// Load root .env explicitly (do not rely on cwd).
dotenvConfig({ path: join(__dirname, "..", "..", "..", "..", ".env") });

function parseArgs(argv: string[]): {
  dryRun: boolean;
  limit: number;
  documentId?: string;
} {
  let dryRun = true;
  let limit = 50;
  let documentId: string | undefined;
  for (const arg of argv) {
    if (arg === "--apply") dryRun = false;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--limit="))
      limit = Math.max(1, Math.min(500, Number(arg.slice(8)) || 50));
    else if (arg.startsWith("--document=")) documentId = arg.slice(10);
  }
  return { dryRun, limit, documentId };
}

/**
 * Repeat of ERP deliveries that failed with an invalid file container.
 *
 * Only deliveries that can actually be repaired are touched: a single file
 * JPEG whose container carries a removable trailer. Everything else is
 * reported and left for manual handling. The delivery key is reused: a failed
 * attempt leaves no record in the 1C idempotency register.
 */
async function main() {
  const { dryRun, limit, documentId } = parseArgs(process.argv.slice(2));
  process.env.DOCUMENT_WORKER_ENABLED = "false";
  process.env.OCR_WORKER_ENABLED = "false";
  process.env.LK_EVENTS_CONSUME = "0";
  process.env.EDO_ARRIVAL_SYNC_ENABLED = "false";
  const app = await NestFactory.createApplicationContext(ErpRetryModule, {
    logger: ["error", "warn", "log"],
  });
  try {
    const prisma = app.get(PrismaService);
    const storage = app.get(StorageService);
    const pdf = app.get(DocumentPdfService);
    const delivery = app.get(DocumentDeliveryService);
    const rows = await prisma.erpDocumentDelivery.findMany({
      where: {
        status: "REQUIRES_MANUAL",
        transport: "multipart-v2",
        ...(documentId ? { version: { documentId } } : {}),
      },
      include: {
        version: {
          include: {
            document: { select: { id: true, currentVersion: true } },
            files: { where: { deletedAt: null }, orderBy: { ordinal: "asc" } },
            delivery: {
              include: {
                attempts: { orderBy: { startedAt: "desc" }, take: 1 },
              },
            },
          },
        },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
    // eslint-disable-next-line no-console
    console.log(
      `ERP retry: ${rows.length} stuck deliveries (dryRun=${dryRun})`,
    );
    for (const row of rows) {
      const version = row.version;
      const attempt = version.delivery?.attempts?.[0] ?? null;
      const report = {
        deliveryId: row.id,
        documentId: version.documentId,
        version: version.version,
        errorCode: row.errorCode,
      };
      if (version.version !== version.document.currentVersion) {
        // A newer version exists: the historic one is never repeated.
        // eslint-disable-next-line no-console
        console.log(
          `SKIP ${JSON.stringify(report)} reason=historic-version current=${version.document.currentVersion}`,
        );
        continue;
      }
      if (
        !isInvalidFileContent(
          row.errorCode,
          attempt?.responseBody ?? null,
        )
      ) {
        // eslint-disable-next-line no-console
        console.log(
          `SKIP ${JSON.stringify(report)} reason=other-error`,
        );
        continue;
      }
      if (version.files.length !== 1) {
        // eslint-disable-next-line no-console
        console.log(
          `SKIP ${JSON.stringify(report)} reason=not-single-file`,
        );
        continue;
      }
      const file = version.files[0];
      if (file.mimeType !== "image/jpeg") {
        // eslint-disable-next-line no-console
        console.log(
          `SKIP ${JSON.stringify(report)} reason=not-jpeg`,
        );
        continue;
      }
      let trailer = 0;
      try {
        const bytes = await storage.read(file.storageKey, 100 * 1024 * 1024);
        if (!isJpegContainer(bytes)) {
          // eslint-disable-next-line no-console
          console.log(
            `SKIP ${JSON.stringify(report)} reason=not-jpeg-bytes`,
          );
          continue;
        }
        const end = jpegImageEnd(bytes);
        trailer = end === null ? 0 : bytes.length - end;
        if (end === null || trailer <= 0) {
          // eslint-disable-next-line no-console
          console.log(
            `SKIP ${JSON.stringify(report)} reason=no-removable-trailer`,
          );
          continue;
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.log(
          `SKIP ${JSON.stringify(report)} reason=unreadable-source ${error instanceof Error ? error.message : "unknown"}`,
        );
        continue;
      }
      if (dryRun) {
        // eslint-disable-next-line no-console
        console.log(
          `WOULD REPAIR ${JSON.stringify({ ...report, trailerBytes: trailer })}`,
        );
        continue;
      }
      const artifact = await pdf.reprepareCanonical(version.id);
      if (!artifact) {
        // eslint-disable-next-line no-console
        console.log(
          `SKIP ${JSON.stringify(report)} reason=artifact-not-rebuilt`,
        );
        continue;
      }
      await delivery.send(row.id, "erp:retry");
      const updated = await prisma.erpDocumentDelivery.findUniqueOrThrow({
        where: { id: row.id },
        include: { attempts: { orderBy: { startedAt: "desc" }, take: 1 } },
      });
      // eslint-disable-next-line no-console
      console.log(
        `REPAIRED ${JSON.stringify({
          ...report,
          trailerBytes: trailer,
          status: updated.status,
          errorCode: updated.errorCode,
          httpStatus: updated.attempts?.[0]?.httpStatus ?? null,
        })}`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
