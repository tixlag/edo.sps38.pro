import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewPage } from "./ReviewPage";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  permissions: { "20011": [] } as Record<string, unknown>,
  queue: vi.fn(),
  items: [] as unknown[],
  candidates: vi.fn(),
  facets: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
}));
vi.mock("@edo/api-client", () => {
  const list = { data: { items: [] }, isLoading: false, isError: false };
  return {
    useGetMe: () => ({ data: { permissions: state.permissions } }),
    useListCandidateReviewQueue: (...args: unknown[]) => {
      state.queue(...args);
      return { ...list, data: { items: state.items } };
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
  CandidateDrawer: ({ candidateId }: { candidateId: string }) => <div role="dialog" aria-label="Документы сотрудника">{candidateId}</div>,
}));
vi.mock("../components/DocumentReviewWorkspace", () => ({
  DocumentReviewWorkspace: () => null,
}));
vi.mock("../lib/use-live-document-version", () => ({
  useLiveDocumentVersion: () => ({}),
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
  state.items = [];
  state.permissions = { "20011": [] };
});

describe("RU and IG review pages", () => {
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

  it("keeps an IG deep link in the document drawer without redirecting to RU recruitment", async () => {
    state.search = { candidate: "ig-person", status: "RETURNED" };
    const view = await render("IG");
    expect(view.querySelector('[role="dialog"]')?.textContent).toBe("ig-person");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("Каталог и создание кандидатов");
  });

  it("opens IG documents on the IG route and retains the drawer after its URL changes", async () => {
    state.items = [{ candidate: { id: "ig-person", fullName: "Иванов Иван", reviewGroup: "IG", approvedDocuments: 0, requiredDocuments: 1 }, documents: [] }];
    const view = await render("IG");
    const open = view.querySelector<HTMLButtonElement>('button[aria-label="Открыть документы: Иванов Иван"]')!;
    expect(open).not.toBeNull();
    expect(view.querySelector('button[aria-label^="Открыть чат"]')).toBeNull();
    await act(async () => open.click());
    const navigation = state.navigate.mock.calls.at(-1)![0];
    expect(navigation.to).toBe("/review-ig");
    state.search = navigation.search({ status: "IN_REVIEW" });
    await act(async () => root!.render(<ReviewPage reviewGroup="IG" />));
    expect(view.querySelector('[role="dialog"]')?.textContent).toBe("ig-person");
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it("preserves the RU legacy candidate link redirect", async () => {
    state.permissions = { "20002": [] };
    state.search = { candidate: "ru-candidate", status: "RETURNED" };
    await render("RU");
    expect(state.navigate).toHaveBeenCalledWith({ to: "/review/candidates/$candidateId", params: { candidateId: "ru-candidate" }, search: { status: "RETURNED" }, replace: true });
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
