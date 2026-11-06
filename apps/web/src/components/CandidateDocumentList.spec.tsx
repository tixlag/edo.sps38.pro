import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CandidateDocumentSummaryDto } from "@edo/api-client";
import { CandidateDocumentList } from "./CandidateDocumentList";
import type { PreviousDocumentAvailabilityDto } from "@edo/api-client";
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
        candidateId="candidate"
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

it("shows former documents inside their stage group without contradictory missing rows", async () => {
  const previous: PreviousDocumentAvailabilityDto[] = [
    {
      id: "old-snils",
      documentUid: "snils",
      documentTypeCode: "SNILS",
      title: "СНИЛС",
      category: "required",
      state: "REUSED",
      expiresAt: null,
      recordedAt: null,
      originalAvailable: true,
      source: "EDO",
      sourceDescription: "Из ЭДО",
      fields: {},
    },
    {
      id: "old-policy",
      documentUid: "policy",
      documentTypeCode: "POLICY",
      title: "Полис",
      category: "required",
      state: "EXPIRED",
      expiresAt: "2000-01-01",
      recordedAt: "1999-01-01",
      originalAvailable: true,
      source: "EDO",
      sourceDescription: "Из ЭДО",
      fields: {},
    },
    {
      id: "old-diploma",
      documentUid: "diploma",
      documentTypeCode: "DIPLOMA",
      title: "Диплом",
      category: "additional",
      state: "ORIGINAL_UNAVAILABLE",
      expiresAt: null,
      recordedAt: null,
      originalAvailable: false,
      source: "ERP",
      sourceDescription: "Из ERP",
      fields: {},
    },
  ];
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <CandidateDocumentList
        candidateId="cycle"
        groups={{
          required: {
            documents: [],
            missingDocuments: [{ code: "POLICY", title: "Полис" }],
          },
          additional: { documents: [], missingDocuments: [] },
        }}
        documents={[]}
        previousDocuments={previous}
        onOpen={() => {}}
      />,
    ),
  );
  const required = node.querySelector('section[aria-label="Обязательные"]')!;
  const additional = node.querySelector(
    'section[aria-label="Дополнительные"]',
  )!;
  expect(required.textContent).toContain("Зачтён ранее");
  expect(required.textContent).toContain("Нужна замена");
  expect(required.textContent).not.toContain("Не загружен");
  expect(required.querySelectorAll("li")).toHaveLength(2);
  expect(additional.textContent).toContain("Оригинал недоступен");
  expect(additional.querySelector("button")?.disabled).toBe(true);
  expect(node.textContent).toContain("Зачтено с прошлого приёма/заезда: 1");
  expect(node.textContent).not.toContain("Бессрочный");
  await act(async () => root.unmount());
  node.remove();
});
