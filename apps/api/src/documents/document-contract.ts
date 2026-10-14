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
  positionUid: "Код должности",
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
export const browserDocumentMetadataSchema = z
  .object({
    documentUid: z.string().uuid(),
    documentFields: values,
  })
  .strict();
export const documentMetadataSchema = z
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
    documentFields: values,
  })
  .strict()
  .refine((v) => !!(v.chat_uuid || v.code_1c), "Document owner is required");
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
export function validateFields(
  definitions: FieldDefinition[],
  fields: Record<string, string | boolean | null>,
  complete = true,
): void {
  const byName = new Map(definitions.map((d) => [d.name, d]));
  for (const [name, value] of Object.entries(fields)) {
    const definition = byName.get(name);
    if (!definition)
      throw new BadRequestException(`Unknown document field: ${name}`);
    if (value === null || value === "") continue;
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
  if (complete)
    for (const definition of definitions) {
      const value = fields[definition.name];
      if (
        definition.required &&
        (value === null ||
          value === undefined ||
          (typeof value === "string" && !value.trim()))
      )
        throw new BadRequestException(
          `Required document field: ${definition.name}`,
        );
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
