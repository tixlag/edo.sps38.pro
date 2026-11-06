import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CandidateDocumentSummaryDto } from "@edo/api-client";
import { CandidateDocumentList } from "./CandidateDocumentList";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("opens current, returned and ERP-pending versions from the grouped list", async () => {
  const onOpen = vi.fn();
  const doc = {
    id: "d1",
    title: "Паспорт",
    status: "APPROVED",
    currentVersion: 3,
    returnedVersions: [{ version: 1, rejectionReason: "Нечёткое фото" }],
    pendingDeliveryVersions: [2],
  } as CandidateDocumentSummaryDto;
  const groups = {
    required: {
      documents: [doc],
      missingDocuments: [{ code: "other", title: "СНИЛС" }],
    },
    additional: { documents: [], missingDocuments: [] },
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <CandidateDocumentList
        groups={groups}
        documents={[doc]}
        onOpen={onOpen}
      />,
    ),
  );
  expect(node.textContent).toContain("Обязательные");
  expect(node.textContent).toContain("Документ принят");
  expect(node.textContent).toContain("Не загружен");
  const current = node.querySelector(
    'button[aria-label="Паспорт, версия 3"]',
  ) as HTMLButtonElement;
  await act(async () => current.click());
  expect(onOpen).toHaveBeenLastCalledWith(doc);
  const returned = [...node.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Нечёткое фото"),
  )!;
  await act(async () => returned.click());
  expect(onOpen).toHaveBeenLastCalledWith(doc, 1);
  const pending = [...node.querySelectorAll("button")].find(
    (button) => button.textContent === "2",
  )!;
  await act(async () => pending.click());
  expect(onOpen).toHaveBeenLastCalledWith(doc, 2);
  await act(async () => root.unmount());
  node.remove();
});
