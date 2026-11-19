import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { PrismaService } from "../prisma/prisma.service";
import { ErpChangeInboxService } from "./erp-change-inbox";
import { reviewGroupWhere } from "./review-group";

dotenvConfig({
  path: join(__dirname, "..", "..", "..", "..", ".env"),
  quiet: true,
});

async function main() {
  if (new URL(process.env.DATABASE_URL ?? "").pathname !== "/edo")
    throw new Error("REFUSED_NON_EDO_DATABASE");
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const apply = args.includes("--apply");
  const after = args.find((arg) => arg.startsWith("--after="))?.slice(8);
  const limit = Number(
    args.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 200,
  );
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (after && !/^[a-zA-Z0-9-]{1,64}$/.test(after)) ||
    args.some(
      (arg) =>
        arg !== "--apply" &&
        !arg.startsWith("--limit=") &&
        !arg.startsWith("--after="),
    )
  )
    throw new Error("INVALID_BACKFILL_ARGUMENTS");
  const prisma = new PrismaService();
  const inbox = new ErpChangeInboxService(prisma);
  try {
    const candidates = await prisma.candidate.findMany({
      where: {
        AND: [
          reviewGroupWhere("RU"),
          { erpDeleted: false, erpUid: { not: null } },
          ...(after ? [{ id: { gt: after } }] : []),
        ],
      },
      select: { id: true, erpUid: true },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = candidates.slice(0, limit);
    if (apply) {
      for (let index = 0; index < page.length; index += 50)
        await inbox.accept(
          page.slice(index, index + 50).map((candidate) => ({
            eventId: randomUUID(),
            target: "CANDIDATE",
            uid: candidate.erpUid!,
            changes: ["DOCUMENTS"],
          })),
        );
    }
    console.log(
      JSON.stringify({
        applied: apply,
        candidates: page.length,
        nextCursor: candidates.length > limit ? page.at(-1)!.id : null,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch(() => {
  console.error("ERP historical document queue failed");
  process.exitCode = 1;
});
