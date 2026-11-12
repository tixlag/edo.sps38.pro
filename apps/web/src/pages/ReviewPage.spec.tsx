vi.mock("../lib/use-visible-ru-document-sync", () => ({
  useVisibleRuDocumentSync: () => ({
    pendingIds: new Set(),
    error: false,
    retry: vi.fn(),
  }),
}));
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewDocumentPage, ReviewPage } from "./ReviewPage";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  links: [] as Array<Record<string, unknown>>,
  search: {} as Record<string, unknown>,
  permissions: { "20011": [] } as Record<string, unknown>,
  queue: vi.fn(),
  candidates: vi.fn(),
  facets: vi.fn(),
  documentInfo: null as unknown,
  documentVersion: null as unknown,
  queueItems: [] as unknown[],
  drawer: vi.fn(),
  workspace: vi.fn(),
  arrivalQueue: vi.fn(),
  params: { documentId: "document-1" },
  documentList: [] as unknown[],
  meFullName: null as string | null,
  catalogManagers: [] as Array<{ id: string; name: string }>,
  statuses: [] as Array<{ id: string; name: string }>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children: ReactNode; search?: unknown; to?: unknown }) => {
    state.links.push(props);
    return <a>{props.children}</a>;
  },
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
  useParams: () => state.params,
}));
vi.mock("@edo/api-client", () => {
  const list = { data: { items: [] }, isLoading: false, isError: false };
  return {
    useGetMe: () => ({
      data: { permissions: state.permissions, fullName: state.meFullName },
      isLoading: false,
    }),
    useListCatalogManagers: () => ({
      data: { items: state.catalogManagers },
      isLoading: false,
      isError: false,
    }),
    useListCandidateStatuses: () => ({
      data: { items: state.statuses },
      isLoading: false,
      isError: false,
    }),
    getListCatalogManagersQueryKey: () => ["catalog-managers"],
    getListCandidateStatusesQueryKey: () => ["candidate-statuses"],
    useGetDocumentInfo: () => ({ data: state.documentInfo }),
    useGetCandidateDetails: () => ({ data: { documents: state.documentList } }),
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
vi.mock("../components/CreateCandidate", () => ({
  CreateCandidate: ({ onCancel }: { onCancel: () => void }) => (
    <div>
      <span>Форма создания кандидата</span>
      <button onClick={onCancel}>Отмена создания</button>
    </div>
  ),
}));
vi.mock("../components/DocumentReviewWorkspace", () => ({
  DocumentReviewWorkspace: (props: unknown) => {
    state.workspace(props);
    return null;
  },
}));
vi.mock("../components/IgArrivalReviewQueue", () => ({
  IgArrivalReviewQueue: (props: {
    onSelectCandidate: (
      id: string,
      context: {
        memberUid: string;
        date: string;
        location: string;
        status: string;
      },
    ) => void;
  }) => {
    state.arrivalQueue(props);
    return (
      <div data-testid="ig-arrival-review-queue">
        <span>Списочные заезды ИГ</span>
        <button
          onClick={() =>
            props.onSelectCandidate("cand-arrival-1", {
              memberUid: "member-1",
              date: "2026-11-10",
              location: "Склад",
              status: "HISTORICAL",
            })
          }
        >
          Выбрать кандидата из заезда
        </button>
      </div>
    );
  },
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
  vi.useRealTimers();
  state.search = {};
  state.links = [];
  state.permissions = { "20011": [] };
  state.documentInfo = null;
  state.documentVersion = null;
  state.queueItems = [];
  state.documentList = [];
  state.params = { documentId: "document-1" };
  state.meFullName = null;
  state.catalogManagers = [];
  state.statuses = [];
});

describe("RU and IG review pages", () => {
  it("shows the RU candidate title and opens the create form from the list", async () => {
    state.permissions = { "20002": [] };
    const view = await render("RU");
    expect(view.querySelector("h1")?.textContent).toBe("Кандидаты РУ");
    const create = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Создать кандидата",
    )!;
    await act(async () => create.click());
    expect(view.textContent).toContain("Форма создания кандидата");
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Отмена создания")!
        .click(),
    );
    expect(view.textContent).not.toContain("Форма создания кандидата");
  });
  it("displays candidate status badge in CandidateRow when statusName is present", async () => {
    state.permissions = { "20002": [] };
    state.queueItems = [
      {
        candidate: {
          id: "cand-1",
          fullName: "Сергеев Сергей",
          statusName: "Подбор",
        },
        documents: [],
      },
    ];
    const view = await render("RU");
    expect(view.textContent).toContain("Подбор");
  });
  it("defaults manager filter to current user when matching catalog managers", async () => {
    state.permissions = { "20002": [] };
    state.meFullName = "Иванов Иван";
    state.catalogManagers = [{ id: "mgr-1", name: "Иванов Иван" }];
    await render("RU");
    expect(state.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        managerId: "mgr-1",
      }),
      expect.anything(),
    );
  });
  it("allows selecting a candidate status filter in RU review with grouped options", async () => {
    state.permissions = { "20002": [] };
    state.statuses = [
      { id: "Подбор", name: "Подбор" },
      { id: "ЗаездПодтвержден", name: "Заезд подтвержден" },
      { id: "Отказ", name: "Отказ" },
    ];
    const view = await render("RU");
    const input = view.querySelector(
      'button[aria-label="Статус кандидата"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      input.click();
    });
    const listbox = view.querySelector('ul[aria-label="Статус кандидата"]');
    expect(listbox).not.toBeNull();
    const groupHeaders = listbox?.querySelectorAll('[role="presentation"]');
    expect(groupHeaders?.length).toBe(3);
    expect(groupHeaders?.[0].textContent).toBe("Подбор и скрининг");
    expect(groupHeaders?.[1].textContent).toBe("Заезд и оформление");
    expect(groupHeaders?.[2].textContent).toBe("Остальные статусы");
  });
  it("opens all candidates by default in RU while keeping IG on the review queue", async () => {
    state.permissions = { "20002": [] };
    await render("RU");
    expect(state.queue).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewGroup: "RU", status: "ALL" }),
      expect.anything(),
    );
    await act(async () => root?.unmount());
    container?.remove();
    state.permissions = { "20011": [] };
    await render("IG");
    expect(state.queue).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewGroup: "IG", status: "IN_REVIEW" }),
      expect.anything(),
    );
  });
  it("opens the candidate chat directly from the RU queue", async () => {
    state.permissions = { "20002": [] };
    state.queueItems = [
      {
        candidate: {
          id: "candidate-1",
          fullName: "Иван Иванов",
          stageProgress: [],
        },
        documents: [],
      },
    ];
    const view = await render("RU");
    const row = view.querySelector(
      '[aria-label="Открыть чат: Иван Иванов"]',
    ) as HTMLButtonElement;
    expect(row.hasAttribute("aria-haspopup")).toBe(false);
    await act(async () => row.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/review/candidates/$candidateId",
      params: { candidateId: "candidate-1" },
    });
  });
  it("shows stage progress and highlights documents awaiting review", async () => {
    vi.useFakeTimers();
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
    expect(tooltip.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(tooltip.textContent).toContain("Одобрен");
    expect(tooltip.textContent).toContain("На проверке");
    expect(tooltip.textContent).toContain("Не загружен");
    expect(tooltip.textContent).not.toContain("Ошибка OCR");
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
    await act(async () => vi.advanceTimersByTimeAsync(121));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => ring.blur());
    const hover = new Event("pointerover", { bubbles: true });
    Object.defineProperty(hover, "pointerType", { value: "mouse" });
    await act(async () => ring.dispatchEvent(hover));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => ring.click());
    await act(async () => vi.advanceTimersByTimeAsync(121));
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
  it("opens contract preparation independently of the review row", async () => {
    state.permissions = { "20011": [], "20003": [] };
    state.queueItems = [
      {
        candidate: {
          id: "candidate-1",
          fullName: "Иван Иванов",
          stageProgress: [],
        },
        documents: [],
      },
    ];
    const view = await render("IG");
    const button = view.querySelector(
      '[aria-label="Подготовить договор"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(state.navigate).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/signing",
      search: { candidateId: "candidate-1" },
    });
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
    expect(view.textContent).not.toContain("Создать кандидата");
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

  it("renders the view switcher on IG review and navigates between list and arrivals", async () => {
    state.permissions = { "20011": [] };
    const view = await render("IG");

    const arrivalsBtn = [...view.querySelectorAll("button")].find(
      (b) => b.textContent === "Списочные заезды",
    );
    const listBtn = [...view.querySelectorAll("button")].find(
      (b) => b.textContent === "Обычный список",
    );
    expect(arrivalsBtn).toBeDefined();
    expect(listBtn).toBeDefined();

    await act(async () => arrivalsBtn!.click());
    const navCall = state.navigate.mock.calls.at(-1)![0];
    expect(navCall.to).toBe("/review-ig");
    expect(navCall.search({})).toEqual({ view: "arrivals" });
  });

  it("renders IgArrivalReviewQueue when view=arrivals in IG and opens candidate drawer on selection", async () => {
    state.permissions = { "20011": [] };
    state.search = { view: "arrivals" };
    const view = await render("IG");

    expect(view.textContent).toContain("Списочные заезды ИГ");

    const selectCandBtn = [...view.querySelectorAll("button")].find(
      (b) => b.textContent === "Выбрать кандидата из заезда",
    );
    expect(selectCandBtn).toBeDefined();

    await act(async () => selectCandBtn!.click());
    const navCall = state.navigate.mock.calls.at(-1)![0];
    expect(navCall.to).toBe("/review-ig");
    expect(navCall.search({ view: "arrivals" })).toEqual({
      view: "arrivals",
      candidate: "cand-arrival-1",
      igParticipation:
        '{"memberUid":"member-1","date":"2026-11-10","location":"Склад","status":"HISTORICAL"}',
    });
  });

  it("does not render the view switcher in RU review", async () => {
    state.permissions = { "20002": [] };
    const view = await render("RU");

    const arrivalsBtn = [...view.querySelectorAll("button")].find(
      (b) => b.textContent === "Списочные заезды",
    );
    expect(arrivalsBtn).toBeUndefined();
  });
});

async function renderDocument() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ReviewDocumentPage reviewGroup="IG" />));
  return container;
}

describe("review document navigation", () => {
  function seedDocument() {
    state.documentInfo = {
      id: "document-1",
      candidateId: "candidate-1",
      title: "Паспорт",
      currentVersion: 1,
      status: "IN_REVIEW",
      pendingDeliveryVersions: [],
      candidate: { fullName: "Иван Иванов", reviewGroup: "IG" },
    };
    state.documentVersion = {
      documentId: "document-1",
      version: 1,
      status: "IN_REVIEW",
    };
    state.documentList = [
      {
        id: "document-1",
        title: "Паспорт",
        currentVersion: 1,
        status: "IN_REVIEW",
      },
      {
        id: "document-2",
        title: "Анкета",
        currentVersion: 3,
        status: "IN_REVIEW",
      },
    ];
    state.search = {
      version: 1,
      status: "IN_REVIEW",
      candidate: "candidate-1",
      candidateStage: "2",
      projectCode: "P1",
    };
  }
  it("retains arrival registry context when returning from a document", async () => {
    seedDocument();
    Object.assign(state.search, {
      view: "arrivals",
      igArchive: "archive",
      igQ: "Алиев",
      igGroups: '["group-a","group-b"]',
      igPages: '{"group-a":"next"}',
      igParticipation:
        '{"memberUid":"member-1","date":"2026-11-10","arrivalDateTime":"2026-11-10T14:35:00","location":"Склад","status":"HISTORICAL"}',
    });
    await renderDocument();
    const link = state.links.find((item) => item.to === "/review-ig");
    expect(link?.search).toEqual(
      expect.objectContaining({
        view: "arrivals",
        igArchive: "archive",
        igQ: "Алиев",
        igGroups: '["group-a","group-b"]',
        igPages: '{"group-a":"next"}',
        igParticipation:
          '{"memberUid":"member-1","date":"2026-11-10","arrivalDateTime":"2026-11-10T14:35:00","location":"Склад","status":"HISTORICAL"}',
        candidate: "candidate-1",
        candidateStage: "2",
      }),
    );
  });
  function nextButton(view: HTMLElement) {
    return [...view.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Следующий на проверке"),
    )!;
  }

  it.each(["IG", "RU"])(
    "opens the current version on the %s route and preserves queue context",
    async (group) => {
      seedDocument();
      (
        state.documentInfo as { candidate: { reviewGroup: string } }
      ).candidate.reviewGroup = group;
      const view = await renderDocument();
      await act(async () => nextButton(view).click());
      const navigation = state.navigate.mock.calls.at(-1)![0];
      expect(navigation.to).toBe(
        group === "IG" ? "/review-ig/$documentId" : "/review/$documentId",
      );
      expect(navigation.params).toEqual({ documentId: "document-2" });
      expect(navigation.search(state.search)).toEqual({
        ...state.search,
        version: 3,
      });
    },
  );

  it("protects dirty drafts and pending operations, then allows switching after cancel or save", async () => {
    seedDocument();
    const view = await renderDocument();
    const report =
      state.workspace.mock.calls.at(-1)![0].onNavigationStateChange;
    await act(async () => report({ hasUnsavedChanges: true, busy: false }));
    await act(async () => nextButton(view).click());
    expect(state.navigate).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Сохраните или отмените правки");
    await act(async () => report({ hasUnsavedChanges: false, busy: true }));
    expect(nextButton(view).disabled).toBe(true);
    await act(async () => report({ hasUnsavedChanges: false, busy: false }));
    await act(async () => nextButton(view).click());
    expect(state.navigate).toHaveBeenCalledOnce();
  });

  it("restores the active document when route params change, keeping the list expanded", async () => {
    seedDocument();
    const view = await renderDocument();
    await act(async () =>
      view.querySelector<HTMLButtonElement>("[aria-expanded]")!.click(),
    );
    state.params = { documentId: "document-2" };
    const previousInfo = state.documentInfo as object;
    state.documentInfo = null;
    state.documentVersion = null;
    state.search = { ...state.search, version: 3 };
    await act(async () =>
      root!.render(<ReviewDocumentPage reviewGroup="IG" />),
    );
    expect(view.querySelector("[aria-expanded]")).toBeNull();
    state.documentInfo = {
      ...previousInfo,
      id: "document-2",
      title: "Анкета",
      currentVersion: 3,
    };
    state.documentVersion = {
      documentId: "document-2",
      version: 3,
      status: "IN_REVIEW",
    };
    state.search = { ...state.search, version: 3 };
    await act(async () =>
      root!.render(<ReviewDocumentPage reviewGroup="IG" />),
    );
    expect(
      view.querySelector("[aria-expanded]")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(view.querySelector('[aria-current="page"]')?.textContent).toContain(
      "Анкета",
    );
    state.params = { documentId: "document-1" };
    state.search = { ...state.search, version: 1 };
    await act(async () =>
      root!.render(<ReviewDocumentPage reviewGroup="IG" />),
    );
    expect(view.querySelector('[aria-current="page"]')?.textContent).toContain(
      "Паспорт",
    );
  });

  it("does not render candidate navigation without an API candidate id or in history", async () => {
    seedDocument();
    (state.documentInfo as { candidateId: string | null }).candidateId = null;
    const view = await renderDocument();
    expect(view.textContent).not.toContain("Документы сотрудника");
    seedDocument();
    await act(async () => root!.render(<ReviewDocumentPage readOnly />));
    expect(view.textContent).not.toContain("Документы сотрудника");
  });
});
