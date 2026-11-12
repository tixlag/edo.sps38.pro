import type {
  CandidatePatchFieldsDto,
  CandidateWorkspaceDto,
} from "@edo/api-client";

export function candidateRelatedFieldValidation(
  profile: CandidateWorkspaceDto,
  fields: CandidatePatchFieldsDto,
) {
  const sourceChanged =
    (fields.sourceId ?? null) !== (profile.source?.id ?? null) ||
    JSON.stringify(fields.sourceComment ?? null) !==
      JSON.stringify(profile.sourceComment ?? null);
  const practiceChanged =
    (fields.internship ?? false) !== (profile.internship ?? false) ||
    (fields.internshipStartDate ?? null) !==
      (profile.internshipStartDate?.slice(0, 10) ?? null) ||
    (fields.internshipEndDate ?? null) !==
      (profile.internshipEndDate?.slice(0, 10) ?? null);
  const isRecommendation = fields.sourceId === "ПоРекомендации";
  const sourceCommentRequired =
    isRecommendation || fields.sourceId === "Другое";
  const errors: string[] = [];
  // Old incomplete cards can still accept unrelated edits. ERP validates the
  // resulting values when this group of fields is included in the patch.
  if (sourceChanged) {
    const comment = fields.sourceComment;
    if (isRecommendation && (comment?.kind !== "person" || !comment.id?.trim()))
      errors.push("Выберите физлицо, которое рекомендовало кандидата.");
    else if (
      sourceCommentRequired &&
      !(comment?.kind === "text" ? comment.text?.trim() : comment?.id?.trim())
    )
      errors.push("Укажите комментарий к источнику кандидата.");
  }
  if (practiceChanged && fields.internship && !fields.internshipEndDate)
    errors.push("Укажите дату окончания практики.");
  if (
    practiceChanged &&
    fields.internshipStartDate &&
    fields.internshipEndDate &&
    fields.internshipEndDate < fields.internshipStartDate
  )
    errors.push("Окончание практики не может быть раньше её начала.");
  return {
    sourceChanged,
    practiceChanged,
    isRecommendation,
    sourceCommentRequired,
    errors,
  };
}
