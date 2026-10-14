import type { DocumentVersionDto } from "@edo/api-client";
import { DOCUMENT_FIELD_LABELS } from "./document-field-labels";

/**
 * required is the version's snapshot of the 1C requiredFields contract.
 * Keep the complete API fields intact for lifecycle processing; use this
 * selection for the review form and its clickable OCR regions only.
 */
export function getRequiredReviewFields(data: DocumentVersionDto) {
  const fields = data.fields.filter(
    (field) => field.required === true && field.name !== "positionUid",
  );
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
