import { describe, expect, it } from "vitest";
import {
  applicable,
  classifyRule,
  erpCatalogSchema,
  requiredApplicable,
} from "../src/documents/document-contract";
import { reviewStageProgress } from "../src/documents/review-stage-progress";

const item = {
  uid: "a4e4f609-8c6a-11eb-ba8b-00259002db81",
  name: "НАКС",
  stage: 3,
  requirements: {
    requiredForAll: false,
    citizenship: { russian: false, foreign: false },
    positions: [
      { code: "001", required: false },
      { code: "002", required: true },
    ],
    projectCodes: ["project"],
    countryCodes: ["UZ"],
  },
  fields: { required: ["issueDate", "expiryDate"], optional: ["number"] },
};
const rule = {
  allRu: false,
  allForeign: false,
  requiredForAll: false,
  positions: [
    { code1c: "001", required: false },
    { code1c: "002", required: true },
  ],
  projects: [{ code1c: "project" }],
  countries: [{ code: "uz" }],
};

describe("ERP catalog applicability", () => {
  it("parses new response and keeps separate stage rules", () => {
    const [doc] = erpCatalogSchema.parse([item, { ...item, stage: 4 }]);
    expect(doc.stageRules).toMatchObject([
      {
        stage: 3,
        positions: ["001", "002"],
        optionalPositions: ["001"],
        projectCodes: ["project"],
        countryCodes: ["uz"],
      },
      { stage: 4, positions: ["001", "002"] },
    ]);
    expect(doc.requiredFields).toEqual(["issueDate", "expiryDate"]);
    expect(() =>
      erpCatalogSchema.parse([
        {
          ...item,
          requirements: { ...item.requirements, positions: [{ code: "001" }] },
        },
      ]),
    ).toThrow();
  });
  it("classifies matching optional and required positions, project and country", () => {
    expect(classifyRule(rule, "001", "ru")).toBe("additional");
    expect(classifyRule(rule, "002", "ru")).toBe("required");
    expect(classifyRule(rule, "001", "ru", "project")).toBe("required");
    expect(classifyRule(rule, "none", "UZ")).toBe("required");
    expect(classifyRule(rule, "none", "ru", null)).toBeNull();
    expect(applicable(rule, "001", "ru")).toBe(true);
    expect(requiredApplicable(rule, "001", "ru")).toBe(false);
  });
  it("omits stages without applicable documents and retains optional-only stages", () => {
    const type = { id: "a", code: "A", stage: 3, ...rule };
    expect(
      reviewStageProgress([type], [], {
        positionCode: "none",
        citizenship: "ru",
        sex: null,
      }),
    ).toEqual([]);
    expect(
      reviewStageProgress([type], [], {
        positionCode: "001",
        citizenship: "ru",
        sex: null,
      })[0],
    ).toMatchObject({
      stage: 3,
      additional: { missing: 1 },
      required: { missing: 0 },
    });
    expect(
      reviewStageProgress([type], [], {
        positionCode: "none",
        citizenship: "ru",
        projectCode: "project",
        sex: null,
      })[0],
    ).toMatchObject({ required: { missing: 1 } });
  });
});
