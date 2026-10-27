import type {
  AnnotationCatalogDto,
  AnnotationFieldAnswerDto,
  AnnotationLineDto,
} from "@edo/api-client";
export function annotationComplete(
  schema: AnnotationCatalogDto,
  fields: AnnotationFieldAnswerDto[],
): boolean {
  return (
    schema.fields.length > 0 &&
    schema.fields.every((field) => {
      const answer = fields.find((item) => item.key === field.key);
      if (!answer) return false;
      if (answer.disposition !== "PRESENT") return answer.lines.length === 0;
      return (
        answer.lines.length > 0 &&
        answer.lines.every(
          (line) =>
            line.text.trim().length > 0 &&
            ![...line.text].some((char) => char.charCodeAt(0) < 32) &&
            line.quad.length === 8 &&
            line.quad.every(Number.isFinite),
        )
      );
    })
  );
}
export function replaceAnnotationLine(
  fields: AnnotationFieldAnswerDto[],
  id: string,
  patch: Partial<AnnotationLineDto>,
): AnnotationFieldAnswerDto[] {
  return fields.map((field) =>
    field.lines.some((line) => line.id === id)
      ? {
          ...field,
          lines: field.lines.map((line) =>
            line.id === id ? { ...line, ...patch } : line,
          ),
        }
      : field,
  );
}
