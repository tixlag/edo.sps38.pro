import { describe, it, expect } from "vitest";
import { transitionAnnotation } from "../src/annotations/annotation-lifecycle";
const state = { authorId: "author", status: "DRAFT", revision: 2 };
describe("independent annotation lifecycle", () => {
  it("submits a draft only for its exact revision and author", () => {
    expect(transitionAnnotation(state, "submit", 2, "author", false)).toBe(
      "SUBMITTED",
    );
    expect(() =>
      transitionAnnotation(state, "submit", 1, "author", false),
    ).toThrow();
    expect(() =>
      transitionAnnotation(state, "save", 2, "other", true),
    ).toThrow();
  });
  it("allows administrator acceptance including own work and preserves accepted immutability", () => {
    expect(
      transitionAnnotation(
        { ...state, status: "SUBMITTED" },
        "accept",
        2,
        "author",
        true,
      ),
    ).toBe("ACCEPTED");
    for (const op of ["save", "submit", "accept", "changes", "reassign"])
      expect(() =>
        transitionAnnotation(
          { ...state, status: "ACCEPTED" },
          op,
          2,
          "author",
          true,
        ),
      ).toThrow();
  });
  it("requires admin to return or reassign and allows author to revise returned work", () => {
    expect(() =>
      transitionAnnotation(
        { ...state, status: "SUBMITTED" },
        "changes",
        2,
        "author",
        false,
      ),
    ).toThrow();
    expect(
      transitionAnnotation(
        { ...state, status: "SUBMITTED" },
        "changes",
        2,
        "admin",
        true,
      ),
    ).toBe("CHANGES_REQUESTED");
    expect(
      transitionAnnotation(
        { ...state, status: "CHANGES_REQUESTED" },
        "save",
        2,
        "author",
        false,
      ),
    ).toBe("CHANGES_REQUESTED");
    expect(
      transitionAnnotation(
        { ...state, status: "SUBMITTED" },
        "reassign",
        2,
        "admin",
        true,
      ),
    ).toBe("DRAFT");
  });
});
