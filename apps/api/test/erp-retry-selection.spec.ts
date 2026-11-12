import { describe, expect, it } from "vitest";
import { isInvalidFileContent } from "../src/documents/erp-retry-selection";

describe("ERP retry selection", () => {
  it("recognises the current machine code", () => {
    expect(isInvalidFileContent("ERP_INVALID_FILE_CONTENT", null)).toBe(true);
  });

  it("recognises the historical HTTP status with the 1C answer code", () => {
    expect(
      isInvalidFileContent(
        "ERP_HTTP_422",
        JSON.stringify({ success: false, code: "INVALID_FILE_CONTENT" }),
      ),
    ).toBe(true);
    expect(
      isInvalidFileContent(
        "ERP_HTTP_422",
        '{"success":false,"code":"INVALID_FILE_CONTENT"}',
      ),
    ).toBe(true);
  });

  it("does not take other failures", () => {
    expect(isInvalidFileContent("ERP_HTTP_422", null)).toBe(false);
    expect(
      isInvalidFileContent(
        "ERP_HTTP_422",
        JSON.stringify({ success: false, code: "INVALID_METADATA" }),
      ),
    ).toBe(false);
    expect(
      isInvalidFileContent(
        "ERP_DOCUMENT_ALREADY_EXISTS",
        JSON.stringify({ success: false, code: "DOCUMENT_ALREADY_EXISTS" }),
      ),
    ).toBe(false);
    expect(isInvalidFileContent("ERP_HTTP_500", null)).toBe(false);
    expect(isInvalidFileContent(null, null)).toBe(false);
  });
});
