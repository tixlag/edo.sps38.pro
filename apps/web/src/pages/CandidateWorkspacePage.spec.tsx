import { expect, it, vi } from "vitest";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CandidateWorkspacePage } from "./CandidateWorkspacePage";
const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  calls: [] as unknown[],
  chatMounts: 0,
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
      data: {
        candidate: {
          fullName: "Кандидат",
          stageProgress: [{ stage: 1, required: counts, additional: counts }],
          approvedDocuments: 0,
          requiredDocuments: 1,
        },
        documents: [],
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
  const stage = node.querySelector(
    '[aria-label="Открыть документы: Этап 1"]',
  ) as HTMLElement;
  await act(async () => stage.click());
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
