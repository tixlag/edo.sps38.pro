import { describe, expect, it } from "vitest";
import {
  applicable,
  erpCatalogSchema,
} from "../src/documents/document-contract";
import {
  reviewStageProgress,
  classifyStageType,
} from "../src/documents/review-stage-progress";
import { EMPLOYMENT_PATENT_UID } from "../src/documents/reemployment-document-policy";

const item = {
  УИНДокумента: "6ffb1fd5-8341-11eb-ba8b-00259002db81",
  НаименованиеДокумента: "Паспорт",
  КодыДолжностей: [],
  ВсемРФ: true,
  ВсемИГ: false,
  requiredFields: [],
  optionalFields: [],
};
describe("review stage progress", () => {
  it("does not override ERP when patent is not required", () => {
    const type = {
      id: "patent",
      erpUid: EMPLOYMENT_PATENT_UID,
      code: "PATENT",
      stage: 1,
      requiredForAll: false,
      allRu: false,
      allForeign: false,
      positions: [],
    };
    const profile = { positionCode: "001", citizenship: "uz", sex: null };
    expect(applicable(type, "001", "uz")).toBe(false);
    expect(classifyStageType(type, 1, profile)).toBeNull();
    expect(
      classifyStageType(type, 1, { ...profile, citizenship: "ru" }),
    ).toBeNull();
  });
  it("counts a confirmed previous passport as reused when no current version exists", () => {
    const type = {
      id: "passport",
      erpUid: "6ffb1fd5-8341-11eb-ba8b-00259002db81",
      code: "PASSPORT",
      stage: 1,
      requiredForAll: true,
      allRu: false,
      allForeign: false,
      positions: [],
    };
    const result = reviewStageProgress(
      [type],
      [],
      { positionCode: "001", citizenship: "uz", sex: null },
      [type.erpUid],
    );
    expect(result[0].required.reused).toBe(1);
    expect(result[0].required.missing).toBe(0);
  });
  it("selects and classifies a type using the rule for the chosen stage", () => {
    const type = {
      id: "a",
      code: "A",
      stage: 1,
      requiredForAll: true,
      allRu: false,
      allForeign: false,
      positions: [],
      stageRules: [
        {
          stage: 1,
          requiredForAll: true,
          allRu: false,
          allForeign: false,
          positions: [],
        },
        {
          stage: 2,
          requiredForAll: false,
          allRu: false,
          allForeign: false,
          positions: [],
        },
      ],
    };
    const profile = { positionCode: "001", citizenship: "ru", sex: null };
    expect(classifyStageType(type, 1, profile)).toBe("required");
    expect(classifyStageType(type, 2, profile)).toBeNull();
    expect(classifyStageType(type, 3, profile)).toBeNull();
  });
  it("makes universally required documents available to candidates", () => {
    expect(
      applicable(
        {
          requiredForAll: true,
          allRu: false,
          allForeign: false,
          positions: [],
        },
        "001",
        "ru",
      ),
    ).toBe(true);
  });
  it("preserves stage and universal requirement from ERP while accepting older catalogs", () => {
    expect(
      erpCatalogSchema.parse([
        { ...item, Этап: 2, ОбязательныйДляВсех: true },
      ])[0],
    ).toMatchObject({ Этап: 2, ОбязательныйДляВсех: true });
    expect(erpCatalogSchema.parse([item])[0]).toMatchObject({
      Этап: null,
      ОбязательныйДляВсех: false,
    });
  });
  it("retains distinct stage rules for one document and ignores empty position codes", () => {
    const result = erpCatalogSchema.parse([
      { ...item, Этап: 1, КодыДолжностей: ["", "001"] },
      { ...item, Этап: 2, ВсемРФ: false, КодыДолжностей: ["   "] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].stageRules).toEqual([
      expect.objectContaining({ stage: 1, allRu: true, positions: ["001"] }),
      expect.objectContaining({ stage: 2, allRu: false, positions: [] }),
    ]);
  });
  it("counts required and additional types per stage using current document status", () => {
    const types = [
      {
        id: "a",
        code: "PASSPORT",
        stage: 1,
        requiredForAll: true,
        allRu: false,
        allForeign: false,
        positions: [],
      },
      {
        id: "b",
        code: "OTHER",
        stage: 1,
        requiredForAll: false,
        allRu: false,
        allForeign: false,
        positions: [],
      },
      {
        id: "c",
        code: "OTHER2",
        stage: null,
        requiredForAll: false,
        allRu: false,
        allForeign: false,
        positions: [],
      },
    ];
    expect(
      reviewStageProgress(
        types,
        [
          { documentTypeId: "a", status: "IN_REVIEW" },
          { documentTypeId: "b", status: "APPROVED" },
        ],
        { positionCode: "001", citizenship: "ru", sex: null },
      ),
    ).toMatchObject([
      {
        stage: 1,
        required: {
          approved: 0,
          inReview: 1,
          pending: 1,
          processing: 0,
          missing: 0,
          attention: 0,
        },
        additional: {
          approved: 0,
          pending: 0,
          processing: 0,
          missing: 0,
          attention: 0,
        },
      },
    ]);
  });
  it("counts the same document separately for every stage and applies that stage's rules", () => {
    const base = {
      id: "a",
      code: "A",
      stage: 1,
      requiredForAll: false,
      allRu: false,
      allForeign: false,
      positions: [],
    };
    const rules = [
      {
        stage: 1,
        requiredForAll: true,
        allRu: false,
        allForeign: false,
        positions: [],
      },
      {
        stage: 2,
        requiredForAll: false,
        allRu: false,
        allForeign: false,
        positions: [],
      },
    ];
    const result = reviewStageProgress(
      [{ ...base, stageRules: rules }],
      [{ documentTypeId: "a", status: "APPROVED" }],
      { positionCode: "001", citizenship: "ru", sex: null },
    );
    expect(
      result.map((stage) => [
        stage.stage,
        stage.required.approved,
        stage.additional.approved,
      ]),
    ).toEqual([[1, 1, 0]]);
  });
  it("applies citizenship and position rules and keeps returned documents separate from missing", () => {
    const types = [
      {
        id: "ru",
        code: "RU",
        stage: 2,
        requiredForAll: false,
        allRu: true,
        allForeign: false,
        positions: [],
      },
      {
        id: "ig",
        code: "IG",
        stage: 2,
        requiredForAll: false,
        allRu: false,
        allForeign: true,
        positions: [],
      },
      {
        id: "job",
        code: "JOB",
        stage: 2,
        requiredForAll: false,
        allRu: false,
        allForeign: false,
        positions: [{ code1c: "001" }],
      },
    ];
    const result = reviewStageProgress(
      types,
      [{ documentTypeId: "ig", status: "RETURNED" }],
      { positionCode: "001", citizenship: "uz", sex: null },
    );
    expect(result[0].required).toMatchObject({
      approved: 0,
      returned: 1,
      pending: 0,
      processing: 0,
      missing: 1,
      attention: 1,
    });
    expect(result[0].additional.missing).toBe(0);
  });
  it("distinguishes documents being processed from documents needing attention", () => {
    const types = [
      {
        id: "a",
        code: "A",
        stage: 1,
        requiredForAll: true,
        allRu: false,
        allForeign: false,
        positions: [],
      },
    ];
    const [stage] = reviewStageProgress(
      types,
      [{ documentTypeId: "a", status: "OCR_PENDING" }],
      { positionCode: "001", citizenship: "ru", sex: null },
    );
    expect(stage.required).toMatchObject({
      processing: 1,
      ocrPending: 1,
      pending: 0,
      attention: 0,
    });
  });
  it("counts every distinct document status with individual precision", () => {
    const make = (id: string, stage = 1) => ({
      id,
      code: id.toUpperCase(),
      erpUid: `uid-${id}`,
      stage,
      requiredForAll: true,
      allRu: true,
      allForeign: false,
      positions: [],
    });
    const types = [
      make("approved"),
      make("reused"),
      make("signed"),
      make("review"),
      make("uploaded"),
      make("pending"),
      make("ocr_err"),
      make("returned"),
      make("expired"),
      make("draft"),
      make("missing"),
    ];
    const docs = [
      { documentTypeId: "approved", status: "APPROVED" },
      // "reused" has no document, but has erpUid in previousUids
      { documentTypeId: "signed", status: "SIGNED" },
      { documentTypeId: "review", status: "IN_REVIEW" },
      { documentTypeId: "uploaded", status: "UPLOADED" },
      { documentTypeId: "pending", status: "OCR_PENDING" },
      { documentTypeId: "ocr_err", status: "OCR_FAILED" },
      { documentTypeId: "returned", status: "RETURNED" },
      { documentTypeId: "expired", status: "EXPIRED" },
      { documentTypeId: "draft", status: "DRAFT" },
      // "missing" has no document
    ];
    const [result] = reviewStageProgress(
      types,
      docs,
      { positionCode: "001", citizenship: "ru", sex: null },
      ["uid-reused"],
    );
    expect(result.required).toEqual({
      approved: 1,
      reused: 1,
      signed: 1,
      inReview: 1,
      uploaded: 1,
      ocrPending: 1,
      ocrFailed: 1,
      returned: 1,
      expired: 1,
      draft: 1,
      missing: 1,
      pending: 1,
      processing: 2,
      attention: 3,
    });
  });
  it("reports required and additional delivery problems without changing review counts", () => {
    const type = (id: string, requiredForAll: boolean) => ({
      id,
      code: id,
      stage: 7,
      requiredForAll,
      allRu: false,
      allForeign: false,
      positions: requiredForAll ? [] : [{ code1c: "001", required: false }],
    });
    const [stage] = reviewStageProgress(
      [type("license", true), type("tachograph", false)],
      [
        { documentTypeId: "license", status: "APPROVED" },
        { documentTypeId: "tachograph", status: "APPROVED" },
      ],
      { positionCode: "001", citizenship: "ru", sex: null },
      [],
      false,
      ["tachograph"],
    );
    expect(stage.required.approved).toBe(1);
    expect(stage.additional.approved).toBe(1);
    expect(stage.required.attention).toBe(0);
    expect(stage.deliveryProblemCount).toBe(1);
  });
});
