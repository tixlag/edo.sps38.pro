import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IgArrivalReviewQueue } from "./IgArrivalReviewQueue";

const state = vi.hoisted(() => ({
  search: { view: "arrivals" } as Record<string, unknown>,
  groupCalls: [] as unknown[],
  personCalls: [] as unknown[],
  personOverrides: {} as Record<string, unknown>,
  personError: false,
  groupsError: false,
  refetch: vi.fn(),
  select: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state.search,
  useNavigate:
    () =>
    (options: {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    }) => {
      state.search = options.search(state.search);
    },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("@edo/api-client", () => ({
  getListIgArrivalRegistryParticipationsQueryKey: () => ["people"],
  getListIgArrivalRegistryGroupsQueryKey: (params: unknown) => [
    "groups",
    params,
  ],
  getListIgArrivalRegistryLocationsQueryKey: (params: unknown) => [
    "locations",
    params,
  ],
  useListIgArrivalRegistryLocations: (params: { locationUid?: string }) => ({
    data: {
      items: params.locationUid
        ? [{ locationUid: "selected", locationName: "Склад Восток" }]
        : [{ locationUid: "1", locationName: "Склад" }],
      nextCursor: null,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useGetMe: () => ({ data: { permissions: { "20011": [] } } }),
  useListIgArrivalRegistryGroups: (params: unknown) => {
    state.groupCalls.push(params);
    return {
      data: {
        items: [
          {
            groupKey: "a",
            group: "assigned",
            arrivalDate: "2026-11-10",
            locationUid: "1",
            locationName: "Склад",
            participationCount: 1,
            totalParticipationCount: 1,
            needsAttentionCount: 0,
          },
          {
            groupKey: "b",
            group: "assigned",
            arrivalDate: "2026-11-10",
            locationUid: "2",
            locationName: "Завод",
            participationCount: 1,
            totalParticipationCount: 1,
            needsAttentionCount: 0,
          },
        ],
        nextCursor: null,
        sync: { lastCompletedAt: null },
      },
      isLoading: false,
      isError: state.groupsError,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
  useListIgArrivalRegistryParticipations: (params: { groupKey: string }) => {
    state.personCalls.push(params);
    return {
      data: state.personError ? undefined : {
        items: [
          {
            arrivalMemberUid: params.groupKey,
            personUid: params.groupKey,
            code1c: "123",
            candidateId: params.groupKey,
            fullName: params.groupKey === "a" ? "Алиев" : "Каримов",
            arrivalDate: "2026-11-10",
            arrivalDateTime: null,
            locationUid: "1",
            locationName: "Склад",
            participationStatus: "CURRENT",
            personState: "CURRENT",
            documentStatus: "RETURNED",
            approvedDocuments: 1,
            confirmedDocuments: 0,
            erpDeliveryStatus: "PENDING",
            employmentStatus: "IN_PROGRESS",
            statusScope: "CURRENT_CANDIDATE",
            needsAttention: false,
            issueCodes: [],
            sourceRevision: "1",
            oneCEmploymentStatus: "UNKNOWN",
            ...state.personOverrides,
          },
        ],
        nextCursor: null,
        sync: { lastCompletedAt: null },
      },
      isLoading: false,
      isError: state.personError,
      isFetching: false,
      refetch: state.refetch,
    };
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<IgArrivalReviewQueue onSelectCandidate={state.select} />),
  );
  return container;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  state.search = { view: "arrivals" };
  state.groupCalls = [];
  state.personCalls = [];
  state.personOverrides = {};
  state.personError = false;
  state.groupsError = false;
  state.refetch.mockClear();
  state.select.mockClear();
  state.invalidate.mockClear();
});
describe("arrival registry", () => {
  it("refreshes expanded participant data along with groups", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    const view = await render();
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Обновить"))!
        .click(),
    );
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["people"] });
  });
  it("keeps cached groups visible with a warning if refresh fails", async () => {
    state.groupsError = true;
    const view = await render();
    expect(view.textContent).toContain("Склад");
    expect(view.textContent).toContain("Не удалось обновить");
    expect(view.textContent).toContain(
      "актуальность отдельных записей не подтверждена",
    );
  });
  it("resets cursors and expanded groups when switching to archive", async () => {
    state.search = {
      view: "arrivals",
      igCursor: "cursor",
      igGroups: '["a"]',
      igPages: '{"a":"page"}',
    };
    const view = await render();
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Архив")!
        .click(),
    );
    expect(state.search).toEqual({ view: "arrivals", igArchive: "archive" });
  });
  it("explains an unlinked candidate and renders no candidate action", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    state.personOverrides = {
      candidateId: null,
      needsAttention: true,
      issueCodes: ["unrecognised"],
    };
    const view = await render();
    expect(view.textContent).toContain(
      "Обратитесь к ответственному за привязку кандидатов",
    );
    expect(view.textContent).toContain("Требует уточнения");
    expect(view.textContent).not.toContain("unrecognised");
    expect(
      [...view.querySelectorAll("button")].some(
        (button) => button.textContent === "Алиев",
      ),
    ).toBe(false);
  });
  it("allows retry of a failed group independently", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    state.personError = true;
    const view = await render();
    expect(view.textContent).toContain("Не удалось загрузить участников");
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Повторить")!
        .click(),
    );
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it("passes the selected historical participation when opening its profile", async () => {
    state.search = {
      view: "arrivals",
      igArchive: "archive",
      igGroups: '["a"]',
    };
    state.personOverrides = { participationStatus: "HISTORICAL" };
    const view = await render();
    expect(view.textContent).toContain("Статусы текущего профиля");
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Алиев")!
        .click(),
    );
    expect(state.select).toHaveBeenCalledWith("a", {
      memberUid: "a",
      date: "2026-11-10",
      location: "Склад",
      status: "HISTORICAL",
    });
  });
  it("debounces the person search before updating the URL", async () => {
    vi.useFakeTimers();
    try {
      const view = await render();
      const input = view.querySelector(
        'input[type="search"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setter.call(input, "Ал");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
        setter.call(input, "Алиев");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(state.search.igQ).toBeUndefined();
      await act(async () => vi.advanceTimersByTime(349));
      expect(state.search.igQ).toBeUndefined();
      await act(async () => vi.advanceTimersByTime(1));
      expect(state.search.igQ).toBe("Алиев");
    } finally {
      vi.useRealTimers();
    }
  });
  it("resolves a selected object name from its URL even outside the options page", async () => {
    state.search = { view: "arrivals", igLocationUid: "selected" };
    const view = await render();
    expect(
      (view.querySelector('[aria-label="Объект"]') as HTMLInputElement).value,
    ).toBe("Склад Восток");
    expect(state.groupCalls).toContainEqual(
      expect.objectContaining({ locationUid: "selected" }),
    );
  });
  it("restores several open groups and displays independent statuses without document upload", async () => {
    state.search = {
      view: "arrivals",
      igDates: '["2026-11-10"]',
      igGroups: '["a","b"]',
      igArchive: "archive",
    };
    const view = await render();
    expect(view.textContent).toContain("Алиев");
    expect(view.textContent).toContain("Каримов");
    expect(view.textContent).toContain("Возвращены");
    expect(view.textContent).toContain("Ожидает отправки");
    expect(view.textContent).toContain("Неизвестно");
    expect(view.textContent).not.toContain("Загрузить документы");
    expect(state.personCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupKey: "a", archive: "archive" }),
        expect.objectContaining({ groupKey: "b", archive: "archive" }),
      ]),
    );
  });
});
