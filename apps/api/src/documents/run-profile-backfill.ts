import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.module";
import { CandidateContextService } from "./candidate-context.service";
import { LkCandidateIdentityService } from "./lk-candidate-identity.service";
import { ErpCandidateClient } from "./erp-candidate.client";
import { CandidateCardCache } from "./candidate-card-cache";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CandidateProfileBackfill } from "./candidate-profile-backfill";

dotenvConfig({ path: join(__dirname, "..", "..", "..", "..", ".env") });

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (
    args.some(
      (arg) =>
        !["--apply", "--dry-run"].includes(arg) && !/^--limit=\d+$/.test(arg),
    ) ||
    (args.includes("--apply") && args.includes("--dry-run"))
  )
    throw new Error("Use --dry-run or --apply, with --limit=1..100");
  const limit = Number(
    args.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 20,
  );
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("INVALID_LIMIT");
  const db = new URL(process.env.DATABASE_URL ?? "");
  if (decodeURIComponent(db.pathname) !== "/edo")
    throw new Error("REFUSED_NON_EDO_DATABASE");
  const config = new ConfigService(process.env);
  const redis = new RedisService(config);
  const contexts = new CandidateContextService(
    new LkCandidateIdentityService(config),
    new ErpCandidateClient(config),
    new CandidateCardCache(redis),
  );
  const loader = (uuid: string, signal: AbortSignal) =>
    contexts.context(uuid, signal);
  const prisma = new PrismaService();
  try {
    const report = await new CandidateProfileBackfill(
      prisma,
      new AuditService(prisma),
      loader,
    ).run({
      apply: args.includes("--apply"),
      limit,
      signal: AbortSignal.timeout(120000),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.failed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  }
}

void main().catch(() => {
  console.error(
    "Candidate profile backfill failed; check configuration and arguments (no credentials logged)",
  );
  process.exitCode = 1;
});
