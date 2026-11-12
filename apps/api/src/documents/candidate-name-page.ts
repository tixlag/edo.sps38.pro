import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

type NamedCandidate = { id: string; fullName: string | null };
type Boundary = { v: 2; blank: boolean; name: string | null; id: string };
type PageQuery = {
  where: Prisma.CandidateWhereInput;
  orderBy: Prisma.CandidateOrderByWithRelationInput[];
  take: number;
};

function boundary(token?: string): Boundary | undefined {
  if (!token) return undefined;
  // Previous review queues used a bare candidate UUID.
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(token)) return undefined;
  try {
    if (token.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(token))
      throw new Error();
    const value = JSON.parse(Buffer.from(token, "base64url").toString());
    if (
      !value ||
      typeof value.id !== "string" ||
      value.id.length > 64 ||
      (value.name !== null &&
        (typeof value.name !== "string" || value.name.length > 512))
    )
      throw new Error();
    // Old catalog and grouped RU cursors restart using the new ordering.
    if (
      value.v === undefined &&
      (value.group === undefined || [0, 1].includes(value.group))
    )
      return undefined;
    if (value.v !== 2 || typeof value.blank !== "boolean") throw new Error();
    if (value.blank !== !value.name?.trim()) throw new Error();
    return value;
  } catch {
    throw new BadRequestException("Invalid candidate cursor");
  }
}

/** Two bounded ORM queries keep unnamed candidates last on MariaDB. */
export async function candidateNamePage<T extends NamedCandidate>(
  read: (query: PageQuery) => Promise<T[]>,
  where: Prisma.CandidateWhereInput,
  limit: number,
  cursor?: string,
) {
  const after = boundary(cursor);
  const rows: T[] = [];
  for (const blank of [false, true]) {
    if (after?.blank && !blank) continue;
    const page = await read({
      where: {
        ...where,
        AND: [
          ...(Array.isArray(where.AND)
            ? where.AND
            : where.AND
              ? [where.AND]
              : []),
          blank
            ? { OR: [{ fullName: null }, { fullName: "" }] }
            : { fullName: { not: null }, NOT: { fullName: "" } },
          ...(after && after.blank === blank
            ? [
                blank
                  ? { id: { gt: after.id } }
                  : {
                      OR: [
                        { fullName: { gt: after.name! } },
                        { fullName: after.name, id: { gt: after.id } },
                      ],
                    },
              ]
            : []),
        ],
      },
      orderBy: blank ? [{ id: "asc" }] : [{ fullName: "asc" }, { id: "asc" }],
      take: limit + 1 - rows.length,
    });
    const seen = new Set(rows.map((row) => row.id));
    rows.push(...page.filter((row) => !seen.has(row.id)));
    if (rows.length > limit) break;
  }
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 2,
              blank: !last.fullName?.trim(),
              name: last.fullName,
              id: last.id,
            } satisfies Boundary),
          ).toString("base64url")
        : null,
  };
}
