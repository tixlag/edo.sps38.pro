import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IgArrivalReviewQueue } from "./IgArrivalReviewQueue";
import type {
  IgArrivalGroupDto,
  IgArrivalPersonDto,
} from "@edo/api-client";

const mockState = vi.hoisted(() => ({
  permissions: { "20011": [] } as Record<string, unknown>,
  groupsQuery: vi.fn(),
  peopleQuery: vi.fn(),
  groupsData: {
    items: [] as IgArrivalGroupDto[],
    nextOffset: null as number | null,
  },
  peopleData: {
    items: [] as IgArrivalPersonDto[],
    nextOffset: null as number | null,
  },
  isLoadingGroups: false,
  isLoadingPeople: false,
  isErrorGroups: false,
  isErrorPeople: false,
}));

vi.mock("@edo/api-client", () => ({
  getListIgArrivalGroupsQueryKey: (params: unknown) => [
    "ig-arrival-groups",
    params,
  ],
  getListIgArrivalPeopleQueryKey: (params: unknown) => [
    "ig-arrival-people",
    params,
  ],
  useGetMe: () => ({
    data: { permissions: mockState.permissions },
    isLoading: false,
  }),
  useListIgArrivalGroups: (...args: unknown[]) => {
    mockState.groupsQuery(...args);
    return {
      data: mockState.groupsData,
      isLoading: mockState.isLoadingGroups,
      isFetching: false,
      isError: mockState.isErrorGroups,
      refetch: vi.fn(),
    };
  },
  useListIgArrivalPeople: (...args: unknown[]) => {
    mockState.peopleQuery(...args);
    return {
      data: mockState.peopleData,
      isLoading: mockState.isLoadingPeople,
      isFetching: false,
      isError: mockState.isErrorPeople,
      refetch: vi.fn(),
    };
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderComponent(onSelectCandidate = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <IgArrivalReviewQueue onSelectCandidate={onSelectCandidate} />,
    ),
  );
  return { container, onSelectCandidate };
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
  mockState.permissions = { "20011": [] };
  mockState.groupsData = { items: [], nextOffset: null };
  mockState.peopleData = { items: [], nextOffset: null };
  mockState.isLoadingGroups = false;
  mockState.isLoadingPeople = false;
  mockState.isErrorGroups = false;
  mockState.isErrorPeople = false;
});

describe("IgArrivalReviewQueue", () => {
  it("renders arrival groups and metrics breakdown", async () => {
    mockState.groupsData = {
      items: [
        {
          group: "assigned",
          arrivalDate: "2026-11-10",
          locationUid: "loc-warehouse-1",
          locationName: "Склад №1",
          total: 12,
          approved: 8,
          confirmed: 6,
          issues: 0,
          waitingDocuments: 3,
          inReview: 2,
          returned: 1,
          completed: 5,
          sending: 1,
          needsAttention: 1,
        },
        {
          group: "issues",
          arrivalDate: null,
          locationUid: null,
          locationName: null,
          total: 2,
          approved: 0,
          confirmed: 0,
          issues: 2,
          waitingDocuments: 0,
          inReview: 0,
          returned: 1,
          completed: 0,
          sending: 0,
          needsAttention: 2,
        },
      ],
      nextOffset: null,
    };

    const { container: view } = await renderComponent();

    // Check date and object header
    expect(view.textContent).toContain("Заезд: 10.11.2026");
    expect(view.textContent).toContain("Склад №1");
    expect(view.textContent).toContain("Всего человек: 12");

    // Check metric badges for assigned group
    expect(view.textContent).toContain("Ожидают: 3");
    expect(view.textContent).toContain("На проверке: 2");
    expect(view.textContent).toContain("Возвращены: 1");
    expect(view.textContent).toContain("Подтверждены: 6");
    expect(view.textContent).toContain("Отправка в ERP: 1");
    expect(view.textContent).toContain("Оформлены: 5");

    // Check separate issues section
    expect(view.textContent).toContain(
      "Проблемные и нераспределённые записи (1)",
    );
    expect(view.textContent).toContain("Всего записей");
    expect(view.textContent).toContain("Требуют внимания");
  });

  it("loads participants when clicking an arrival group", async () => {
    mockState.groupsData = {
      items: [
        {
          group: "assigned",
          arrivalDate: "2026-11-10",
          locationUid: "loc-warehouse-1",
          locationName: "Склад №1",
          total: 1,
          approved: 1,
          confirmed: 1,
          issues: 0,
          waitingDocuments: 0,
          inReview: 0,
          returned: 0,
          completed: 1,
          sending: 0,
          needsAttention: 0,
        },
      ],
      nextOffset: null,
    };

    mockState.peopleData = {
      items: [
        {
          personUid: "p-1",
          code1c: "1C-0099",
          candidateId: "cand-1",
          fullName: "Алиев Рустам",
          arrivalMemberUid: "mem-1",
          state: "CURRENT",
          approvedDocuments: 3,
          confirmedDocuments: 3,
          employmentConfirmed: true,
          primaryStatus: "completed",
          needsAttention: false,
          issueCode: null,
        },
      ],
      nextOffset: null,
    };

    const { container: view } = await renderComponent();

    // Find and click the button to open participants
    const openBtn = [...view.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Список участников (1)"),
    );
    expect(openBtn).toBeDefined();

    await act(async () => openBtn!.click());

    // Verify useListIgArrivalPeople was called with matching parameters
    expect(mockState.peopleQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "assigned",
        arrivalDate: "2026-11-10",
        locationUid: "loc-warehouse-1",
      }),
      expect.anything(),
    );

    // Verify participant row rendering
    expect(view.textContent).toContain("Алиев Рустам");
    expect(view.textContent).toContain("1C-0099");
    expect(view.textContent).toContain("Оформлен");
    expect(view.textContent).toContain("Подтверждено: 3 / 3 одобрено");
    expect(view.textContent).toContain("Трудоустройство подтверждено");
  });

  it("strictly does NOT render any 'Загрузить документы' button in the operator view", async () => {
    mockState.groupsData = {
      items: [
        {
          group: "assigned",
          arrivalDate: "2026-11-10",
          locationUid: "loc-warehouse-1",
          locationName: "Склад №1",
          total: 1,
          approved: 0,
          confirmed: 0,
          issues: 0,
          waitingDocuments: 1,
          inReview: 0,
          returned: 0,
          completed: 0,
          sending: 0,
          needsAttention: 0,
        },
      ],
      nextOffset: null,
    };

    mockState.peopleData = {
      items: [
        {
          personUid: "p-2",
          code1c: "1C-0100",
          candidateId: "cand-2",
          fullName: "Бакиров Фарух",
          arrivalMemberUid: "mem-2",
          state: "CURRENT",
          approvedDocuments: 0,
          confirmedDocuments: 0,
          employmentConfirmed: false,
          primaryStatus: "waitingDocuments",
          needsAttention: false,
          issueCode: null,
        },
      ],
      nextOffset: null,
    };

    const { container: view } = await renderComponent();

    // Open group
    const openBtn = [...view.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Список участников"),
    );
    await act(async () => openBtn!.click());

    // Verify participant has waitingDocuments status
    expect(view.textContent).toContain("Бакиров Фарух");
    expect(view.textContent).toContain("Ожидание документов");

    // Strictly ensure no button contains "Загрузить документы" or "Загрузить"
    expect(view.textContent).not.toContain("Загрузить документы");
    const allButtons = [...view.querySelectorAll("button")];
    const uploadBtn = allButtons.find((btn) =>
      /загрузить/i.test(btn.textContent ?? ""),
    );
    expect(uploadBtn).toBeUndefined();
  });

  it("calls onSelectCandidate when clicking a participant card / action", async () => {
    mockState.groupsData = {
      items: [
        {
          group: "assigned",
          arrivalDate: "2026-11-10",
          locationUid: "loc-warehouse-1",
          locationName: "Склад №1",
          total: 1,
          approved: 1,
          confirmed: 0,
          issues: 0,
          waitingDocuments: 0,
          inReview: 1,
          returned: 0,
          completed: 0,
          sending: 0,
          needsAttention: 0,
        },
      ],
      nextOffset: null,
    };

    mockState.peopleData = {
      items: [
        {
          personUid: "p-3",
          code1c: "1C-0101",
          candidateId: "target-candidate-42",
          fullName: "Каримов Даврон",
          arrivalMemberUid: "mem-3",
          state: "CURRENT",
          approvedDocuments: 1,
          confirmedDocuments: 0,
          employmentConfirmed: false,
          primaryStatus: "inReview",
          needsAttention: false,
          issueCode: null,
        },
      ],
      nextOffset: null,
    };

    const onSelectCandidate = vi.fn();
    const { container: view } = await renderComponent(onSelectCandidate);

    // Open group
    const openBtn = [...view.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Список участников"),
    );
    await act(async () => openBtn!.click());

    // Click "Карточка" button
    const cardBtn = [...view.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Карточка"),
    );
    expect(cardBtn).toBeDefined();

    await act(async () => cardBtn!.click());

    expect(onSelectCandidate).toHaveBeenCalledWith("target-candidate-42");
  });

  it("returns back to all arrival groups when clicking 'Ко всем заездам'", async () => {
    mockState.groupsData = {
      items: [
        {
          group: "assigned",
          arrivalDate: "2026-11-10",
          locationUid: "loc-warehouse-1",
          locationName: "Склад №1",
          total: 5,
          approved: 2,
          confirmed: 1,
          issues: 0,
          waitingDocuments: 1,
          inReview: 1,
          returned: 0,
          completed: 1,
          sending: 0,
          needsAttention: 0,
        },
      ],
      nextOffset: null,
    };

    const { container: view } = await renderComponent();

    // Open group
    const openBtn = [...view.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Список участников"),
    );
    await act(async () => openBtn!.click());

    expect(view.textContent).toContain("Склад №1");
    expect(view.textContent).toContain("Заезд от 10.11.2026");

    // Click back button
    const backBtn = [...view.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Ко всем заездам"),
    );
    expect(backBtn).toBeDefined();
    await act(async () => backBtn!.click());

    // Verified back in group view
    expect(view.textContent).toContain("Заезды по датам и объектам");
    expect(view.textContent).toContain("Всего человек: 5");
  });

  it("blocks access when principal lacks 20011 or 20009", async () => {
    // Principal has only 20002 (RU review)
    mockState.permissions = { "20002": [] };

    const { container: view } = await renderComponent();

    expect(view.textContent).toContain(
      "Нет доступа к проверке документов иностранных граждан",
    );
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
    // Query must not run
    expect(mockState.groupsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: expect.objectContaining({ enabled: false }),
      }),
    );
  });
});
