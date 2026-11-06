import "reflect-metadata";
import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { ErpCandidateClient } from "../src/documents/erp-candidate.client";
import { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";
import type { Prisma } from "@prisma/client";

dotenvConfig({ path: resolve(__dirname, "../../../.env"), quiet: true });

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const parsedUrl = new URL(dbUrl);
  if (
    parsedUrl.protocol !== "mysql:" ||
    decodeURIComponent(parsedUrl.pathname) !== "/edo"
  ) {
    throw new Error("REFUSED_NON_EDO_DATABASE");
  }

  const config = new ConfigService(process.env);
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const erp = new ErpCandidateClient(config, new ErpWorkspaceClient(config));

  try {
    const candidates = await prisma.candidate.findMany({
      where: {
        chatUuid: { not: null },
        erpUid: null,
      },
      include: {
        _count: { select: { documents: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    console.log(
      `Found ${candidates.length} candidate(s) with chatUuid but no erpUid (mode: ${apply ? "APPLY" : "DRY-RUN"}):`,
    );

    for (const cand of candidates) {
      const chatUuid = cand.chatUuid!;
      console.log(`\n--- Processing [${cand.id}] ${cand.fullName} (chat: ${chatUuid}, docs: ${cand._count.documents}) ---`);

      let erpUid: string | undefined;
      let code1c: string | undefined;

      try {
        erpUid = await erp.resolveIdentityByChat(chatUuid);
        try {
          const snapshot = await erp.findByChatUuid(chatUuid);
          if (snapshot.erpUid) erpUid = snapshot.erpUid;
          const rawCode = (snapshot as any).code1C ?? (snapshot as any).code1c;
          if (rawCode) code1c = rawCode;
        } catch {
          // If full snapshot fails (e.g. position missing), erpUid from resolveIdentityByChat is still valid
        }
      } catch (err: any) {
        console.error(`  [ERROR] Failed to resolve ERP candidate for chat ${chatUuid}:`, err.message || err);
        continue;
      }

      if (!erpUid) {
        console.warn(`  [WARN] ERP returned no erpUid for chat ${chatUuid}`);
        continue;
      }

      console.log(`  ERP identity resolved: erpUid=${erpUid}, code1c=${code1c ?? cand.code1c ?? "null"}`);

      // Check for ghost duplicate in database
      const ghost = await prisma.candidate.findFirst({
        where: {
          erpUid,
          id: { not: cand.id },
          chatUuid: null,
        },
        include: {
          _count: { select: { documents: true } },
        },
      });

      if (ghost) {
        console.log(
          `  Found ghost candidate [${ghost.id}] (fullName: ${ghost.fullName}, status: ${ghost.statusId}, docs: ${ghost._count.documents})`,
        );
        if (ghost._count.documents > 0) {
          console.error(`  [SKIP] Ghost [${ghost.id}] has ${ghost._count.documents} document(s)! Manual review required.`);
          continue;
        }
      } else {
        console.log(`  No ghost candidate found for erpUid=${erpUid}`);
      }

      if (dryRun) {
        console.log(`  [DRY-RUN] Would delete ghost ${ghost ? ghost.id : "(none)"} and link cand [${cand.id}] with erpUid=${erpUid}, reviewGroup=RU, code1c=${code1c ?? cand.code1c}`);
        continue;
      }

      // Apply in transaction
      await prisma.$transaction(async (tx) => {
        let ghostMeta: Prisma.CandidateUpdateInput = {};
        if (ghost && ghost._count.documents === 0) {
          ghostMeta = {
            ...(ghost.statusId && !cand.statusId ? { statusId: ghost.statusId } : {}),
            ...(ghost.statusName && !cand.statusName ? { statusName: ghost.statusName } : {}),
            ...(ghost.managerId && !cand.managerId ? { managerId: ghost.managerId } : {}),
            ...(ghost.managerName && !cand.managerName ? { managerName: ghost.managerName } : {}),
            ...(ghost.projectCode && !cand.projectCode ? { projectCode: ghost.projectCode } : {}),
            ...(ghost.projectName && !cand.projectName ? { projectName: ghost.projectName } : {}),
            ...(ghost.positionCode && !cand.positionCode ? { positionCode: ghost.positionCode } : {}),
            ...(ghost.positionName && !cand.positionName ? { positionName: ghost.positionName } : {}),
            ...(ghost.code1c && !cand.code1c ? { code1c: ghost.code1c } : {}),
            ...(ghost.personUid && !cand.personUid ? { personUid: ghost.personUid } : {}),
          };
          await tx.candidate.delete({ where: { id: ghost.id } });
          console.log(`  [APPLY] Deleted ghost candidate [${ghost.id}]`);
        }

        await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${cand.id} FOR UPDATE`;
        await tx.candidate.update({
          where: { id: cand.id },
          data: {
            erpUid,
            reviewGroup: "RU",
            ...(code1c && !cand.code1c ? { code1c } : {}),
            ...ghostMeta,
          },
        });

        await audit.logInTransaction(tx, {
          actorId: "system:reconcile-chat-candidates",
          action: "CANDIDATE_LINKED",
          entityType: "Candidate",
          entityId: cand.id,
          correlationId: "",
          before: { erpUid: cand.erpUid, reviewGroup: cand.reviewGroup },
          after: { erpUid, reviewGroup: "RU", code1c: code1c ?? cand.code1c },
        });

        console.log(`  [APPLY] Candidate [${cand.id}] successfully updated and linked.`);
      });
    }

    console.log("\nFinished processing all candidates.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
