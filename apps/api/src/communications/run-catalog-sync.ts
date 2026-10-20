import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.module";
import { AuditService } from "../audit/audit.service";
import { DocumentAccessService } from "../documents/document-access.service";
import { CandidateCatalogService } from "./candidate-catalog.service";
import { ErpCommunicationsClient } from "./erp-communications.client";

dotenvConfig({
  path: join(__dirname, "..", "..", "..", "..", ".env"),
  quiet: true,
});
async function main() {
  if (new URL(process.env.DATABASE_URL ?? "").pathname !== "/edo")
    throw new Error("REFUSED_NON_EDO_DATABASE");
  const config = new ConfigService(process.env),
    prisma = new PrismaService(),
    redis = new RedisService(config);
  try {
    const catalog = new CandidateCatalogService(
      prisma,
      redis,
      new ErpCommunicationsClient(config),
      new AuditService(prisma),
      new DocumentAccessService(prisma),
      config,
    );
    await catalog.sync();
    console.log(
      "Candidate catalog sync finished (or skipped because another run holds the lock).",
    );
  } finally {
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  }
}
void main().catch(() => {
  console.error(
    "Candidate catalog sync failed; cached data retained. Check integration configuration and logs.",
  );
  process.exitCode = 1;
});
