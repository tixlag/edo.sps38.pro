vi.mock("../components/ApprovedErpDocumentPreview", () => ({ ApprovedErpDocumentPreview: ({ document }: { document: { id: string } }) => <div data-erp-original={document.id}>Оригинал ERP</div> }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
import { expect, it, vi } from "vitest";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CandidateWorkspacePage } from "./CandidateWorkspacePage";
const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  calls: [] as unknown[],
  chatMounts: 0,
  documents: [] as unknown[],
  previousDocuments: [] as unknown[],
  enrichment: undefined as { status: string; profileReady: boolean; documentsReady: boolean } | undefined,
  request: vi.fn(),
  candidate: undefined as Record<string, unknown> | undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate:
    () =>
    (value: {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    }) => {
      state.search = value.search(state.search);
    },
  useParams: () => ({ candidateId: "c1" }),
  useSearch: () => state.search,
}));
vi.mock("@edo/api-client", () => ({
  getListCandidatePreviousDocumentsQueryKey: () => ["previous"],
  getListCandidateReviewQueueQueryKey: () => ["queue"],
  getListReviewCandidatesQueryKey: () => ["candidates"],
  getListIgArrivalRegistryGroupsQueryKey: () => ["groups"],
  getListIgArrivalRegistryParticipationsQueryKey: () => ["people"],
  useRequestCandidateEnrichment: () => ({ mutate: state.request, isError: false }),
  getCandidatePreviousDocumentOriginal: vi.fn().mockResolvedValue(new Blob(["erp-original"], { type: "image/jpeg" })),
  useGetMe: () => ({ data: { permissions: { "20002": [] } } }),
  getGetCandidateWorkspaceQueryKey: () => ["workspace", "c1"],
  useGetCandidateWorkspace: () => ({}),
  useGetDocumentInfo: () => ({ isLoading: true }),
  getGetCandidateDetailsQueryKey: () => ["details", "c1"],
  useGetCandidateDetails: (_id: string, params?: { stage?: string }) => {
    state.calls.push(params);
    const counts = {
      approved: 0,
      pending: 0,
      processing: 0,
      missing: 1,
      attention: 0,
    };
    return {
      refetch: vi.fn().mockResolvedValue({}),
      data: {
        enrichment: state.enrichment,
        candidate: {
          fullName: "Кандидат",
          stageProgress: [{ stage: 1, required: counts, additional: counts }],
          approvedDocuments: 0,
          requiredDocuments: 1,
          ...state.candidate,
        },
        documents: state.documents,
        previousDocuments: state.previousDocuments,
        ...(params?.stage
          ? {
              stageDocuments: {
                required: {
                  documents: [
                    {
                      id: "doc2",
                      title: "СНИЛС",
                      status: "IN_REVIEW",
                      currentVersion: 2,
                      pendingDeliveryVersions: [],
                      returnedVersions: [],
                    },
                  ],
                  missingDocuments: [{ code: "passport", title: "Паспорт" }],
                },
                additional: { documents: [], missingDocuments: [] },
              },
            }
          : {}),
      },
    };
  },
}));
vi.mock("../components/CandidateManagement", () => ({
  CandidateManagement: () => <div>Данные и оформление кандидата</div>,
}));
vi.mock("../components/CandidateChat", () => ({
  CandidateChat: () => {
    useEffect(() => {
      state.chatMounts += 1;
    }, []);
    return <div>Содержимое переписки</div>;
  },
}));
vi.mock("../components/CandidateRequirements", () => ({
  CandidateRequirements: () => null,
}));
vi.mock("../components/DocumentReviewWorkspace", () => ({
  DocumentReviewWorkspace: () => null,
}));
vi.mock("../lib/use-live-document-version", () => ({
  useLiveDocumentVersion: () => ({}),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
URL.createObjectURL = vi.fn(() => "blob:erp-original");
URL.revokeObjectURL = vi.fn();
it("keeps the chat and candidate data visible while selecting a document stage", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  await act(async () => root.render(<CandidateWorkspacePage />));
  expect(node.textContent).toContain("Данные и оформление кандидата");
  expect(node.textContent).toContain("Содержимое переписки");
  expect(state.chatMounts).toBe(1);
  state.search.document = "doc1";
  await act(async () => root.render(<CandidateWorkspacePage />));
  const stageAccordion = [...node.querySelectorAll("button")].find((btn) =>
    btn.textContent?.includes("Этап 1"),
  ) as HTMLElement;
  expect(stageAccordion).not.toBeNull();
  await act(async () => stageAccordion.click());
  await act(async () => root.render(<CandidateWorkspacePage />));
  expect(state.search.stage).toBe("1");
  expect(state.search.document).toBeUndefined();
  expect(state.calls).toContainEqual({ stage: "1" });
  expect(node.textContent).toContain("Паспорт");
  expect(node.textContent).toContain("Не загружен");
  expect(node.textContent).toContain("Ожидает проверки");
  const documentButton = node.querySelector(
    'button[aria-label="СНИЛС, версия 2"]',
  ) as HTMLButtonElement;
  expect(documentButton).not.toBeNull();
  await act(async () => documentButton.click());
  expect(state.search.document).toBe("doc2");
  expect(state.search.version).toBe(2);
  expect(node.textContent).toContain("Содержимое переписки");
  expect(state.chatMounts).toBe(1);
  await act(async () => root.unmount());
  node.remove();
});

it("renders unified breadcrumbs, expressive candidate header with status badge and metadata chips, and stage accordions in aside", async () => {
  state.search = {};
  state.candidate = {
    fullName: "Иванов Иван Иванович",
    statusName: "Заезд/выход",
    citizenship: "ru",
    isReemployment: true,
    birthDate: "1990-05-17",
    positionName: "Электромонтажник",
    projectName: "ТЦ Север",
    projectCode: "PRJ1",
    managerName: "Петров П.П.",
    mentorName: "Сидоров С.С.",
  };

  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<CandidateWorkspacePage />));

  // 1. Breadcrumbs
  expect(node.textContent).toContain("Очередь проверки");
  expect(node.textContent).toContain("/");
  expect(node.textContent).toContain("Каталог кандидатов");

  // 2. Candidate header & badges
  const heading = node.querySelector("h1");
  expect(heading?.textContent).toBe("Иванов Иван Иванович");
  expect(heading?.className).toContain("text-lg");
  expect(heading?.className).toContain("font-bold");

  expect(node.textContent).toContain("Заезд/выход");
  expect(node.textContent).toContain("RU");
  expect(node.textContent).toContain("Повторный найм");

  // Metadata chips
  expect(node.textContent).toContain("17.05.1990");
  expect(node.textContent).toContain("Электромонтажник");
  expect(node.textContent).toContain("ТЦ Север (PRJ1)");
  expect(node.textContent).toContain("Менеджер: Петров П.П.");
  expect(node.textContent).toContain("Наставник: Сидоров С.С.");

  // 3. Stage navigation strip removed, stages are in the documents aside
  const nav = node.querySelector('nav[aria-label="Этапы документов"]');
  expect(nav).toBeNull();
  expect(node.textContent).toContain("Этап 1");

  await act(async () => root.unmount());
  node.remove();
  state.candidate = undefined;
});

it("renders informative collapsed state with candidate initials and status dot when sidebar is collapsed", async () => {
  state.search = {};
  state.candidate = {
    fullName: "Иванов Иван",
    statusName: "Подбор",
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<CandidateWorkspacePage />));

  const collapseBtn = node.querySelector<HTMLButtonElement>(
    'button[aria-label="Свернуть данные кандидата"]',
  );
  expect(collapseBtn).not.toBeNull();
  await act(async () => collapseBtn?.click());

  const expandBtn = node.querySelector<HTMLButtonElement>(
    'button[aria-label="Развернуть данные кандидата"]',
  );
  expect(expandBtn).not.toBeNull();
  expect(node.textContent).toContain("ИИ");
  const statusDot = node.querySelector('[title="Статус: Подбор"]');
  expect(statusDot).not.toBeNull();

  await act(async () => root.unmount());
  node.remove();
  state.candidate = undefined;
});

it("shows synchronization instead of temporary empty documents and counters until ERP is ready", async () => {
  state.search = { stage: "1" };
  state.candidate = { reviewGroup: "RU", requiredDocuments: 0, approvedDocuments: 0 };
  state.enrichment = { status: "PENDING", profileReady: false, documentsReady: false };
  state.request.mockClear();
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<CandidateWorkspacePage />));
  const panel = node.querySelector('[aria-label="Документы кандидата"]')!;
  expect(panel.textContent).toContain("Синхронизация профиля и документов");
  expect(panel.textContent).not.toMatch(/Документы отсутствуют|Не загружен|0 из 0|0\/0|Документы \(0\)/);
  expect(state.request).toHaveBeenCalledTimes(1);
  const callback = state.request.mock.calls[0][1];
  await act(async () => callback.onSuccess());
  state.enrichment = { status: "RUNNING", profileReady: true, documentsReady: false };
  await act(async () => root.render(<CandidateWorkspacePage />));
  expect(panel.textContent).toContain("Синхронизация профиля и документов");
  expect(panel.textContent).not.toContain("Не загружен");
  state.enrichment = { status: "READY", profileReady: true, documentsReady: true };
  state.candidate = { reviewGroup: "RU", requiredDocuments: 1, approvedDocuments: 0 };
  await act(async () => root.render(<CandidateWorkspacePage />));
  expect(panel.textContent).not.toContain("Синхронизация профиля и документов");
  expect(panel.textContent).toContain("СНИЛС");
  expect(panel.querySelector("svg circle")).not.toBeNull();
  await act(async () => root.unmount()); node.remove();
  state.enrichment = undefined;
});

it("opens the approved ERP original for an adaptation document deep link", async () => {
  state.search = { document: "adaptation", version: 1 };
  state.candidate = { reviewGroup: "RU" };
  state.enrichment = undefined;
  state.documents = [{ id: "adaptation", documentTypeCode: "PASSPORT", status: "IN_REVIEW", title: "Паспорт", currentVersion: 1 }];
  state.previousDocuments = [{ id: "approved-erp", documentTypeCode: "PASSPORT", source: "ERP", state: "REUSED", originalAvailable: true }];
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<CandidateWorkspacePage />));
  expect(node.querySelector('[data-erp-original="approved-erp"]')).not.toBeNull();
  expect(node.textContent).not.toContain("Загрузка документа…");
  await act(async () => root.unmount()); node.remove();
  state.documents = []; state.previousDocuments = [];
});
