/**
 * Selection rules of the ERP delivery retry.
 *
 * Only deliveries that failed because 1C rejected the file container can be
 * repaired. Both records are recognised: the current machine code and the
 * older HTTP status with the 1C answer code inside the stored response body.
 */
export function isInvalidFileContent(
  errorCode: string | null,
  responseBody: string | null,
): boolean {
  if (errorCode === "ERP_INVALID_FILE_CONTENT") return true;
  if (errorCode !== "ERP_HTTP_422" && errorCode !== "422") return false;
  return /"code"\s*:\s*"INVALID_FILE_CONTENT"/.test(responseBody ?? "");
}
