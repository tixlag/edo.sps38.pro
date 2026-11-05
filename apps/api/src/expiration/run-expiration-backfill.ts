import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { ExpirationBackfill } from "./expiration-backfill";

dotenvConfig({ path: join(__dirname, "..", "..", "..", "..", ".env") });

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.some((arg) => !["--apply", "--dry-run"].includes(arg) && !/^--limit=\d+$/.test(arg) && !/^--after=[A-Za-z0-9_-]+$/.test(arg)) ||
      (args.includes("--apply") && args.includes("--dry-run")) ||
      args.filter((arg) => arg.startsWith("--limit=")).length > 1 || args.filter((arg) => arg.startsWith("--after=")).length > 1)
    throw new Error("Invalid arguments");
  const limit = Number(args.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid limit");
  const db = new URL(process.env.DATABASE_URL ?? "");
  if (decodeURIComponent(db.pathname) !== "/edo") throw new Error("Refused non-edo database");
  const prisma = new PrismaService();
  try {
    const report = await new ExpirationBackfill(prisma, new AuditService(prisma)).run({
      apply: args.includes("--apply"), limit, after: args.find((arg) => arg.startsWith("--after="))?.slice(8),
    });
    console.log(JSON.stringify(report));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  console.error("Expiration backfill failed; check arguments and configuration.");
  process.exitCode = 1;
});
