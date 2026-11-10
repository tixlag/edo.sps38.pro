import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Reflector } from "@nestjs/core";
import { AccessRuleGuard } from "../src/auth/access-rule.guard";
import { ManualDocumentReviewController } from "../src/documents/manual-documents.controller";

describe("review document SSE access", () => {
  it.each(["20000", "20002", "20011", "20009"])("allows rule %s alone", (rule) => {
    const context = {
      getHandler: () => ManualDocumentReviewController.prototype.stream,
      getClass: () => ManualDocumentReviewController,
      switchToHttp: () => ({ getRequest: () => ({ user: { accessRules: { [rule]: [] } } }) }),
    };
    expect(new AccessRuleGuard(new Reflector()).canActivate(context as never)).toBe(true);
  });
  it("rejects unrelated permissions", () => {
    const context = {
      getHandler: () => ManualDocumentReviewController.prototype.stream,
      getClass: () => ManualDocumentReviewController,
      switchToHttp: () => ({ getRequest: () => ({ user: { accessRules: { "20010": [] } } }) }),
    };
    expect(() => new AccessRuleGuard(new Reflector()).canActivate(context as never)).toThrow();
  });
});
