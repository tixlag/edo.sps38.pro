import { describe, expect, it } from "vitest";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { reviewGroupWhere } from "../src/documents/review-group";
import type { AuthPrincipal } from "../src/auth/auth-principal";
const user = (accessRules: Record<string, string[]>) =>
  ({ uuid: "reviewer", accessRules }) as AuthPrincipal;
const access = new DocumentAccessService(null as never);
describe("reviewers work across all locations", () => {
  it.each(["20002", "20011"])(
    "needs no location grant for candidate and transactional document access: %s",
    (rule) => {
      const principal = user({ [rule]: [] });
      expect(access.candidateWhere(principal)).toEqual(
        reviewGroupWhere(rule === "20002" ? "RU" : "IG"),
      );
      expect(
        JSON.stringify(access.documentReviewWhere(principal)),
      ).not.toContain("locationId");
      expect(JSON.stringify(access.documentReviewWhere(principal))).toContain(
        "citizenship",
      );
    },
  );
  it("keeps no-review audit readers location restricted and unable to mutate", () => {
    const audit = user({ "20005": [], "20007": ["98"] });
    expect(access.candidateWhere(audit)).toEqual({ locationId: { in: [98] } });
    expect(JSON.stringify(access.documentReviewWhere(audit))).toContain(
      '"in":[]',
    );
  });
  it("does not turn audit plus RU into IG mutation rights", () => {
    const where = access.documentReviewWhere(
      user({ "20002": [], "20005": [] }),
    );
    expect(JSON.stringify(where)).not.toContain("locationId");
    expect(JSON.stringify(where)).toContain(
      JSON.stringify(reviewGroupWhere("RU")),
    );
  });
});
