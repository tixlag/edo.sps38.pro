import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DocumentVersionDto } from "@edo/api-client";
import {
  DocumentOcrFields,
  DocumentReviewMetadata,
} from "./DocumentOcrDetails";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
function render(properties: Partial<DocumentVersionDto>) {
  const data = {
    ocrFields: [],
    issues: [],
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    ...properties,
  } as DocumentVersionDto;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <>
        <DocumentReviewMetadata data={data} />
        <DocumentOcrFields data={data} />
      </>,
    ),
  );
  return container;
}
describe("OCR review details", () => {
  it("shows unmapped fields and the original Paddle confidence after GLM fallback", () => {
    const node = render({
      ocrFields: [
        {
          name: "pas_surname",
          documentFieldName: "lastNameLatin",
          value: "FINAL",
          source: "GLM",
          paddleText: "ORIGINAL",
          paddleConfidence: 0.42,
        },
      ],
    });
    expect(node.textContent).toContain("Фамилия латиницей");
    expect(node.textContent).toContain("FINAL");
    expect(node.textContent).toContain("Источник: GLM");
    expect(node.textContent).toContain("PaddleOCR: ORIGINAL");
    expect(node.textContent).toContain("42%");
    expect(node.querySelector("input,textarea")).toBeNull();
  });
  it("does not invent confidence when only GLM ran", () => {
    const node = render({
      ocrFields: [
        {
          name: "first_name",
          documentFieldName: null,
          value: "TEST",
          source: "GLM",
          paddleText: null,
          paddleConfidence: null,
        },
      ],
    });
    expect(node.textContent).not.toContain("Уверенность PaddleOCR");
    expect(node.textContent).not.toContain("100%");
  });
  it("shows both UTC timestamps and reviewer identity", () => {
    const node = render({
      submittedAt: "2026-10-20T08:00:00.000Z",
      reviewedAt: "2026-10-20T09:00:00.000Z",
      reviewedBy: "reviewer-uuid",
      reviewedByName: "Тестовый Проверяющий",
    });
    expect(node.querySelectorAll("time")).toHaveLength(2);
    expect(node.querySelector("time")?.dateTime).toBe(
      "2026-10-20T08:00:00.000Z",
    );
    expect(node.textContent).toContain("Тестовый Проверяющий");
  });
  it("allows manual review on OCR failure and explains pending decisions", () => {
    const node = render({
      job: {
        id: "job",
        status: "FAILED",
        errorCode: "OCR_UNAVAILABLE",
        cleanupPending: false,
      },
    });
    expect(node.textContent).toContain("Доступна ручная проверка");
    expect(node.textContent).toContain("решение ещё не принято");
    expect(node.textContent).toContain("дата неизвестна");
  });
});
