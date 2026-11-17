/** Preserve foreign and ambiguous numbers; only an explicit 7/8 Russian trunk is canonical. */
export function normalizeCandidatePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[\s()-]/gu, "");
  if (/^(?:\+7|7|8)\d{10}$/u.test(digits)) {
    return `+7${digits.replace(/^(?:\+7|7|8)/u, "")}`;
  }
  return trimmed;
}

export function normalizeCandidateNameForSearch(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
