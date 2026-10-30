import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
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
  queueItems: [] as unknown[],
  drawer: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
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
      return { ...list, data: { items: state.queueItems } };
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
  CandidateDrawer: (props: unknown) => {
    state.drawer(props);
    return null;
  },
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
  state.queueItems = [];
});

describe("RU and IG review pages", () => {
  it("shows stage progress and highlights documents awaiting review", async () => {
    state.queueItems = [
      {
        candidate: {
          id: "1",
          fullName: "Иван Иванов",
          stageProgress: [
            {
              stage: 1,
              required: {
                approved: 1,
                pending: 1,
                processing: 0,
                missing: 0,
                attention: 0,
              },
              additional: {
                approved: 0,
                pending: 0,
                processing: 0,
                missing: 1,
                attention: 0,
              },
            },
          ],
        },
        documents: [],
      },
    ];
    const view = await render("IG");
    expect(view.textContent).toContain("Этап 1");
    expect(view.textContent).toContain("Договор");
    const ring = view.querySelector(
      '[aria-label="Открыть документы: Этап 1"]',
    ) as HTMLElement;
    expect(ring).not.toBeNull();
    expect(ring.hasAttribute("title")).toBe(false);
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this === ring)
          return {
            left: 1000,
            top: 740,
            right: 1096,
            bottom: 820,
            width: 96,
            height: 80,
            x: 1000,
            y: 740,
            toJSON: () => ({}),
          };
        if (this.getAttribute("role") === "tooltip")
          return {
            left: 0,
            top: 0,
            right: 352,
            bottom: 250,
            width: 352,
            height: 250,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        return {
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      });
    await act(async () => ring.focus());
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(parseFloat((tooltip as HTMLElement).style.left)).toBeLessThanOrEqual(
      window.innerWidth - 352 - 8,
    );
    expect(parseFloat((tooltip as HTMLElement).style.top)).toBeLessThan(740);
    bounds.mockRestore();
    expect(tooltip.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(tooltip.textContent).toContain("Обязательные");
    expect(tooltip.textContent).toContain("Дополнительные");
    expect(ring.getAttribute("aria-describedby")).toBe(tooltip.id);
    await act(async () => (tooltip as HTMLElement).click());
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () =>
      ring.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => ring.blur());
    const hover = new Event("pointerover", { bubbles: true });
    Object.defineProperty(hover, "pointerType", { value: "mouse" });
    await act(async () => ring.dispatchEvent(hover));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => ring.click());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(state.navigate).toHaveBeenCalled();
    const navigation = state.navigate.mock.calls.at(-1)![0];
    expect(navigation.search({ status: "IN_REVIEW" })).toEqual({
      status: "IN_REVIEW",
      candidate: "1",
      candidateStage: "1",
    });
    const row = view.querySelector(
      '[aria-label="Открыть документы: Иван Иванов"]',
    ) as HTMLButtonElement;
    await act(async () => row.click());
    const openAll = state.navigate.mock.calls.at(-1)![0];
    expect(
      openAll.search({ candidateStage: "1", status: "IN_REVIEW" }),
    ).toEqual({ candidate: "1", status: "IN_REVIEW" });
  });
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
    expect(view.firstElementChild?.className).not.toContain(
      "lg:overflow-hidden",
    );
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

  it("refreshes queue data after a background catalog update", async () => {
    await render("IG");
    expect(state.queue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: expect.objectContaining({ refetchInterval: 30000 }),
      }),
    );
  });

  it("restores stage selection from the URL and clears it on close", async () => {
    state.search = {
      candidate: "c1",
      candidateStage: "none",
      status: "RETURNED",
    };
    await render("IG");
    const props = state.drawer.mock.calls.at(-1)![0];
    expect(props).toMatchObject({
      candidateId: "c1",
      stage: "none",
      returnedHistory: true,
    });
    await act(async () => props.onClose());
    const navigation = state.navigate.mock.calls.at(-1)![0];
    expect(
      navigation.search({
        candidate: "c1",
        candidateStage: "none",
        status: "RETURNED",
      }),
    ).toEqual({ status: "RETURNED" });
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
  await act(async () => root!.render(<ReviewDocumentPage reviewGroup="IG" />));
  return container;
}
