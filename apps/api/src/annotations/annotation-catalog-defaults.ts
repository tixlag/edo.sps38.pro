import { FIELD_LABELS } from "../documents/document-contract";
import type { CatalogField } from "./annotation-validation";
const hidden = new Set([
  "comment",
  "valueComment",
  "positionUid",
  "isInvalid",
  "isIdentityDocument",
]);
const labels: Record<string, string> = {
  ...FIELD_LABELS,
  lastName: "Фамилия",
  firstName: "Имя",
  middleName: "Отчество",
  birthDate: "Дата рождения",
  placeBirth: "Место рождения",
  birthPlace: "Место рождения",
  address: "Адрес регистрации",
  citizenship: "Гражданство",
  sex: "Пол",
  personalNumber: "Личный номер",
};
export function suggestAnnotationFields(
  definitions: { name: string; ordinal: number }[],
): CatalogField[] {
  return definitions
    .filter((f) => !hidden.has(f.name))
    .map((f, i) => ({
      key: f.name,
      label: labels[f.name] ?? f.name,
      ordinal: i,
      multiline: ["issuedBy", "placeBirth", "birthPlace", "address"].includes(
        f.name,
      ),
      businessFieldName: f.name,
    }));
}
