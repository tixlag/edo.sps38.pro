/** Only an explicit Russian country or trunk prefix proves a Russian number. */
export function normalizeRussianPhone(value: string): string {
  const compact = value.trim().replace(/[\s()-]/g, "");
  return /^(?:\+7|7|8)\d{10}$/.test(compact)
    ? `+7${compact.replace(/^(?:\+7|7|8)/, "")}`
    : value;
}

export function formatPhoneForDisplay(value: string): string {
  const normalized = normalizeRussianPhone(value);
  const match = /^\+7([0-9]{3})([0-9]{3})([0-9]{2})([0-9]{2})$/.exec(normalized);
  return match
    ? `+7 (${match[1]}) ${match[2]}-${match[3]}-${match[4]}`
    : value;
}
