import { BadRequestException } from "@nestjs/common";
export interface CatalogField {
  key: string;
  label: string;
  ordinal: number;
  multiline?: boolean;
  businessFieldName?: string | null;
}
export interface AnnotationLine {
  id: string;
  pageId: string;
  order: number;
  text: string;
  quad: number[];
}
export interface FieldAnswer {
  key: string;
  disposition: string;
  lines: AnnotationLine[];
}
export interface PageFrame {
  id: string;
  width: number;
  height: number;
}
function bad(message: string): never {
  throw new BadRequestException(message);
}
export function validateAnswers(
  input: unknown,
  schema: CatalogField[],
  pages: PageFrame[],
  complete: boolean,
): FieldAnswer[] {
  if (!Array.isArray(input) || input.length > 200)
    bad("Invalid annotation fields");
  const answers = input as FieldAnswer[],
    seen = new Set<string>(),
    lineIds = new Set<string>();
  let count = 0;
  for (const answer of answers) {
    const field = schema.find((f) => f.key === answer?.key);
    if (
      !field ||
      seen.has(answer.key) ||
      !["PRESENT", "NOT_PRESENT", "UNREADABLE"].includes(answer.disposition) ||
      !Array.isArray(answer.lines)
    )
      bad("Invalid field answer");
    seen.add(answer.key);
    if (answer.disposition !== "PRESENT" && answer.lines.length)
      bad("Absent or unreadable field cannot have lines");
    if (complete && answer.disposition === "PRESENT" && !answer.lines.length)
      bad("Present field requires a line");
    if (!field.multiline && answer.lines.length > 1)
      bad("Field allows one visual line");
    const orders = new Set<number>();
    for (const line of answer.lines) {
      if (++count > 1000) bad("Too many annotation lines");
      if (
        !line ||
        typeof line.id !== "string" ||
        !/^[-a-zA-Z0-9_:]{1,64}$/.test(line.id) ||
        lineIds.has(line.id)
      )
        bad("Invalid line identifier");
      lineIds.add(line.id);
      if (
        !Number.isSafeInteger(line.order) ||
        line.order < 0 ||
        line.order > 1000 ||
        orders.has(line.order)
      )
        bad("Invalid line order");
      orders.add(line.order);
      if (
        typeof line.text !== "string" ||
        (complete && !line.text.trim()) ||
        line.text.length > 2000 ||
        Array.from(line.text).some((c) => {
          const code = c.charCodeAt(0);
          return (
            code < 32 ||
            (code >= 127 && code <= 159) ||
            code === 0x2028 ||
            code === 0x2029
          );
        })
      )
        bad("Line must contain literal text without controls");
      const page = pages.find((p) => p.id === line.pageId);
      if (!page) bad("Unknown source page");
      const q = line.quad;
      if (
        !Array.isArray(q) ||
        q.length !== 8 ||
        q.some((n) => !Number.isFinite(n) || n < 0 || n > 1)
      )
        bad("Invalid line rectangle");
      const points = Array.from({ length: 4 }, (_, i) => [
        q[i * 2] * page.width,
        q[i * 2 + 1] * page.height,
      ]);
      const vectors = points.map((p, i) => [
        points[(i + 1) % 4][0] - p[0],
        points[(i + 1) % 4][1] - p[1],
      ]);
      const lengths = vectors.map((v) => Math.hypot(...v));
      if (lengths.some((n) => n < 1)) bad("Line rectangle too small");
      for (let i = 0; i < 4; i++) {
        const a = vectors[i],
          b = vectors[(i + 1) % 4];
        if (
          a[0] * b[1] - a[1] * b[0] <= 0 ||
          Math.abs(a[0] * b[0] + a[1] * b[1]) >
            Math.min(lengths[i], lengths[(i + 1) % 4]) * 0.5
        )
          bad("Line must be a clockwise oriented rectangle");
      }
      if (
        Math.abs(points[0][0] + points[2][0] - points[1][0] - points[3][0]) >
          0.5 ||
        Math.abs(points[0][1] + points[2][1] - points[1][1] - points[3][1]) >
          0.5
      )
        bad("Opposite rectangle edges must match");
    }
  }
  if (complete && schema.some((f) => !seen.has(f.key)))
    bad("Every catalog field must be resolved");
  return answers;
}
export function validateCatalogFields(input: CatalogField[]): CatalogField[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 200)
    bad("Catalog requires 1 to 200 fields");
  const keys = new Set<string>(),
    orders = new Set<number>();
  return input.map((f) => {
    if (
      !f ||
      !/^[-a-zA-Z0-9_]{1,64}$/.test(f.key) ||
      keys.has(f.key) ||
      typeof f.label !== "string" ||
      !f.label.trim() ||
      f.label.length > 255 ||
      !Number.isSafeInteger(f.ordinal) ||
      f.ordinal < 0 ||
      orders.has(f.ordinal) ||
      typeof f.multiline !== "boolean" ||
      (f.businessFieldName != null &&
        (typeof f.businessFieldName !== "string" ||
          f.businessFieldName.length > 128))
    )
      bad("Invalid catalog field");
    keys.add(f.key);
    orders.add(f.ordinal);
    return {
      key: f.key,
      label: f.label,
      ordinal: f.ordinal,
      multiline: f.multiline,
      businessFieldName: f.businessFieldName ?? null,
    };
  });
}
