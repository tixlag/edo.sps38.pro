const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RU_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

export function isDateFieldName(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return (
    /(^|_)date(_|$)/.test(normalized) ||
    /(^|_)birth_date$/.test(normalized) ||
    /(^|_)(issued_at|issue_date|expires_at|expiry_date|expiration_date)$/.test(
      normalized,
    ) ||
    /^mg_duration_(from|to)$/.test(normalized)
  );
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Formats supported date values as strict dd.mm.yyyy. Invalid values are hidden. */
export function formatDateRu(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "—";
  const iso = ISO_DATE.exec(text);
  if (iso && isValidDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
    return `${iso[3]}.${iso[2]}.${iso[1]}`;
  }
  const ru = RU_DATE.exec(text);
  if (ru && isValidDate(Number(ru[3]), Number(ru[2]), Number(ru[1]))) {
    return text;
  }
  const timestamp = /^(\d{4}-\d{2}-\d{2})T/.exec(text);
  if (timestamp) {
    return formatDateRu(timestamp[1]);
  }
  return "—";
}

/** Converts a strictly entered dd.mm.yyyy value to the API's ISO date format. */
export function parseDateRu(value: string): string | undefined {
  const match = RU_DATE.exec(value.trim());
  if (!match) return undefined;
  const [, day, month, year] = match;
  if (!isValidDate(Number(year), Number(month), Number(day))) return undefined;
  return `${year}-${month}-${day}`;
}

/** Accepts either supported display form and returns a canonical API date. */
export function normalizeDateForApi(value: string): string | undefined {
  const timestamp = /^(\d{4}-\d{2}-\d{2})T/.exec(value.trim());
  if (timestamp) {
    const iso = ISO_DATE.exec(timestamp[1]);
    if (iso && isValidDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
      return timestamp[1];
    }
    return undefined;
  }
  const displayed = formatDateRu(value);
  return displayed === "—" ? undefined : parseDateRu(displayed);
}

/** Date portion is always dd.mm.yyyy; time remains a separate hh:mm value. */
export function formatDateTimeRu(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const datePart = `${String(date.getDate()).padStart(2, "0")}.${String(
    date.getMonth() + 1,
  ).padStart(2, "0")}.${date.getFullYear()}`;
  const timePart = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
  return `${datePart} ${timePart}`;
}

/** Keeps an editable date value visibly in dd.mm.yyyy order while typing. */
export function maskDateRuInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}
