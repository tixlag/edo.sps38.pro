import type { DocumentVersionDto, DocumentFieldDto } from "@edo/api-client";
import { DOCUMENT_FIELD_LABELS } from "./document-field-labels";

/** An OCR suggestion fills an absent candidate value only until a reviewer edits it. */
export function getReviewFieldValue(field: DocumentFieldDto): string {
  if (!field.submittedValue?.trim() && !field.editedBy && !field.value?.length)
    return field.originalValue ?? "";
  return field.value ?? "";
}

/**
 * required is the version's snapshot of the 1C requiredFields contract.
 * Keep the complete API fields intact for lifecycle processing; use this
 * selection for the review form and its clickable OCR regions only.
 */
export function getRequiredReviewFields(data: DocumentVersionDto) {
  const fields = data.fields.filter((field) => field.required === true);
  if (!data.ocrSource) return fields;

  const order = Object.keys(DOCUMENT_FIELD_LABELS);
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index < 0 ? order.length : index;
  };
  return fields.sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "ru"),
  );
}
