import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { DocumentAccessService } from "../src/documents/document-access.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

// Explicit opt-in: only point SELECTs against existing EDO tables, no writes,
// fixtures, migrations or workers. The SQL compiler is the subject of this test.
const databaseUrl = process.env.EDO_REVIEW_READONLY_DATABASE_URL;
const principal = (rules: Record<string, string[]>): AuthPrincipal => ({
  uuid: "sql-reviewer",
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: rules,
});

describe.skipIf(!databaseUrl)("review authorization SQL (read-only)", () => {
  const prisma = new PrismaClient({
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
    log: [{ emit: "event", level: "query" }],
  });
  const queries: string[] = [];
  prisma.$on("query", (event) => queries.push(event.query));
  afterAll(() => prisma.$disconnect());
  const access = new DocumentAccessService(prisma as never);

  it.each([
    { "20009": [] },
    { "20002": [], "20011": [], "20008": [] },
    { "20002": [], "20011": [], "20007": ["98"] },
  ])(
    "keeps identical read and mutation SQL when both review groups are granted: %j",
    async (rules) => {
      const user = principal(rules);
      const id = "__review_access_sql_nonexistent__";
      queries.length = 0;
      await prisma.document.findFirst({
        where: { id, ...access.documentWhere(user) },
        select: { id: true },
      });
      const read = queries.at(-1);
      await prisma.document.findFirst({
        where: { id, ...access.documentReviewWhere(user) },
        select: { id: true },
      });
      expect(queries.at(-1)).toBe(read);
    },
  );

  it.each(["20002", "20011"])(
    "retains the candidate classification in SQL for a single-group reviewer %s",
    async (rule) => {
      queries.length = 0;
      await prisma.document.findFirst({
        where: {
          id: "__review_access_sql_nonexistent__",
          ...access.documentReviewWhere(principal({ [rule]: [], "20008": [] })),
        },
        select: { id: true },
      });
      expect(queries.at(-1)).toContain("`chatUuid`");
      expect(queries.at(-1)).toContain("`citizenship`");
    },
  );
});
