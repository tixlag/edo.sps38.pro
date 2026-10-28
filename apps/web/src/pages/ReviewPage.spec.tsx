import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewDocumentPage, ReviewPage } from "./ReviewPage";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  permissions: { "20011": [] } as Record<string, unknown>,
  queue: vi.fn(),
  candidates: vi.fn(),
  facets: vi.fn(),
  documentInfo: null as unknown,
  documentVersion: null as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
  useParams: () => ({ documentId: "document-1" }),
}));
vi.mock("@edo/api-client", () => {
  const list = { data: { items: [] }, isLoading: false, isError: false };
  return {
    useGetMe: () => ({ data: { permissions: state.permissions } }),
    useGetDocumentInfo: () => ({ data: state.documentInfo }),
    useListCandidateReviewQueue: (...args: unknown[]) => {
      state.queue(...args);
      return list;
    },
    useListReviewCandidates: (...args: unknown[]) => {
      state.candidates(...args);
      return list;
    },
    useGetReviewDocumentFacets: (...args: unknown[]) => {
      state.facets(...args);
      return {
        data: { managers: [], mentors: [], projects: [], citizenships: [] },
      };
    },
    useListPositions: () => list,
    useListDocumentTypes: () => list,
    getListReviewCandidatesQueryKey: (params: unknown) => [
      "candidates",
      params,
    ],
    getGetReviewDocumentFacetsQueryKey: (params: unknown) => ["facets", params],
    getListCandidateReviewQueueQueryKey: (params: unknown) => ["queue", params],
  };
});
vi.mock("../components/CandidateDrawer", () => ({
  CandidateDrawer: () => null,
}));
vi.mock("../components/DocumentReviewWorkspace", () => ({
  DocumentReviewWorkspace: () => null,
}));
vi.mock("../lib/use-live-document-version", () => ({
  useLiveDocumentVersion: () => ({ data: state.documentVersion }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function render(group: "RU" | "IG") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ReviewPage reviewGroup={group} />));
  return container;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
  state.search = {};
  state.permissions = { "20011": [] };
  state.documentInfo = null;
  state.documentVersion = null;
});

describe("RU and IG review pages", () => {
  it("keeps the document review page vertically scrollable on desktop", async () => {
    state.documentInfo = {
      title: "Паспорт",
      currentVersion: 1,
      pendingDeliveryVersions: [],
      status: "IN_REVIEW",
      candidate: { fullName: "Проверяемый", reviewGroup: "IG" },
    };
    state.documentVersion = {
      documentId: "document-1",
      version: 1,
      status: "IN_REVIEW",
      files: [],
      fields: [],
      revision: 1,
    };
    const view = await renderDocument();
    expect(view.firstElementChild?.className).toContain("overflow-y-auto");
    expect(view.firstElementChild?.className).not.toContain("lg:overflow-hidden");
  });

  it("uses the IG group for every queue-specific data source", async () => {
    const view = await render("IG");
    expect(view.textContent).toContain("Проверка документов ИГ");
    for (const query of [state.queue, state.candidates, state.facets]) {
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ reviewGroup: "IG" }),
        expect.objectContaining({
          query: expect.objectContaining({ enabled: true }),
        }),
      );
    }
  });

  it("keeps IG navigation on its route and resets pagination when changing the tab", async () => {
    const view = await render("IG");
    const tab = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Возвращённые",
    )!;
    await act(async () => tab.click());
    const navigation = state.navigate.mock.calls.at(-1)![0];
    expect(navigation.to).toBe("/review-ig");
    expect(navigation.search({ cursor: "old", projectCode: "P1" })).toEqual({
      status: "RETURNED",
      projectCode: "P1",
    });
  });

  it("disables all IG queue queries for a RU-only reviewer", async () => {
    state.permissions = { "20002": [] };
    const view = await render("IG");
    expect(view.textContent).toContain("Нет доступа");
    for (const query of [state.queue, state.candidates, state.facets]) {
      expect(query).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          query: expect.objectContaining({ enabled: false }),
        }),
      );
    }
  });
});

async function renderDocument() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<ReviewDocumentPage reviewGroup="IG" />),
  );
  return container;
}
