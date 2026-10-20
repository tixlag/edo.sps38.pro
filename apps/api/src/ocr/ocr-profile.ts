export type OcrProfile = "passport_ru" | "passport_uz" | "migration_card";
export const PASSPORT_UID = "6ffb1fd5-8341-11eb-ba8b-00259002db81";
export const MIGRATION_UID = "39554ac3-6462-11ec-80cc-002590854e7f";

export function resolveOcrProfile(input: {
  documentUid?: string | null;
  documentTypeCode: string;
  citizenship?: string | null;
}): OcrProfile | null {
  const uid = input.documentUid?.toLowerCase();
  if (
    uid === MIGRATION_UID ||
    (!uid && input.documentTypeCode === "MIGRATION_CARD")
  )
    return "migration_card";
  if (uid !== PASSPORT_UID && (uid || input.documentTypeCode !== "PASSPORT"))
    return null;
  const citizenship = input.citizenship?.trim().toLowerCase() || "ru";
  return citizenship === "ru"
    ? "passport_ru"
    : citizenship === "uz"
      ? "passport_uz"
      : null;
}
