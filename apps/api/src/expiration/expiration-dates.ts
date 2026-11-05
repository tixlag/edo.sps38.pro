export const ALERT_THRESHOLDS = [30, 15, 7, 1, 0] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

export type ExpirationSeverity =
  | "NORMAL"
  | "WARNING"
  | "URGENT"
  | "CRITICAL"
  | "EMERGENCY"
  | "EXPIRED";

/** Last DATE value within the next 30 Irkutsk calendar days. */
export function expirationScanCutoff(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Irkutsk", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (name: string) => Number(parts.find((p) => p.type === name)?.value);
  return new Date(Date.UTC(value("year"), value("month") - 1, value("day") + 30));
}

const EXPIRATION_FIELD_KEYS = [
  "expiryDate",
  "expiry_date",
  "stay_until",
  "valid_until",
  "pas_date_of_expiry",
  "registration_until",
  "category_until",
] as const;

/**
 * Extracts a normalized Date object from dynamic document version fields.
 * Supports ISO YYYY-MM-DD and Russian DD.MM.YYYY formats.
 */
export function extractExpirationDateFromFields(
  fields: Record<string, unknown>,
): Date | null {
  for (const key of EXPIRATION_FIELD_KEYS) {
    const raw = fields[key];
    if (typeof raw !== "string") continue;
    const val = raw.trim();
    if (!val) continue;

    // ISO YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const parsed = new Date(`${val}T00:00:00.000Z`);
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === val) {
        return parsed;
      }
    }

    // Russian DD.MM.YYYY
    const ruMatch = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(val);
    if (ruMatch) {
      const [, day, month, year] = ruMatch;
      const parsed = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === `${year}-${month}-${day}`) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * Computes calendar days remaining until expiration in Asia/Irkutsk (+08:00) timezone.
 */
export function computeDaysRemaining(expiresAt: Date, now = new Date()): number {
  const timeZone = "Asia/Irkutsk";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = (date: Date) => Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, Number(value)]),
  );
  const today = parts(now);
  // DATE values represent calendar dates and are stored at UTC midnight.
  const [y1, m1, d1] = [today.year, today.month, today.day];
  const [y2, m2, d2] = [expiresAt.getUTCFullYear(), expiresAt.getUTCMonth() + 1, expiresAt.getUTCDate()];

  const utc1 = Date.UTC(y1, m1 - 1, d1);
  const utc2 = Date.UTC(y2, m2 - 1, d2);

  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  return Math.floor((utc2 - utc1) / MS_PER_DAY);
}

/**
 * Maps days remaining to an actionable severity level.
 */
export function getExpirationSeverity(daysRemaining: number): ExpirationSeverity {
  if (daysRemaining < 0) return "EXPIRED";
  if (daysRemaining <= 1) return "EMERGENCY";
  if (daysRemaining <= 7) return "CRITICAL";
  if (daysRemaining <= 15) return "URGENT";
  if (daysRemaining <= 30) return "WARNING";
  return "NORMAL";
}

/**
 * Finds the highest-priority (strictest) applicable threshold for notification.
 * Thresholds: 0 (expired or today), 1, 7, 15, 30.
 */
export function matchApplicableThreshold(daysRemaining: number): AlertThreshold | null {
  if (daysRemaining <= 0) return 0;
  if (daysRemaining <= 1) return 1;
  if (daysRemaining <= 7) return 7;
  if (daysRemaining <= 15) return 15;
  if (daysRemaining <= 30) return 30;
  return null;
}
