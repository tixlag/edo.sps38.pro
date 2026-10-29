import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import { candidateSnapshotSchema } from "./document-contract";
import { changedProfileFields, snapshotUpdateInput } from "./candidate-profile";

type Identity = { chatUuid: string | null; code1c: string | null };
type Loader = (
  identity: Identity,
  signal: AbortSignal,
) => Promise<{
  chatUuid: string | null;
  code1c: string | null;
  candidateSnapshot?: unknown;
}>;

export class CandidateProfileRefresh {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly load: Loader,
  ) {}

  async run(options: {
    apply: boolean;
    limit: number;
    after?: string;
    signal: AbortSignal;
  }) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new Error("INVALID_LIMIT");
    const rows = await this.db.candidate.findMany({
      where: {
        OR: [{ chatUuid: { not: null } }, { code1c: { not: null } }],
        ...(options.after ? { id: { gt: options.after } } : {}),
      },
      orderBy: { id: "asc" },
      take: options.limit + 1,
    });
    const results: {
      candidateId: string;
      status: string;
      fields?: string[];
    }[] = [];
    for (const row of rows.slice(0, options.limit)) {
      try {
        options.signal.throwIfAborted();
        const context = await this.load(row, options.signal);
        if (
          (row.chatUuid &&
            context.chatUuid?.toLowerCase() !== row.chatUuid.toLowerCase()) ||
          (row.code1c && context.code1c !== row.code1c)
        )
          throw new Error("IDENTITY_MISMATCH");
        const parsed = candidateSnapshotSchema.parse(context.candidateSnapshot);
        const data = snapshotUpdateInput(parsed);
        if (!data) throw new Error("INVALID_PROFILE");
        const keys = changedProfileFields(row, data);
        if (!options.apply) {
          results.push({
            candidateId: row.id,
            status: "WOULD_SYNC",
            fields: keys,
          });
          continue;
        }
        options.signal.throwIfAborted();
        const updated = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${row.id} FOR UPDATE`;
          const current = await tx.candidate.findUnique({
            where: { id: row.id },
          });
          if (
            !current ||
            current.chatUuid !== row.chatUuid ||
            current.code1c !== row.code1c ||
            current.updatedAt.getTime() !== row.updatedAt.getTime()
          )
            return false;
          const before = Object.fromEntries(
            keys.map((key) => [
              key,
              (current as unknown as Record<string, unknown>)[key] ?? null,
            ]),
          );
          const after = Object.fromEntries(
            keys.map((key) => [key, (data as Record<string, unknown>)[key]]),
          );
          await tx.candidate.update({ where: { id: row.id }, data });
          await this.audit.logInTransaction(tx, {
            actorId: "system:candidate-profile-refresh",
            action: "DATA_IMPORTED",
            entityType: "Candidate",
            entityId: row.id,
            before: JSON.parse(JSON.stringify(before)),
            after: JSON.parse(JSON.stringify(after)),
          });
          return true;
        });
        results.push({
          candidateId: row.id,
          status: updated ? "SYNCED" : "SKIPPED_CONCURRENT",
        });
      } catch (error) {
        results.push({
          candidateId: row.id,
          status: options.signal.aborted
            ? "DEADLINE_EXCEEDED"
            : error instanceof Error && error.message === "IDENTITY_MISMATCH"
              ? "IDENTITY_MISMATCH"
              : "SYNC_FAILED",
        });
      }
    }
    const processed = rows.slice(0, options.limit);
    return {
      mode: options.apply ? "apply" : "dry-run",
      results,
      nextCursor:
        rows.length > options.limit ? (processed.at(-1)?.id ?? null) : null,
      failed: results.filter(
        (r) =>
          !["SYNCED", "WOULD_SYNC", "SKIPPED_CONCURRENT"].includes(r.status),
      ).length,
    };
  }
}
