import { describe, expect, it } from "vitest";
import {
  applicable,
  erpCatalogSchema,
} from "../src/documents/document-contract";
import { reviewStageProgress } from "../src/documents/review-stage-progress";

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
    ).toEqual([
      {
        stage: 1,
        required: {
          approved: 0,
          pending: 1,
          processing: 0,
          missing: 0,
          attention: 0,
        },
        additional: {
          approved: 1,
          pending: 0,
          processing: 0,
          missing: 0,
          attention: 0,
        },
      },
      {
        stage: null,
        required: {
          approved: 0,
          pending: 0,
          processing: 0,
          missing: 0,
          attention: 0,
        },
        additional: {
          approved: 0,
          pending: 0,
          processing: 0,
          missing: 1,
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
    ).toEqual([
      [1, 1, 0],
      [2, 0, 1],
    ]);
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
    expect(result[0].required).toEqual({
      approved: 0,
      pending: 0,
      processing: 0,
      missing: 1,
      attention: 1,
    });
    expect(result[0].additional.missing).toBe(1);
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
      pending: 0,
      attention: 0,
    });
  });
});
