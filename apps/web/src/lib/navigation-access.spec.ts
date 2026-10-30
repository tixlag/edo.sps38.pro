import { describe, expect, it } from "vitest";
import { canAccessPath } from "./navigation-access";
describe("shared route/menu capabilities", () => {
  it.each([
    "/employees/person",
    "/onboarding",
    "/signing",
    "/participants",
    "/settings",
    "/tasks",
    "/annotation-settings",
  ])("blocks reviewer deep link %s", (path) =>
    expect(canAccessPath({ "20002": [] }, path)).toBe(false),
  );
  it("recognizes key presence, full access and exact group", () => {
    expect(canAccessPath({ "20011": [] }, "/review-ig/doc")).toBe(true);
    expect(canAccessPath({ "20011": [] }, "/review/doc")).toBe(false);
    expect(canAccessPath({ "20002": [] }, "/history")).toBe(true);
    expect(canAccessPath({ "20005": [] }, "/history")).toBe(true);
    expect(canAccessPath({ "20009": [] }, "/annotation-settings")).toBe(true);
    expect(canAccessPath(Object.create({ "20009": [] }), "/settings")).toBe(
      false,
    );
    expect(canAccessPath(undefined, "/")).toBe(false);
  });
});

it("allows group-independent readonly history details while keeping audit out of review queues", () => {
  expect(
    canAccessPath({ "20000": [], "20011": [] }, "/history/documents/document"),
  ).toBe(true);
  expect(
    canAccessPath({ "20000": [], "20005": [] }, "/history/documents/document"),
  ).toBe(true);
  expect(canAccessPath({ "20000": [], "20005": [] }, "/review/document")).toBe(
    false,
  );
  expect(
    canAccessPath({ "20000": [], "20005": [] }, "/review-ig/document"),
  ).toBe(false);
  expect(canAccessPath({ "20000": [] }, "/history/documents/document")).toBe(
    false,
  );
});

it("allows own documents to an authenticated employee without administrative grants", () => {
  expect(canAccessPath({}, "/my-documents")).toBe(true);
  expect(canAccessPath({}, "/my-documents/document")).toBe(true);
  expect(canAccessPath(undefined, "/my-documents")).toBe(false);
  expect(canAccessPath({}, "/signing")).toBe(false);
});
