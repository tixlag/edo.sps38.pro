import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
export function transitionAnnotation(
  row: { authorId: string; status: string; revision: number },
  operation: string,
  revision: number,
  actor: string,
  admin: boolean,
): string {
  if (row.revision !== revision)
    throw new ConflictException("Annotation revision changed");
  if (row.status === "ACCEPTED")
    throw new ConflictException("Accepted annotation is immutable");
  if (["accept", "changes", "reassign"].includes(operation)) {
    if (!admin)
      throw new ForbiddenException(
        "Annotation administration requires full access",
      );
    if (operation === "reassign") return "DRAFT";
    if (row.status !== "SUBMITTED")
      throw new ConflictException("Annotation is not submitted");
    return operation === "accept" ? "ACCEPTED" : "CHANGES_REQUESTED";
  }
  if (!["save", "submit"].includes(operation))
    throw new BadRequestException("Unknown annotation operation");
  if (row.authorId !== actor)
    throw new ForbiddenException("Annotation belongs to another author");
  if (!["DRAFT", "CHANGES_REQUESTED"].includes(row.status))
    throw new ConflictException("Annotation is locked for review");
  return operation === "submit" ? "SUBMITTED" : row.status;
}
