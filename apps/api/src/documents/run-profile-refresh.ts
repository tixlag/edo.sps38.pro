import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { LkCandidateIdentityService } from "./lk-candidate-identity.service";
import { ErpCandidateClient } from "./erp-candidate.client";
import { CandidateProfileRefresh } from "./candidate-profile-refresh";
import { loadCandidateRefresh } from "./load-candidate-refresh";

dotenvConfig({ path: join(__dirname, "..", "..", "..", "..", ".env") });

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (
    args.some(
      (arg) =>
        !["--apply", "--dry-run"].includes(arg) &&
        !/^--limit=\d+$/.test(arg) &&
        !/^--after=[a-zA-Z0-9_-]{1,64}$/.test(arg),
    ) ||
    (args.includes("--apply") && args.includes("--dry-run"))
  )
    throw new Error("INVALID_ARGUMENTS");
  const limit = Number(
    args.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 20,
  );
  if (
    decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname) !==
    "/edo"
  )
    throw new Error("REFUSED_NON_EDO_DATABASE");
  const config = new ConfigService(process.env);
  const db = new PrismaService();
  const identityService = new LkCandidateIdentityService(config);
  const erp = new ErpCandidateClient(config);
  try {
    const report = await new CandidateProfileRefresh(
      db,
      new AuditService(db),
      (identity, signal) =>
        loadCandidateRefresh(identity, signal, identityService, erp),
    ).run({
      apply: args.includes("--apply"),
      limit,
      after: args.find((arg) => arg.startsWith("--after="))?.slice(8),
      signal: AbortSignal.timeout(120_000),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.failed) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
void main().catch(() => {
  console.error(
    "Candidate profile refresh failed; check configuration and arguments",
  );
  process.exitCode = 1;
});
