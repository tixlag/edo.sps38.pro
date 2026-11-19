import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { IgArrivalFactsProjectionService } from "./ig-arrival-facts-projection.service";
import { IgArrivalFactsWorker } from "./ig-arrival-facts-worker";
import { IgArrivalProjectionService } from "./ig-arrival-projection.service";

dotenvConfig({
  path: join(__dirname, "..", "..", "..", "..", ".env"),
  quiet: true,
});

async function main() {
  if (new URL(process.env.DATABASE_URL ?? "").pathname !== "/edo")
    throw new Error("REFUSED_NON_EDO_DATABASE");
  const config = new ConfigService(process.env);
  const prisma = new PrismaService();
  try {
    const audit = new AuditService(prisma);
    const erp = new ErpWorkspaceClient(config);
    const projection = new IgArrivalFactsProjectionService(prisma, audit, erp);
    const legacyProjection = new IgArrivalProjectionService(prisma, erp, audit);
    await new IgArrivalFactsWorker(
      prisma,
      erp,
      projection,
      config,
      legacyProjection,
      audit,
    ).sync();
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch(() => {
  console.error("Arrival reconciliation did not complete");
  process.exitCode = 1;
});
