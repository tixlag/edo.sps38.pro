import { describe, it, expect } from "vitest";
import { ANNOTATION_PRESETS } from "../src/annotations/annotation-presets";
import {
  validateCatalogFields,
  validateAnswers,
  type FieldAnswer,
} from "../src/annotations/annotation-validation";
import {
  validateDataset,
  validateRegion,
} from "../src/annotations/annotation-dataset-validation";
import { erpCatalogSchema } from "../src/documents/document-contract";
const page = { id: "page", width: 1000, height: 800 };
const region = {
  id: "region",
  pageId: "page",
  shape: "POLYGON" as const,
  orientationDeg: 180,
  polygon: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9],
};
const definitions = [
  {
    key: "address",
    label: "Адрес",
    ordinal: 0,
    multiline: true,
    kind: "TEXT",
    sectionKey: "registration",
  },
];
const sections = [
  { key: "registration", label: "Регистрация", ordinal: 0, repeatable: true },
];
describe("independent dataset schema", () => {
  it("covers all 29 unique ERP types with localized field labels, sections and stable keys", () => {
    expect(
      new Set(ANNOTATION_PRESETS.map((p) => p.documentTypeCode)).size,
    ).toBe(29);
    expect(ANNOTATION_PRESETS).toHaveLength(31);
    for (const p of ANNOTATION_PRESETS) {
      expect(validateCatalogFields(p.fields)).toHaveLength(p.fields.length);
      for (const f of p.fields) {
        expect(f.label).toMatch(/[А-Яа-яЁё]/);
        expect(p.sections?.some((s) => s.key === f.sectionKey)).toBe(true);
      }
    }
    for (const key of ["birth_place", "issued_by"])
      expect(
        ANNOTATION_PRESETS.find((p) => p.profile === "RU")?.fields.find(
          (f) => f.key === key,
        )?.multiline,
      ).toBe(true);
  });
  it("generates unique keys without modifying established codes", () => {
    const fields = validateCatalogFields([
      { key: "", label: "Место рождения", ordinal: 0, multiline: true },
      { key: "", label: "Место рождения", ordinal: 1, multiline: true },
      {
        key: "birth_place",
        label: "Другое название",
        ordinal: 2,
        multiline: true,
      },
    ]);
    expect(fields.map((f) => f.key)).toEqual([
      "mesto_rozhdeniya",
      "mesto_rozhdeniya_2",
      "birth_place",
    ]);
  });
  it("keeps multiple registration stamps and each literal text line separate", () => {
    const instances = ["one", "two"].map((id) => ({
      id,
      sectionKey: "registration",
      availability: "PRESENT" as const,
      pageIds: ["page"],
    }));
    const fields: FieldAnswer[] = instances.map((s, i) => ({
      instanceId: s.id,
      key: "address",
      disposition: "PRESENT",
      regions: [{ ...region, id: `r${i}` }],
      lines: [
        {
          id: `l${i}`,
          pageId: "page",
          order: 0,
          text: `Адрес ${i}`,
          quad: [0.2, 0.2, 0.5, 0.2, 0.5, 0.3, 0.2, 0.3],
        },
      ],
    }));
    expect(() =>
      validateAnswers(fields, definitions, [page], true, true),
    ).not.toThrow();
    expect(() =>
      validateDataset(fields, definitions, sections, instances, [page], true),
    ).not.toThrow();
    expect(() =>
      validateDataset(
        fields,
        definitions,
        sections,
        [instances[0]],
        [page],
        true,
      ),
    ).toThrow();
  });
  it("distinguishes missing scans from absent fields and retains unreadable segmentation contours", () => {
    const missing = [
      {
        id: "one",
        sectionKey: "registration",
        availability: "NOT_UPLOADED" as const,
        pageIds: [],
      },
    ];
    expect(() =>
      validateDataset([], definitions, sections, missing, [page], true),
    ).toThrow();
    const instances = [
      { ...missing[0], availability: "PRESENT" as const, pageIds: ["page"] },
    ];
    const fields = [
      {
        key: "address",
        instanceId: "one",
        disposition: "UNREADABLE",
        lines: [],
        regions: [region],
      },
    ];
    expect(() =>
      validateDataset(fields, definitions, sections, instances, [page], true),
    ).not.toThrow();
    expect(() =>
      validateDataset(
        [{ ...fields[0], disposition: "NOT_PRESENT" }],
        definitions,
        sections,
        instances,
        [page],
        true,
      ),
    ).toThrow();
  });
  it("preserves 0/90/180/270 headings and rejects invalid polygons", () => {
    for (const orientationDeg of [0, 90, 180, 270])
      expect(() =>
        validateRegion({ ...region, orientationDeg }, [page]),
      ).not.toThrow();
    for (const polygon of [
      [0.1, 0.1, 0.9, 0.9, 0.9, 0.1, 0.1, 0.9],
      [0.1, 0.1, 1.1, 0.1, 0.9, 0.9],
      [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
    ])
      expect(() => validateRegion({ ...region, polygon }, [page])).toThrow();
    expect(() =>
      validateRegion({ ...region, orientationDeg: 360 }, [page]),
    ).toThrow();
  });
  it("normalizes actual duplicate ERP identities and refuses conflicting field definitions", () => {
    const row = {
      УИНДокумента: "10fa3e03-751b-11ec-80cd-002590854e7f",
      НаименованиеДокумента: "Диплом",
      КодыДолжностей: ["a"],
      ВсемРФ: false,
      ВсемИГ: true,
      requiredFields: ["issueDate"],
      optionalFields: ["number"],
    };
    const parsed = erpCatalogSchema.parse([
      row,
      { ...row, ВсемРФ: true, КодыДолжностей: ["b"], Этап: "Другой" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].ВсемРФ).toBe(true);
    expect(parsed[0].КодыДолжностей).toEqual(["a", "b"]);
    expect(() =>
      erpCatalogSchema.parse([row, { ...row, requiredFields: ["number"] }]),
    ).toThrow();
  });
});
