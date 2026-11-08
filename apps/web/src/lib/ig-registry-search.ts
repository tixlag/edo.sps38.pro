/** Validated, bounded view state that survives a trip to a document. */
export function parseIgRegistrySearch(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (raw.view === "arrivals") result.view = "arrivals";
  if (raw.igArchive === "archive" || raw.igArchive === "current")
    result.igArchive = raw.igArchive;
  for (const key of ["igQ", "igLocationUid", "igCursor"] as const) {
    const value = typeof raw[key] === "string" ? raw[key].trim() : "";
    if (value && value.length <= 2048) result[key] = value;
  }
  for (const key of ["igDateFrom", "igDateTo"] as const) {
    if (typeof raw[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw[key]))
      result[key] = raw[key];
  }
  if (
    ["UNKNOWN", "NO_DOCUMENTS", "IN_PROGRESS", "RETURNED", "APPROVED"].includes(
      String(raw.igDocumentStatus),
    )
  )
    result.igDocumentStatus = raw.igDocumentStatus;
  if (raw.igNeedsAttention === true || raw.igNeedsAttention === "true")
    result.igNeedsAttention = true;
  for (const key of ["igGroups", "igDates", "igPages"] as const) {
    if (typeof raw[key] !== "string" || raw[key].length > 8192) continue;
    try {
      const value: unknown = JSON.parse(raw[key]);
      if (
        key !== "igPages" &&
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((item) => typeof item === "string" && item.length <= 1024)
      )
        result[key] = JSON.stringify(value);
      if (
        key === "igPages" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 50 &&
        Object.entries(value).every(
          ([k, v]) =>
            k.length <= 1024 && typeof v === "string" && v.length <= 2048,
        )
      )
        result[key] = JSON.stringify(value);
    } catch {
      /* Invalid URL state is ignored. */
    }
  }
  if (
    typeof raw.igParticipation === "string" &&
    raw.igParticipation.length <= 2048
  ) {
    try {
      const value = JSON.parse(raw.igParticipation) as Record<string, unknown>;
      if (
        value &&
        typeof value === "object" &&
        ["CURRENT", "HISTORICAL", "CANCELLED", "ISSUE"].includes(
          String(value.status),
        )
      ) {
        const clean = Object.fromEntries(
          ["memberUid", "date", "location", "status"].flatMap((key) =>
            typeof value[key] === "string" &&
            (value[key] as string).length <= 512
              ? [[key, value[key]]]
              : [],
          ),
        );
        result.igParticipation = JSON.stringify(clean);
      }
    } catch {
      /* Invalid URL state is ignored. */
    }
  }
  return result;
}
