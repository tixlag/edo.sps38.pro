import "reflect-metadata";
import { resolve } from "node:path";
import { config } from "dotenv";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { AnnotationCatalogService } from "../src/annotations/annotation-catalog.service";
config({ path: resolve(__dirname, "../../../.env"), quiet: true });
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.protocol !== "mysql:" || decodeURIComponent(url.pathname) !== "/edo")
    throw new Error("REFUSED_NON_EDO_DATABASE");
  const prisma = new PrismaService();
  try {
    const service = new AnnotationCatalogService(
      prisma,
      new AuditService(prisma),
    );
    const result = await service.bootstrap({
      uuid: "system:annotation-catalog-bootstrap",
      code1c: null,
      sid: null,
      deviceId: null,
      expiresAt: null,
      accessRules: { "20009": [] },
    });
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch(() => {
  console.error("ANNOTATION_CATALOG_BOOTSTRAP_FAILED");
  process.exitCode = 1;
});
