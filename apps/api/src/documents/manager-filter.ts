import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { MANAGER_KEY_PATTERN } from "../common/query-values";

export function managerFilter(
  keys: string[],
): Prisma.CandidateWhereInput | undefined {
  if (!keys.length) return undefined;
  return {
    OR: keys.map((key) => {
      if (!MANAGER_KEY_PATTERN.test(key))
        throw new BadRequestException("Invalid manager selector");
      if (key.startsWith("id:")) return { managerId: key.slice(3) };
      if (key.startsWith("code:")) return { managerCode1c: key.slice(5) };
      const noCode = { OR: [{ managerCode1c: null }, { managerCode1c: "" }] };
      return {
        AND: [
          noCode,
          key.startsWith("name:")
            ? { managerName: key.slice(5) }
            : { OR: [{ managerName: null }, { managerName: "" }] },
        ],
      };
    }),
  };
}

/** SQL twin for aggregate queries; values always remain bound parameters. */
export function managerFilterSql(keys: string[]): Prisma.Sql {
  if (!keys.length) return Prisma.sql`1=1`;
  const conditions = keys.map((key) => {
    if (!MANAGER_KEY_PATTERN.test(key))
      throw new BadRequestException("Invalid manager selector");
    if (key.startsWith("id:")) return Prisma.sql`c.managerId = ${key.slice(3)}`;
    if (key.startsWith("code:"))
      return Prisma.sql`c.managerCode1c = ${key.slice(5)}`;
    if (key.startsWith("name:"))
      return Prisma.sql`((c.managerCode1c IS NULL OR c.managerCode1c = '') AND c.managerName = ${key.slice(5)})`;
    return Prisma.sql`((c.managerCode1c IS NULL OR c.managerCode1c = '') AND (c.managerName IS NULL OR TRIM(c.managerName) = ''))`;
  });
  return Prisma.sql`(${Prisma.join(conditions, " OR ")})`;
}
