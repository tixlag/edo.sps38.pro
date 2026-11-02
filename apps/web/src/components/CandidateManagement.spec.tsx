import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CandidateManagement } from "./CandidateManagement";
import { CandidatesPage } from "../pages/CandidatesPage";
import { CandidateRequirements } from "./CandidateRequirements";

const state = vi.hoisted(() => ({
  permissions: { "20002": [] } as Record<string, unknown>,
  profile: {
    id: "current-cycle",
    reviewGroup: "RU",
    fullName: "Иванов Иван",
    phone: "+79000000000",
    birthDate: "1990-02-03",
    citizenship: "ru",
    position: { code: "position-secret", name: "Водитель" },
    project: null,
    manager: { id: "manager-secret", name: "Анна Менеджер" },
    mentor: { name: "Пётр Наставник", position: "Мастер" },
    status: { id: "recruiting", name: "Подбор" },
    linkedPerson: false,
    hasChat: true,
    history: [
      {
        date: "2026-10-26T01:00:00Z",
        author: "Менеджер",
        statusId: "recruiting",
        statusName: "Подбор",
        comment: "Проверен телефон",
      },
    ],
  },
  create: vi.fn(),
  update: vi.fn(),
  status: vi.fn(),
  link: vi.fn(),
  recheck: vi.fn(),
  navigate: vi.fn(),
  invalidate: vi.fn(),
  setData: vi.fn(),
  persons: vi.fn(),
  previous: [] as unknown[],
  workspaceError: null as unknown,
  managersUnavailable: false,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: state.invalidate,
    setQueryData: state.setData,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useSearch: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@edo/api-client", () => {
  const result = (items: unknown[]) => ({
    data: { items },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  const mutation = (callback: unknown) => ({
    mutateAsync: callback,
    isPending: false,
  });
  return {
    useGetMe: () => ({ data: { permissions: state.permissions } }),
    useGetCandidateWorkspace: () =>
      state.workspaceError
        ? { isError: true, error: state.workspaceError }
        : { data: state.profile },
    useListCandidateManagers: () =>
      state.managersUnavailable
        ? { isError: true, isLoading: false, refetch: vi.fn() }
        : result([{ id: "manager-secret", name: "Анна Менеджер" }]),
    useListCatalogManagers: () =>
      result([
        { id: "manager-secret", name: "Анна Менеджер" },
        { id: "other", name: "Борис" },
      ]),
    getListCatalogManagersQueryKey: () => ["catalog-managers"],
    useListPositions: () => result([]),
    useListCatalogMentors: () => result([]),
    useListCandidatePositions: () =>
      result([{ id: "pos", code: "position-secret", name: "Водитель" }]),
    useListCandidateProjects: () =>
      result([
        { id: "project", code: "project-secret", name: "Северный объект" },
      ]),
    useListCandidateStatuses: () =>
      result([
        { id: "recruiting", name: "Подбор", editable: true },
        { id: "potential", name: "Потенциальный", editable: true },
        {
          id: "arrival-plan",
          name: "План на заезд",
          editable: true,
          requiresProject: true,
          requiresPlannedArrivalDate: true,
        },
        { id: "arrived", name: "Заезд подтвержден", editable: false },
      ]),
    useSearchCandidatePersons: (params: unknown, options: unknown) => {
      state.persons(params, options);
      return result([
        {
          id: "signed-opaque-person",
          name: "Иванов Иван",
          birthDate: "1990-02-03",
        },
        { id: "another-person", name: "Иванов Иван", birthDate: "1980-06-07" },
      ]);
    },
    useListCommunicationCandidates: () => result([]),
    useListCandidatePreviousDocuments: () => result(state.previous),
    useGetCandidateRequirements: () =>
      result([
        { code: "passport", title: "Паспорт", documentUid: "passport-uid" },
        {
          code: "license",
          title: "Водительское удостоверение",
          documentUid: "license-uid",
        },
      ]),
    useCreateCandidate: () => mutation(state.create),
    useUpdateCandidateWorkspace: () => mutation(state.update),
    useChangeCandidateStatus: () => mutation(state.status),
    useLinkCandidatePerson: () => mutation(state.link),
    useRecheckCandidatePreviousDocument: () => mutation(state.recheck),
    getGetCandidateDetailsQueryKey: (id: string) => ["details", id],
    getGetCandidateWorkspaceQueryKey: (id: string) => ["workspace", id],
    getListCommunicationCandidatesQueryKey: () => ["catalog"],
    getListCandidateReviewQueueQueryKey: () => ["queue"],
    getGetCandidateRequirementsQueryKey: (id: string) => ["requirements", id],
    getListCandidatePreviousDocumentsQueryKey: (id: string) => ["previous", id],
    getCandidatePreviousDocumentOriginal: vi.fn(),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let view: HTMLDivElement;
async function render(children: ReactNode) {
  view = document.createElement("div");
  document.body.append(view);
  root = createRoot(view);
  await act(async () => root.render(children));
}
function button(text: string) {
  return [...view.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function select(input: HTMLSelectElement, value: string) {
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function pick(label: string, text: string) {
  const input = view.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  await act(async () =>
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
  );
  const option = [...view.querySelectorAll('[role="option"]')].find(
    (node) => node.textContent === text,
  )!;
  await act(async () =>
    option.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}
async function submit(form: string) {
  await act(async () =>
    view
      .querySelector(`form[aria-label="${form}"]`)!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = { "20002": [] };
  state.profile.linkedPerson = false;
  state.previous = [];
  state.workspaceError = null;
  state.managersUnavailable = false;
  for (const mutation of [state.create, state.update, state.status, state.link])
    mutation.mockResolvedValue(state.profile);
  state.recheck.mockResolvedValue({ items: [] });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  view?.remove();
  vi.useRealTimers();
});

describe("candidate manager flows", () => {
  it("uses known ERP manager IDs when the ERP manager directory is unavailable", async () => {
    state.managersUnavailable = true;
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    expect(view.textContent).toContain(
      "Менеджеры из ранее загруженных кандидатов",
    );
    const form = view.querySelector("form")!;
    const inputs = form.querySelectorAll<HTMLInputElement>(
      "fieldset > label > input",
    );
    expect(inputs[3].value).toBe("ru");
    const uzChip = [...view.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Узбекистан (uz)"),
    );
    expect(uzChip).toBeDefined();
    await act(async () => uzChip!.click());
    expect(inputs[3].value).toBe("uz");
    type(inputs[3], "ru");
    type(inputs[0], "Иванов Иван");
    type(inputs[1], "+79000000000");
    type(inputs[2], "1990-02-03");
    await pick("Должность", "Водитель");
    const managerInput = view.querySelector<HTMLInputElement>(
      'input[aria-label="Менеджер"]',
    )!;
    await act(async () =>
      managerInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
    );
    type(managerInput, "анна");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(view.textContent).toContain("Анна Менеджер");
    expect(view.textContent).not.toContain("Борис");
    await pick("Менеджер", "Анна Менеджер");
    await submit("Создание кандидата");
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fields: expect.objectContaining({ managerId: "manager-secret" }),
        }),
      }),
    );
  });
  it("explains when an ERP candidate link has not been confirmed", async () => {
    state.workspaceError = {
      response: {
        status: 409,
        data: { message: "ERP_CANDIDATE_CONFIRMATION_REQUIRED" },
      },
    };
    await render(<CandidateManagement candidateId="unlinked" />);
    expect(view.textContent).toContain(
      "Нет подтверждённой связи с кандидатом в 1С",
    );
    expect(view.textContent).not.toContain("Повторить");
  });
  it("creates in ERP without a required object and retains request/body after an uncertain response", async () => {
    state.create.mockRejectedValueOnce(new Error("Lost response"));
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    const form = view.querySelector("form")!;
    const inputs = form.querySelectorAll<HTMLInputElement>(
      "fieldset > label > input",
    );
    expect(inputs[3].value).toBe("ru");
    const uzChip = [...view.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Узбекистан (uz)"),
    );
    expect(uzChip).toBeDefined();
    await act(async () => uzChip!.click());
    expect(inputs[3].value).toBe("uz");
    type(inputs[3], "ru");
    type(inputs[0], "Иванов Иван");
    type(inputs[1], "+79000000000");
    type(inputs[2], "1990-02-03");
    await pick("Должность", "Водитель");
    await pick("Менеджер", "Анна Менеджер");
    await submit("Создание кандидата");
    expect(state.create).toHaveBeenCalledWith({
      data: {
        requestId: expect.any(String),
        fields: {
          fullName: "Иванов Иван",
          phone: "+79000000000",
          birthDate: "1990-02-03",
          citizenship: "ru",
          positionCode: "position-secret",
          managerId: "manager-secret",
          projectCode: null,
        },
      },
    });
    expect(form.querySelector("fieldset")!.disabled).toBe(true);
    await submit("Создание кандидата");
    expect(state.create.mock.calls[0][0]).toEqual(
      state.create.mock.calls[1][0],
    );
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { candidateId: "current-cycle" } }),
    );
  });

  it("confirms an existing physical person when creating a new admission and reuses that signed choice after a lost response", async () => {
    state.create.mockRejectedValueOnce(new Error("Lost response"));
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    const form = view.querySelector("form")!;
    const inputs = form.querySelectorAll<HTMLInputElement>(
      "fieldset > label > input",
    );
    expect(inputs[3].value).toBe("ru");
    const uzChip = [...view.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Узбекистан (uz)"),
    );
    expect(uzChip).toBeDefined();
    await act(async () => uzChip!.click());
    expect(inputs[3].value).toBe("uz");
    type(inputs[3], "ru");
    type(inputs[0], "Иванов Иван");
    type(inputs[1], "+79000000000");
    type(inputs[2], "1990-02-03");
    await pick("Должность", "Водитель");
    await pick("Менеджер", "Анна Менеджер");
    await act(async () =>
      view
        .querySelector<HTMLInputElement>(
          '[aria-label="Повторный приём при создании"]',
        )!
        .click(),
    );
    await submit("Создание кандидата");
    expect(state.create).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const searchInput = view.querySelector<HTMLInputElement>(
      'input[aria-label="Поиск физлица"]',
    )!;
    await act(async () =>
      searchInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
    );
    type(searchInput, "Иван");
    await act(async () => vi.advanceTimersByTime(301));
    await pick("Поиск физлица", "Иванов Иван · 03.02.1990");
    await submit("Создание кандидата");
    expect(state.create).not.toHaveBeenCalled();
    expect(view.textContent).toContain("03.02.1990");
    const confirmation = form.querySelector<HTMLInputElement>(
      'section input[type="checkbox"]:not([aria-label])',
    )!;
    await act(async () => confirmation.click());
    await submit("Создание кандидата");
    expect(state.create).toHaveBeenCalledWith({
      data: {
        requestId: expect.any(String),
        fields: expect.objectContaining({
          fullName: "Иванов Иван",
          projectCode: null,
        }),
        personSelection: "signed-opaque-person",
      },
    });
    expect(confirmation.disabled).toBe(true);
    expect(searchInput.disabled).toBe(true);
    expect(
      form.querySelector<HTMLInputElement>(
        '[aria-label="Повторный приём при создании"]',
      )!.disabled,
    ).toBe(true);
    expect(button("Отмена").disabled).toBe(true);
    expect(view.textContent).not.toContain("signed-opaque-person");
    await submit("Создание кандидата");
    expect(state.create.mock.calls[1][0]).toEqual(
      state.create.mock.calls[0][0],
    );
  });

  it("patches changed fields only, keeps mentor read-only and refreshes requirements", async () => {
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    expect(view.textContent).toContain("Пётр Наставник");
    expect(view.querySelector('input[name="mentor"]')).toBeNull();
    type(view.querySelector('input[type="tel"]')!, "+79001112233");
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith({
      candidateId: "current-cycle",
      data: {
        requestId: expect.any(String),
        fields: { phone: "+79001112233" },
      },
    });
    expect(state.invalidate).toHaveBeenCalledWith({
      queryKey: ["requirements", "current-cycle"],
    });
    expect(view.textContent).not.toContain("manager-secret");
  });

  it("uses all ERP statuses, respects noneditable results, and requests plan fields only at that transition", async () => {
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.querySelector("dl")).not.toBeNull();
    await click("Изменить статус");
    expect(view.querySelector("dl")).toBeNull();
    const status = view.querySelector<HTMLSelectElement>("form select")!;
    const optgroups = [...status.querySelectorAll("optgroup")].map(
      (group) => group.label,
    );
    expect(optgroups).toEqual(["Подбор и скрининг", "Заезд и оформление"]);
    expect(
      status.querySelector<HTMLOptionElement>('option[value="arrived"]')!
        .disabled,
    ).toBe(true);
    select(status, "potential");
    expect(view.querySelector('input[type="date"]')).toBeNull();
    await submit("Изменение статуса");
    expect(state.status).toHaveBeenCalledWith({
      candidateId: "current-cycle",
      data: { requestId: expect.any(String), statusId: "potential" },
    });
    expect(view.querySelector("dl")).not.toBeNull();
    await click("Изменить статус");
    expect(view.querySelector("dl")).toBeNull();
    select(view.querySelector("form select")!, "arrival-plan");
    expect(
      view.querySelector<HTMLInputElement>('input[type="date"]')!.required,
    ).toBe(true);
    expect(button("Сохранить статус").disabled).toBe(true);
    await click("Отмена");
    expect(view.querySelector("dl")).not.toBeNull();
  });

  it.each([false, true])(
    "requires explicit current-cycle confirmation even when ERP already reports a linked person (%s)",
    async (alreadyLinked) => {
      state.profile.linkedPerson = alreadyLinked;
      await render(<CandidateManagement candidateId="current-cycle" />);
      await click(
        alreadyLinked ? "Подтвердить связь с физлицом" : "Повторный приём",
      );
      expect(view.querySelector("dl")).toBeNull();
      expect(view.textContent).toContain("Кадровый приём выполняется в ERP");
      expect(state.persons.mock.calls.at(-1)?.[1]).toEqual(
        expect.objectContaining({
          query: expect.objectContaining({ enabled: false }),
        }),
      );
      vi.useFakeTimers();
      const searchInput = view.querySelector<HTMLInputElement>(
        'input[aria-label="Поиск физлица"]',
      )!;
      await act(async () =>
        searchInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
      );
      type(searchInput, "Иван");
      await act(async () => vi.advanceTimersByTime(301));
      await pick("Поиск физлица", "Иванов Иван · 03.02.1990");
      expect(view.textContent).toContain("03.02.1990");
      expect(button("Связать с текущим кандидатом").disabled).toBe(true);
      await act(async () =>
        view.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
      );
      await submit(
        alreadyLinked ? "Подтверждение связи с физлицом" : "Повторный приём",
      );
      expect(state.link).toHaveBeenCalledWith({
        candidateId: "current-cycle",
        data: {
          requestId: expect.any(String),
          personSelection: "signed-opaque-person",
        },
      });
      expect(view.textContent).not.toContain("signed-opaque-person");
    },
  );

  it("shows old documents as requiring review and explicitly saves current-cycle recheck", async () => {
    state.profile.linkedPerson = true;
    state.previous = [
      {
        id: "old-document",
        documentUid: "hidden-erp-uid",
        title: "Паспорт",
        fields: {
          number: "123456",
          code1c: "hidden-person-code",
          departmentCode: "770-001",
          subdivisionCode: "770-002",
          gender: "Мужской",
          citizenship: "РФ",
        },
        expiresAt: "2028-01-01",
        originalAvailable: false,
        status: "REQUIRES_REVIEW",
        reviewedAt: null,
      },
    ];
    state.recheck.mockResolvedValue({ items: state.previous });
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("Требует повторной проверки");
    expect(view.textContent).toContain("123456");
    expect(view.textContent).not.toContain("hidden-person-code");
    expect(view.textContent).toContain("Код подразделения");
    expect(view.textContent).toContain("770-001");
    expect(view.textContent).toContain("770-002");
    expect(view.textContent).toContain("Пол");
    expect(view.textContent).toContain("Мужской");
    expect(view.textContent).toContain("Гражданство");
    expect(view.textContent).not.toContain("departmentCode");
    expect(view.textContent).not.toContain("subdivisionCode");
    expect(button("Оригинал недоступен").disabled).toBe(true);
    const recheckForm = view.querySelector("form")!;
    expect(recheckForm.className).toContain("flex-col gap-2 sm:flex-row sm:items-end");
    select(view.querySelector("select")!, "REPLACE");
    await act(async () =>
      view
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(state.recheck).toHaveBeenCalledWith({
      candidateId: "current-cycle",
      documentId: "old-document",
      data: { status: "REPLACE" },
    });
  });

  it("lists newly required missing documents and does not infer approval from an old file", async () => {
    await render(
      <CandidateRequirements candidateId="current-cycle" documents={[]} />,
    );
    expect(view.textContent).toContain("Паспорт");
    expect(view.textContent).toContain("Водительское удостоверение");
    expect(view.textContent).toContain("Не загружены");
  });

  it("does not expose RU creation or recruitment tools to an IG-only user", async () => {
    state.permissions = { "20011": [] };
    await render(<CandidatesPage />);
    expect(view.textContent).toContain("Нет доступа");
    expect(view.querySelector("form")).toBeNull();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("structures candidate fields into personal and ERP cards with phone mask and actions toolbar", async () => {
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("Личные данные");
    expect(view.textContent).toContain("Назначение ERP");
    expect(view.textContent).toContain("+7 (900) 000-00-00");
    const telLink = view.querySelector<HTMLAnchorElement>(
      'a[href="tel:+79000000000"]',
    );
    expect(telLink).not.toBeNull();
    const copyButton = view.querySelector<HTMLButtonElement>(
      'button[aria-label="Скопировать телефон"]',
    );
    expect(copyButton).not.toBeNull();
    expect(button("Изменить статус")).toBeDefined();
    expect(button("Редактировать данные")).toBeDefined();
    expect(view.textContent).toContain("ERP");
  });
});
