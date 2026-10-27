import { describe, it, expect } from "vitest";
import { validateCatalogFields } from "../src/annotations/annotation-validation";
describe("ERP-independent annotation field catalog", () => {
  it("preserves admin keys, multiline behavior and optional business mapping", () => {
    expect(
      validateCatalogFields([
        {
          key: "literal_place",
          label: "Место рождения",
          ordinal: 0,
          multiline: true,
          businessFieldName: null,
        },
      ]),
    ).toEqual([
      {
        key: "literal_place",
        label: "Место рождения",
        ordinal: 0,
        multiline: true,
        businessFieldName: null,
      },
    ]);
  });
  it("rejects ambiguous order and duplicate keys", () => {
    for (const fields of [
      [
        { key: "a", label: "A", ordinal: 0, multiline: false },
        { key: "b", label: "B", ordinal: 0, multiline: true },
      ],
      [
        { key: "a", label: "A", ordinal: 0, multiline: false },
        { key: "a", label: "B", ordinal: 1, multiline: true },
      ],
    ])
      expect(() => validateCatalogFields(fields)).toThrow();
  });
});
import { suggestAnnotationFields } from "../src/annotations/annotation-catalog-defaults";
it("suggests physical fields, localized labels and multiline defaults without operational flags", () => {
  expect(
    suggestAnnotationFields([
      { name: "comment", ordinal: 0 },
      { name: "issuedBy", ordinal: 1 },
      { name: "placeBirth", ordinal: 2 },
      { name: "isIdentityDocument", ordinal: 3 },
    ]),
  ).toEqual([
    {
      key: "issuedBy",
      label: "Кем выдан",
      ordinal: 0,
      multiline: true,
      businessFieldName: "issuedBy",
    },
    {
      key: "placeBirth",
      label: "Место рождения",
      ordinal: 1,
      multiline: true,
      businessFieldName: "placeBirth",
    },
  ]);
});
