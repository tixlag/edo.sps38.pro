import { typedValue } from "./document-contract";

/** ERP payload stays separate; all readers and SQL see the effective requisites. */
export function applyPreviousDocumentEdits(
  erpFields: Record<string, unknown>,
  edits: { name: string; value: string | null; kind: string }[],
): Record<string, unknown> {
  const effective = { ...erpFields };
  for (const edit of edits) effective[edit.name] = typedValue(edit.value, edit.kind);
  return effective;
}
