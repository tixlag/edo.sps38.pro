import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

export const FIELD_LABELS: Record<string, string> = {
  series: "Серия",
  number: "Номер",
  issueDate: "Дата выдачи",
  expiryDate: "Срок действия",
  issuedBy: "Кем выдан",
  departmentCode: "Код подразделения",
  isIdentityDocument: "Документ удостоверяет личность",
  lastNameLatin: "Фамилия латиницей",
  firstNameLatin: "Имя латиницей",
  categories: "Категории",
  specialMarks: "Особые отметки",
  positionUid: "Должность в водительском удостоверении (UUID)",
  isInvalid: "Недействителен",
  valueComment: "Комментарий к значению",
  comment: "Комментарий",
};
export const fieldKind = (name: string) =>
  ["isIdentityDocument", "isInvalid"].includes(name)
    ? "boolean"
    : ["issueDate", "expiryDate"].includes(name)
      ? "date"
      : "text";

const code = z.string().min(1).max(64).regex(/^\S+$/);
const values = z.record(
  z.string().max(64),
  z.union([z.string().max(16384), z.boolean(), z.null()]),
);

// ---------------------------------------------------------------------------
// LK candidate profile snapshot (review queue).
// LK sends it as `candidateSnapshot` (legacy alias `candidate_profile` is
// accepted the same way). Unknown keys are stripped, never rejected.
// Presence is significant: only keys actually present in the input update the
// stored profile; a present-but-empty string clears the column (NULL).
// ---------------------------------------------------------------------------
const emptyToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

const snapshotText = (max: number) =>
  z.preprocess(
    emptyToNull,
    z.string().trim().min(1).max(max).nullish(),
  );

const snapshotName = (max: number) =>
  z.preprocess((value) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).name === "string"
    )
      return (value as Record<string, unknown>).name;
    return emptyToNull(value);
  }, z.string().trim().min(1).max(max).nullish());

const snapshotCode = z.preprocess(
  emptyToNull,
  z.string().trim().min(1).max(64).nullish(),
);

const snapshotPosition = z.preprocess(
  (value) => (typeof value === "string" ? { name: value } : value),
  z
    .object({ name: snapshotText(512), code: snapshotCode })
    .nullish(),
);

const snapshotMentor = z.preprocess((value) => {
  if (typeof value === "string") return { name: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    const code =
      input.code1C ?? input.code1c ?? input.code_1c ?? input.code;
    const { code1C: _a, code1c: _b, code_1c: _c, code: _d, ...rest } = input;
    void _a;
    void _b;
    void _c;
    void _d;
    return { ...rest, code1C: code };
  }
  return value;
}, z.object({ name: snapshotText(512), position: snapshotText(512), code1C: snapshotCode }).nullish());

const isCalendarDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const snapshotBirthDate = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(10)
    .refine(isCalendarDate, "Invalid birthDate (expected a real YYYY-MM-DD date)")
    .nullish(),
);

const snapshotCitizenship = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(2)
    .regex(/^[a-zA-Z]{2}$/, "Invalid citizenship (expected 2 letters)")
    .transform((value) => value.toLowerCase())
    .nullish(),
);

const snapshotReemployment = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().optional());

function aliasSnapshotKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value;
  const input = value as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) if (input[key] !== undefined) return input[key];
    return undefined;
  };
  return {
    ...input,
    fullName: pick("fullName", "name"),
    managerName: pick("managerName", "manager"),
    managerCode1c: pick("managerCode1C", "managerCode1c", "manager_code_1c"),
    mentorCode1c: pick("mentorCode1c", "mentorCode1C"),
    isReemployment: pick("isReemployment", "is_reemployment"),
  };
}

/** First defined value wins; null (arrived-but-empty) beats a fallback. */
const pickDefined = <T>(...values: (T | undefined)[]): T | undefined => {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
};

export const candidateSnapshotSchema = z.preprocess(
  aliasSnapshotKeys,
  z
    .object({
      fullName: snapshotName(512),
      birthDate: snapshotBirthDate,
      citizenship: snapshotCitizenship,
      position: snapshotPosition,
      project: snapshotPosition,
      // Flat fields: accepted from callers and, more importantly, produced
      // by normalization itself — the grant JWT context and the direct
      // upload merge re-validate through this schema, so the normalized
      // shape must parse back to itself (nested wins over flat).
      positionCode: snapshotCode,
      positionName: snapshotText(512),
      projectCode: snapshotCode,
      projectName: snapshotText(512),
      managerName: snapshotName(512),
      managerCode1c: snapshotCode,
      mentor: snapshotMentor,
      mentorName: snapshotText(512),
      mentorPosition: snapshotText(512),
      mentorCode1c: snapshotCode,
      isReemployment: snapshotReemployment,
    })
    .transform((v) => ({
      // null = arrived-but-empty (clears the column); undefined = absent
      // (leaves the stored value untouched). Never collapse one into the other.
      fullName: v.fullName,
      birthDate: v.birthDate,
      citizenship: v.citizenship,
      positionCode: pickDefined(v.position?.code, v.positionCode),
      positionName: pickDefined(v.position?.name, v.positionName),
      projectCode: pickDefined(v.project?.code, v.projectCode),
      projectName: pickDefined(v.project?.name, v.projectName),
      managerName: v.managerName,
      managerCode1c: v.managerCode1c,
      mentorName: pickDefined(v.mentor?.name, v.mentorName),
      mentorPosition: pickDefined(v.mentor?.position, v.mentorPosition),
      mentorCode1c: pickDefined(v.mentor?.code1C, v.mentorCode1c),
      isReemployment: v.isReemployment,
    })),
);
export type CandidateSnapshot = z.infer<typeof candidateSnapshotSchema>;
export const browserDocumentMetadataSchema = z
  .object({
    documentUid: z.string().uuid(),
    documentFields: values,
  })
  .strict();
const metadataSnapshotAlias = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value;
  const input = { ...(value as Record<string, unknown>) };
  if (
    input.candidateSnapshot === undefined &&
    input.candidate_profile !== undefined
  )
    input.candidateSnapshot = input.candidate_profile;
  delete input.candidate_profile;
  return input;
};
export const documentMetadataSchema = z.preprocess(
  metadataSnapshotAlias,
  z
    .object({
      documentUid: z
        .string()
        .uuid()
        .transform((v) => v.toLowerCase()),
      chat_uuid: z
        .string()
        .uuid()
        .transform((v) => v.toLowerCase())
        .optional(),
      code_1c: code.optional(),
      position_code_1c: code,
      citizenship: z
        .string()
        .regex(/^[a-zA-Z]{2}$/)
        .default("ru")
        .transform((v) => v.toLowerCase()),
      project_code_1c: code.optional(),
      locationId: z.number().int().positive().optional(),
      candidateSnapshot: candidateSnapshotSchema.optional(),
      documentFields: values,
    })
    .strict()
    .refine((v) => !!(v.chat_uuid || v.code_1c), "Document owner is required"),
);
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;
export interface FieldDefinition {
  name: string;
  kind: string;
  required: boolean;
  ordinal: number;
}
export function textValue(
  value: string | boolean | null | undefined,
): string | null {
  return value === null || value === undefined ? null : String(value);
}
export function typedValue(
  value: string | null,
  kind: string,
): string | boolean | null {
  return value === null ? null : kind === "boolean" ? value === "true" : value;
}

/** Omit absent values and the job code injected by older clients; preserve document UUIDs. */
export function shouldOmitPositionUid(
  value: unknown,
  positionCode1c: string | null,
): boolean {
  return (
    value == null ||
    (typeof value === "string" &&
      (!value.trim() ||
        (value === positionCode1c && !z.string().uuid().safeParse(value).success)))
  );
}

/** Catalog required flags select form fields; empty requisites never block a document. */
export function validateFields(
  definitions: FieldDefinition[],
  fields: Record<string, string | boolean | null>,
): void {
  const byName = new Map(definitions.map((d) => [d.name, d]));
  for (const [name, value] of Object.entries(fields)) {
    const definition = byName.get(name);
    if (!definition)
      throw new BadRequestException(`Unknown document field: ${name}`);
    if (value === null || (typeof value === "string" && !value.trim()))
      continue;
    if (
      definition.kind === "boolean"
        ? typeof value !== "boolean"
        : typeof value !== "string"
    )
      throw new BadRequestException(`Invalid field type: ${name}`);
    if (typeof value === "string" && value.length > 16384)
      throw new BadRequestException(`Field too long: ${name}`);
    if (
      definition.kind === "date" &&
      typeof value === "string" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw new BadRequestException(`Invalid date: ${name}`);
  }
}

export const erpCatalogSchema = z
  .array(
    z
      .object({
        УИНДокумента: z
          .string()
          .uuid()
          .transform((v) => v.toLowerCase()),
        НаименованиеДокумента: z.string().min(1).max(255),
        КодыДолжностей: z.array(code).max(10000),
        ВсемРФ: z.boolean(),
        ВсемИГ: z.boolean(),
        requiredFields: z
          .array(z.enum(Object.keys(FIELD_LABELS) as [string, ...string[]]))
          .max(30),
        optionalFields: z
          .array(z.enum(Object.keys(FIELD_LABELS) as [string, ...string[]]))
          .max(30),
      })
      .refine(
        (v) =>
          new Set([...v.requiredFields, ...v.optionalFields]).size ===
          v.requiredFields.length + v.optionalFields.length,
        "Repeated field",
      ),
  )
  .min(1)
  .max(1000)
  .refine(
    (v) => new Set(v.map((d) => d.УИНДокумента)).size === v.length,
    "Repeated document UID",
  );

export function applicable(
  type: {
    allRu: boolean;
    allForeign: boolean;
    positions: { code1c: string }[];
  },
  position: string,
  citizenship: string,
): boolean {
  return (
    (citizenship.toLowerCase() === "ru" ? type.allRu : type.allForeign) ||
    type.positions.some((p) => p.code1c === position)
  );
}
