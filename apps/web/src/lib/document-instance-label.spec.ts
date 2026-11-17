import { describe, expect, it } from "vitest";
import type {
  CandidateDocumentSummaryDto,
  DocumentVersionDto,
} from "@edo/api-client";
import {
  documentInstanceLabel,
  documentRequisites,
} from "./document-instance-label";

describe("document instance labels", () => {
  it("uses number, date and education organization without technical fields", () => {
    expect(
      documentRequisites({
        number: "1234",
        series: "АБ",
        issueDate: "2023-06-20",
        education_organization: "ИРНИТУ",
        employeeUid: "private",
      }),
    ).toBe("№ АБ 1234 · от 20.06.2023 · ИРНИТУ");
    expect(
      documentRequisites({
        id: "internal",
        raw: { number: "wrong" },
        number: "  ",
      }),
    ).toBe("");
  });
  it("uses a meaningful ordinal and available submission date when requisites are absent", () => {
    const document = {
      submittedAt: "2026-11-16T08:15:00Z",
      currentVersion: 7,
    } as CandidateDocumentSummaryDto;
    const label = documentInstanceLabel(document, 1);
    expect(label).toContain("Документ 2 · отправлен 16.11.2026");
    expect(label).not.toContain("версия");
    expect(documentInstanceLabel({ ...document, submittedAt: null }, 0)).toBe(
      "Документ 1 · дата отправки неизвестна",
    );
  });
  it("reads the selected version's reviewed values, not OCR guesses", () => {
    const version = {
      fields: [{ name: "number", value: "Д-42", originalValue: "wrong" }],
    } as DocumentVersionDto;
    expect(
      documentInstanceLabel(
        { submittedAt: null } as CandidateDocumentSummaryDto,
        0,
        version,
      ),
    ).toBe("Документ 1 · № Д-42");
  });
});
