import "reflect-metadata";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";

const root = resolve(__dirname, "../../..");
loadEnv({ path: join(root, ".env"), quiet: true });

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (
    args.some(
      (arg) =>
        !["--apply", "--dry-run"].includes(arg) &&
        !/^--(?:limit|annotation-id|out)=.+$/.test(arg),
    ) ||
    (args.includes("--apply") && args.includes("--dry-run"))
  )
    throw new Error("INVALID_ARGUMENTS");
  const option = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const limit = Number(option("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("INVALID_LIMIT");
  const id = option("annotation-id");
  if (id && !/^[-a-zA-Z0-9_]{1,64}$/.test(id))
    throw new Error("INVALID_ANNOTATION_ID");
  const database = new URL(process.env.DATABASE_URL ?? "");
  if (
    database.protocol !== "mysql:" ||
    decodeURIComponent(database.pathname) !== "/edo"
  )
    throw new Error("REFUSED_NON_EDO_DATABASE");
  const outputDir = resolve(
    root,
    option("out") ??
      `.cache/ocr-exports/${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const prisma = new PrismaService();
  const storage = new StorageService(new ConfigService(process.env));
  try {
    // Deliberately no Nest application bootstrap: no consumers, cron or writers.
    const annotations = await prisma.documentAnnotation.findMany({
      where: { status: "ACCEPTED", ...(id ? { id } : {}) },
      orderBy: { id: "asc" },
      take: limit,
      include: {
        snapshots: {
          where: { status: "ACCEPTED" },
          orderBy: { revision: "desc" },
          take: 1,
        },
        version: { include: { files: true } },
      },
    });
    if (!annotations.length) throw new Error("NO_ACCEPTED_ANNOTATIONS");
    const records = annotations.map((annotation) => {
      const snapshot = annotation.snapshots[0];
      if (!snapshot) throw new Error("ACCEPTED_SNAPSHOT_MISSING");
      if (
        !["IN_REVIEW", "APPROVED", "SIGNED"].includes(
          annotation.version.status,
        ) ||
        annotation.version.cleanupPending
      )
        throw new Error("SOURCE_UNAVAILABLE");
      const payload = snapshot.payload as unknown as {
        annotation: Record<string, unknown>;
        sources: {
          pages: Array<{
            fileId: string;
            storageKey: string;
            sha256: string;
            sizeBytes: number;
          }>;
        };
      };
      if (!payload.annotation || !payload.sources?.pages?.length)
        throw new Error("INVALID_SNAPSHOT");
      for (const source of payload.sources.pages) {
        const file = annotation.version.files.find(
          (f) => f.id === source.fileId,
        );
        if (
          !file ||
          file.deletedAt ||
          file.storageKey !== source.storageKey ||
          file.sizeBytes !== source.sizeBytes ||
          (file.sha256 && file.sha256 !== source.sha256)
        )
          throw new Error("SOURCE_UNAVAILABLE");
      }
      return snapshot;
    });
    // Preserve native ESM loading when this entry point runs under ts-node CJS.
    const load = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{ exportAccepted: (options: unknown) => Promise<unknown> }>;
    const exporter = await load(
      pathToFileURL(join(root, "tools/ocr-export/src/export.mjs")).href,
    );
    const report = await exporter.exportAccepted({
      records,
      outputDir,
      dryRun: !args.includes("--apply"),
      readSource: (source: { storageKey: string }) =>
        storage.read(source.storageKey, 50 * 1024 * 1024),
    });
    console.log(
      JSON.stringify({
        mode: args.includes("--apply") ? "apply" : "dry-run",
        ...(report as object),
      }),
    );
  } finally {
    await prisma.$disconnect();
    storage.onModuleDestroy();
  }
}

void main().catch((error) => {
  // Never log database/S3 errors or source text. Only stable exporter codes.
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.message)
      ? error.message
      : "ANNOTATION_EXPORT_FAILED";
  console.error(code);
  process.exitCode = 1;
});
