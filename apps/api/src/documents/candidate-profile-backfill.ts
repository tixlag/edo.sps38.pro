import type { Candidate } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import { candidateSnapshotSchema } from "./document-contract";
import { snapshotUpdateInput } from "./candidate-profile";

type ContextLoader = (
  chatUuid: string,
  signal: AbortSignal,
) => Promise<unknown>;
type Result = { candidateId: string; status: string; fields?: string[] };

/** One bounded pass over candidates whose profile has never been synchronized. */
export class CandidateProfileBackfill {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly loadContext: ContextLoader,
  ) {}

  async run(options: { apply: boolean; limit: number; signal: AbortSignal }) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new Error("INVALID_LIMIT");
    const rows = await this.prisma.candidate.findMany({
      where: {
        profileSyncedAt: null,
        chatUuid: { not: null },
        documents: { some: { currentVersion: { gt: 0 } } },
      },
      orderBy: { id: "asc" },
      take: options.limit + 1,
    });
    const results: Result[] = [];
    for (const owner of rows.slice(0, options.limit)) {
      try {
        options.signal.throwIfAborted();
        const context = await this.loadContext(owner.chatUuid!, options.signal);
        const body = context as {
          chatUuid?: unknown;
          code1c?: unknown;
          candidateSnapshot?: { uuid?: unknown };
        } | null;
        const raw = body?.candidateSnapshot;
        if (
          typeof body?.chatUuid !== "string" ||
          body.chatUuid.toLowerCase() !== owner.chatUuid!.toLowerCase() ||
          typeof raw?.uuid !== "string" ||
          raw.uuid.toLowerCase() !== owner.chatUuid!.toLowerCase()
        )
          throw new Error("IDENTITY_MISMATCH");
        if (
          owner.code1c &&
          typeof body.code1c === "string" &&
          body.code1c !== owner.code1c
        )
          throw new Error("EMPLOYEE_LINK_MISMATCH");
        const parsed = candidateSnapshotSchema.safeParse(raw);
        if (!parsed.success) throw new Error("INVALID_PROFILE");
        if (!parsed.data.fullName) throw new Error("MISSING_FULL_NAME");
        const data = snapshotUpdateInput(parsed.data)!;
        if (!options.apply) {
          results.push({
            candidateId: owner.id,
            status: "WOULD_SYNC",
            fields: Object.keys(data),
          });
          continue;
        }
        options.signal.throwIfAborted();
        const applied = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${owner.id} FOR UPDATE`;
          const current = await tx.candidate.findUnique({
            where: { id: owner.id },
          });
          if (
            !current ||
            current.profileSyncedAt ||
            current.chatUuid !== owner.chatUuid ||
            current.code1c !== owner.code1c
          )
            return false;
          await tx.candidate.update({ where: { id: owner.id }, data });
          const before = Object.fromEntries(
            Object.keys(data).map((key) => [
              key,
              current[key as keyof Candidate],
            ]),
          );
          await this.audit.logInTransaction(tx, {
            actorId: "system:candidate-profile-backfill",
            action: "DATA_IMPORTED",
            entityType: "Candidate",
            entityId: owner.id,
            before: JSON.parse(JSON.stringify(before)),
            after: {
              source: "lk-candidate-context",
              profile: JSON.parse(JSON.stringify(data)),
            },
          });
          return true;
        });
        results.push({
          candidateId: owner.id,
          status: applied ? "SYNCED" : "SKIPPED_CONCURRENT",
        });
      } catch (error) {
        // Only fixed error codes reach stdout. No ERP bodies, URLs or PII.
        const allowed = [
          "IDENTITY_MISMATCH",
          "EMPLOYEE_LINK_MISMATCH",
          "INVALID_PROFILE",
          "MISSING_FULL_NAME",
          "LK_HTTP_404",
          "LK_HTTP_503",
          "LK_HTTP_ERROR",
          "LK_UNAVAILABLE",
        ];
        const status =
          error instanceof Error && allowed.includes(error.message)
            ? error.message
            : options.signal.aborted
              ? "DEADLINE_EXCEEDED"
              : "SYNC_FAILED";
        results.push({ candidateId: owner.id, status });
      }
    }
    return {
      mode: options.apply ? "apply" : "dry-run",
      hasMore: rows.length > options.limit,
      synced: results.filter((r) => r.status === "SYNCED").length,
      failed: results.filter(
        (r) =>
          !["SYNCED", "WOULD_SYNC", "SKIPPED_CONCURRENT"].includes(r.status),
      ).length,
      results,
    };
  }
}

export function candidateContextLoader(baseUrl: string): ContextLoader {
  const base = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error("INVALID_LK_BASE_URL");
  return async (chatUuid, signal) => {
    const url = new URL(
      `/surveys-service/api/candidate-documents/by-chat/${encodeURIComponent(chatUuid)}/context`,
      base,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      throw new Error("LK_UNAVAILABLE");
    }
    if (!response.ok)
      throw new Error(
        [404, 503].includes(response.status)
          ? `LK_HTTP_${response.status}`
          : "LK_HTTP_ERROR",
      );
    return response.json();
  };
}
