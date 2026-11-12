/** URL arrays are bounded; legacy single-value links keep working. */
export function parseFilterValues(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value : [value];
  if (
    items.length > 100 ||
    items.some((item) => typeof item !== "string" || item.length > 517)
  )
    return undefined;
  return [
    ...new Set((items as string[]).map((item) => item.trim()).filter(Boolean)),
  ];
}

export function filterValues(
  raw: Record<string, unknown>,
  plural: string,
  singular?: string,
): string[] {
  return (
    parseFilterValues(raw[plural]) ??
    (singular ? parseFilterValues(raw[singular]) : undefined) ??
    []
  );
}
