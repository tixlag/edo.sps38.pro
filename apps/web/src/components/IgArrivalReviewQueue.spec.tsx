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
  groupNext: null as string | null,
  personNext: null as string | null,
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
        nextCursor: state.groupNext,
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
      data: state.personError
        ? undefined
        : {
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
                requirements: {
                  known: true,
                  required: 4,
                  present: 3,
                  accepted: 2,
                  review: 1,
                  returned: 1,
                  missing: 1,
                  processing: 0,
                  completed: false,
                  nextAction: "REVIEW",
                },
                deliveryNeedsAttention: false,
                reviewAvailable: 1,
                action: "REVIEW",
                ...state.personOverrides,
              },
            ],
            nextCursor: state.personNext,
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
  state.groupNext = null;
  state.personNext = null;
  state.refetch.mockClear();
  state.select.mockClear();
  state.invalidate.mockClear();
});
describe("arrival registry", () => {
  it("shows the archive default period and lets the operator select all dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 12));
    try {
      state.search = { view: "arrivals", igArchive: "archive" };
      const view = await render();
      expect(state.groupCalls).toContainEqual(
        expect.objectContaining({
          dateFrom: "2026-10-10",
          dateTo: "2026-11-09",
        }),
      );
      expect(
        (view.querySelector('input[type="date"]') as HTMLInputElement).value,
      ).toBe("2026-10-10");
      await act(async () =>
        [...view.querySelectorAll("button")]
          .find((button) => button.textContent === "Все даты")!
          .click(),
      );
      expect(state.search.igPeriod).toBe("all");
    } finally {
      vi.useRealTimers();
    }
  });
  it("drops an old all-dates cursor when a legacy archive URL gains the default period", async () => {
    state.search = {
      view: "arrivals",
      igArchive: "archive",
      igCursor: "old-cursor",
      igPages: '{"a":"old-page"}',
    };
    await render();
    expect(state.search.igCursor).toBeUndefined();
    expect(state.search.igPages).toBeUndefined();
  });
  it("records each current cursor when advancing group and participant pages", async () => {
    state.search = {
      view: "arrivals",
      igCursor: "group-1",
      igGroups: '["a"]',
      igPages: '{"a":"person-1"}',
      igPageStacks: '{"a":[""]}',
      igGroupStack: '[""]',
    };
    state.groupNext = "group-2";
    state.personNext = "person-2";
    const view = await render();
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Следующие участники")!
        .click(),
    );
    expect(state.search.igPages).toBe('{"a":"person-2"}');
    expect(state.search.igPageStacks).toBe('{"a":["","person-1"]}');
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Следующие объекты")!
        .click(),
    );
    expect(state.search.igCursor).toBe("group-2");
    expect(state.search.igGroupStack).toBe('["","group-1"]');
  });
  it("returns to the immediately previous group and participant pages", async () => {
    state.search = {
      view: "arrivals",
      igCursor: "g2",
      igGroupStack: '["","g1"]',
      igGroups: '["a"]',
      igPages: '{"a":"p2"}',
      igPageStacks: '{"a":["","p1"]}',
    };
    const view = await render();
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Назад к участникам")!
        .click(),
    );
    expect(state.search.igPages).toBe('{"a":"p1"}');
    expect(state.search.igPageStacks).toBe('{"a":[""]}');
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Назад к объектам")!
        .click(),
    );
    expect(state.search.igCursor).toBe("g1");
    expect(state.search.igGroupStack).toBe('[""]');
  });
  it("renders four HR columns and one review action from server requirements", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    const view = await render();
    expect(
      [...view.querySelectorAll("thead th")].map((th) => th.textContent),
    ).toEqual(["Сотрудник", "Документы", "Что требуется", "Действие"]);
    expect(view.textContent).toContain("2 из 4");
    expect(view.textContent).toContain("Проверить 1 документ");
    expect(view.textContent).not.toContain("00003465");
    expect(view.textContent).not.toContain("Доставка ERP");
    expect(
      view.querySelector('button[aria-label="Проверить: Алиев"]'),
    ).not.toBeNull();
    expect(view.querySelector('button[aria-label="Алиев"]')).toBeNull();
  });
  it("does not label an active conflicting participation as archived", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    state.personOverrides = {
      participationStatus: "ISSUE",
      personState: "CONFLICT",
      action: "OPEN_CARD",
    };
    const view = await render();
    expect(view.querySelector("tbody")?.textContent).not.toContain("Архив");
    expect(view.textContent).toContain("Требует уточнения");
    expect(
      view.querySelector('button[aria-label="Открыть карточку: Алиев"]'),
    ).not.toBeNull();
  });
  it("describes one missing document grammatically", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    state.personOverrides = {
      requirements: {
        known: true,
        required: 4,
        present: 3,
        accepted: 3,
        review: 0,
        returned: 0,
        missing: 1,
        processing: 0,
        completed: false,
        nextAction: "MISSING",
      },
      action: "OPEN_CARD",
    };
    const view = await render();
    expect(view.textContent).toContain("Ожидается 1 документ");
  });
  it("sends the server-side requirements filter", async () => {
    state.search = {
      view: "arrivals",
      igGroups: '["a"]',
      igRequirementsAction: "MISSING",
    };
    await render();
    expect(state.groupCalls).toContainEqual(
      expect.objectContaining({ requirementsAction: "MISSING" }),
    );
    expect(state.personCalls).toContainEqual(
      expect.objectContaining({ groupKey: "a", requirementsAction: "MISSING" }),
    );
  });
  it("shows a delivery problem without hiding a review action", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    state.personOverrides = { deliveryNeedsAttention: true };
    const view = await render();
    expect(view.textContent).toContain(
      "Передача документов в 1С не подтверждена",
    );
    expect(
      view.querySelector('button[aria-label="Проверить: Алиев"]'),
    ).not.toBeNull();
  });
  it("keeps review actionable when requirements are unknown", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    state.personOverrides = {
      requirements: {
        known: false,
        required: null,
        present: null,
        accepted: null,
        review: null,
        returned: null,
        missing: null,
        processing: null,
        completed: null,
        nextAction: "REVIEW",
      },
      action: "REVIEW",
    };
    const view = await render();
    expect(view.textContent).toContain("Комплект не определён");
    expect(
      view.querySelector('button[aria-label="Проверить: Алиев"]'),
    ).not.toBeNull();
  });
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
    expect(view.textContent).toContain("Не удалось обновить реестр");
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
    expect(state.search).toEqual(
      expect.objectContaining({
        view: "arrivals",
        igArchive: "archive",
        igPeriod: "custom",
      }),
    );
    expect(state.search.igCursor).toBeUndefined();
    expect(state.search.igGroups).toBeUndefined();
  });
  it("explains an unlinked candidate and renders no candidate action", async () => {
    state.search = { view: "arrivals", igGroups: '["a"]' };
    state.personOverrides = {
      candidateId: null,
      action: "NONE",
      needsAttention: true,
      issueCodes: ["unrecognised"],
    };
    const view = await render();
    expect(view.textContent).toContain(
      "Обратитесь к ответственному за привязку кандидатов",
    );
    expect(view.textContent).toContain("Нет связанного профиля");
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
      igPeriod: "all",
      igGroups: '["a"]',
    };
    state.personOverrides = { participationStatus: "HISTORICAL" };
    const view = await render();
    expect(view.textContent).toContain("Исторический");
    await act(async () =>
      [...view.querySelectorAll("button")]
        .find(
          (button) => button.getAttribute("aria-label") === "Проверить: Алиев",
        )!
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
      igPeriod: "all",
    };
    const view = await render();
    expect(view.textContent).toContain("Алиев");
    expect(view.textContent).toContain("Каримов");
    expect(view.textContent).toContain("Возвращено: 1");
    expect(view.textContent).toContain("2 из 4");
    expect(view.textContent).not.toContain("Загрузить документы");
    expect(state.personCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupKey: "a", archive: "archive" }),
        expect.objectContaining({ groupKey: "b", archive: "archive" }),
      ]),
    );
  });
});
