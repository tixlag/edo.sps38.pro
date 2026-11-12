import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CandidateResponsibleDto,
  CandidateSourceCommentDto,
} from "@edo/api-client";
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
    birthDate: "1990-02-03" as string | null,
    person: null as {
      id: string;
      name: string;
      birthDate: string | null;
      code?: string;
    } | null,
    citizenship: "ru",
    position: { code: "position-secret", name: "Водитель" },
    project: null,
    manager: { id: "manager-secret", name: "Анна Менеджер" },
    mentor: { name: "Пётр Наставник", position: "Мастер" },
    status: { id: "recruiting", name: "Подбор" },
    linkedPerson: false,
    responsible: null as CandidateResponsibleDto | null,
    sourceComment: null as CandidateSourceCommentDto | null,
    source: null as { id: string; name: string } | null,
    internship: false,
    internshipEndDate: null as string | null,
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
  open: vi.fn(),
  operation: vi.fn(),
  candidateMatches: [] as Array<{
    id: string;
    name: string;
    birthDate: string | null;
    selection: string;
    matchedPhone: boolean;
  }>,
  update: vi.fn(),
  status: vi.fn(),
  link: vi.fn(),
  recheck: vi.fn(),
  navigate: vi.fn(),
  invalidate: vi.fn(),
  setData: vi.fn(),
  persons: vi.fn(),
  manualPersonToken: "signed-opaque-person",
  matches: vi.fn(),
  matchState: "ready" as "ready" | "loading" | "refreshing" | "error",
  retryMatches: vi.fn(),
  previous: [] as unknown[],
  edoDocuments: [] as unknown[],
  employmentHistory: undefined as unknown,
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
    useUploadCandidatePhoto: () => ({ mutate: vi.fn(), isPending: false }),
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
    useRequestCandidateEnrichmentBatch: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
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
          id: state.manualPersonToken,
          personUid: "same-person-uid",
          name: "Иванов Иван",
          birthDate: "1990-02-03",
        },
        { id: "another-person", name: "Иванов Иван", birthDate: "1980-06-07" },
      ]);
    },
    getSearchCandidatePersonsQueryKey: (params: unknown) => ["persons", params],
    useFindCandidatePersonMatches: (params: { birthDate: string }) => {
      state.matches(params);
      const matched = result(
        params.birthDate === "1990-02-03"
          ? [
              {
                id: "signed-opaque-person",
                personUid: "same-person-uid",
                name: "Иванов Иван",
                birthDate: "1990-02-03",
                matchedCyrillic: true,
              },
            ]
          : [],
      );
      return {
        ...matched,
        isLoading: state.matchState === "loading",
        isFetching:
          state.matchState === "loading" || state.matchState === "refreshing",
        isError: state.matchState === "error",
        error:
          state.matchState === "error"
            ? {
                response: {
                  status: 400,
                  data: { message: "INVALID_PERSON_MATCH_NAME" },
                },
              }
            : undefined,
        refetch: state.retryMatches,
        data:
          state.matchState === "error" || state.matchState === "loading"
            ? undefined
            : { ...matched.data, candidates: state.candidateMatches },
      };
    },
    getFindCandidatePersonMatchesQueryKey: (params: unknown) => [
      "person-matches",
      params,
    ],
    useListCommunicationCandidates: () => result([]),
    useListCandidatePreviousDocuments: () => ({
      ...result(state.previous),
      data: {
        items: state.previous,
        employmentHistory: state.employmentHistory,
        edoDocuments: state.edoDocuments,
      },
    }),
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
    useOpenExistingCandidate: () => mutation(state.open),
    useGetCandidateOperation: () => ({ refetch: state.operation }),
    getGetCandidateOperationQueryKey: (id: string) => ["operation", id],
    useListCandidateCountries: () => result([]),
    useListCandidateOrganizations: () => result([]),
    useListCandidateSources: () =>
      result([
        { id: "Другое", name: "Другое" },
        { id: "ПоРекомендации", name: "По рекомендации" },
      ]),
    useListCandidateResponsibles: () =>
      result([
        { kind: "person", id: "referrer-person", name: "Ирина Рекомендатель" },
      ]),
    useListCandidateContactTypes: () => result([]),
    useListCandidateContactKinds: () => result([]),
    useListCandidateUniversities: () => result([]),
    useUpdateCandidateWorkspace: () => mutation(state.update),
    useChangeCandidateStatus: () => mutation(state.status),
    useLinkCandidatePerson: () => mutation(state.link),
    getGetCandidateDetailsQueryKey: (id: string) => ["details", id],
    getGetCandidateWorkspaceQueryKey: (id: string) => ["workspace", id],
    getListCommunicationCandidatesQueryKey: () => ["catalog"],
    getListCandidateReviewQueueQueryKey: () => ["queue"],
    getListReviewDocumentsQueryKey: () => ["review-documents"],
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
  state.profile.birthDate = "1990-02-03";
  state.profile.person = null;
  state.profile.responsible = null;
  state.profile.sourceComment = null;
  state.profile.source = null;
  state.profile.internship = false;
  state.profile.internshipEndDate = null;
  state.manualPersonToken = "signed-opaque-person";
  state.matchState = "ready";
  state.candidateMatches = [];
  state.operation.mockResolvedValue({ data: { state: "NOT_FOUND" } });
  state.open.mockResolvedValue(state.profile);
  state.profile.history = [
    {
      date: "2026-10-26T01:00:00Z",
      author: "Менеджер",
      statusId: "recruiting",
      statusName: "Подбор",
      comment: "Проверен телефон",
    },
  ];
  state.previous = [];
  state.edoDocuments = [];
  state.employmentHistory = undefined;
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
  it("shows earlier EDO documents even without a linked person", async () => {
    state.profile.linkedPerson = false;
    state.edoDocuments = [
      {
        id: "old-document",
        title: "Прежний паспорт",
        currentVersion: 2,
        status: "APPROVED",
      },
    ];
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("Прежний паспорт");
    await click("Прежний паспорт");
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/review-ig/$documentId",
        params: { documentId: "old-document" },
      }),
    );
  });
  it("shows verified ERP employment events in the previous-document section", async () => {
    state.profile.linkedPerson = true;
    state.employmentHistory = {
      available: true,
      items: [
        { eventDate: "2020-01-01", startDate: "2020-01-05", eventType: "HIRE" },
        { eventDate: "2021-03-01", startDate: null, eventType: "DISMISSAL" },
      ],
    };
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("Кадровая история в ERP");
    expect(view.textContent).toContain("Приём · 05.01.2020");
    expect(view.textContent).toContain("Увольнение · 01.03.2021");
  });
  it("searches creation matches by name or phone without requiring date of birth", async () => {
    vi.useFakeTimers();
    state.candidateMatches = [
      {
        id: "completed-erp-uid",
        name: "Иванов Иван",
        birthDate: null,
        selection: "signed-candidate",
        matchedPhone: true,
      },
    ];
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    type(view.querySelector('input[type="tel"]')!, "+79000000000");
    await act(async () => vi.advanceTimersByTime(500));
    expect(state.matches).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: "creation",
        phone: "+79000000000",
        birthDate: undefined,
      }),
    );
    expect(view.textContent).toContain("Дата рождения не указана");
    await click("Открыть существующую карточку");
    expect(state.open).toHaveBeenCalledWith({
      data: { erpUid: "completed-erp-uid" },
    });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.status).not.toHaveBeenCalled();
  });
  it("selects a signed matching person directly and invalidates the choice after identity changes", async () => {
    vi.useFakeTimers();
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    const inputs = view.querySelectorAll<HTMLInputElement>(
      "fieldset > label > input",
    );
    type(inputs[0], "Иванов Иван");
    type(inputs[1], "+79000000000");
    type(inputs[2], "1990-02-03");
    await act(async () => vi.advanceTimersByTime(500));
    expect(view.textContent).toContain("Возможные физлица");
    await act(async () =>
      view.querySelector<HTMLInputElement>('input[type="radio"]')!.click(),
    );
    type(inputs[1], "+79000000001");
    await submit("Создание кандидата");
    expect(state.create).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(500));
    expect(
      view.querySelector<HTMLInputElement>('input[type="radio"]')!.checked,
    ).toBe(false);
    await act(async () =>
      view.querySelector<HTMLInputElement>('input[type="radio"]')!.click(),
    );
    await submit("Создание кандидата");
    expect(state.create).toHaveBeenCalledWith({
      data: {
        requestId: expect.any(String),
        fields: {
          fullName: "Иванов Иван",
          phone: "+79000000001",
          birthDate: "1990-02-03",
        },
        personSelection: "signed-opaque-person",
      },
    });
    expect(state.persons).not.toHaveBeenCalled();
  });
  it("waits for the current identity duplicate check and creates without a manual person search", async () => {
    vi.useFakeTimers();
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    const inputs = view.querySelectorAll<HTMLInputElement>(
      "fieldset > label > input",
    );
    type(inputs[0], "Иванов Иван");
    type(inputs[1], "+79000000000");
    type(inputs[2], "1991-02-03");
    const button = view.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    expect(button.disabled).toBe(true);
    await submit("Создание кандидата");
    expect(state.create).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("Найти физлицо вручную");
    await act(async () => vi.advanceTimersByTime(500));
    expect(button.disabled).toBe(false);
    await submit("Создание кандидата");
    expect(state.create).toHaveBeenCalledWith({
      data: {
        requestId: expect.any(String),
        fields: {
          fullName: "Иванов Иван",
          phone: "+79000000000",
          birthDate: "1991-02-03",
        },
      },
    });
    expect(state.persons).not.toHaveBeenCalled();
  });
  it.each(["loading", "refreshing", "error"] as const)(
    "blocks creation while automatic duplicate search is %s",
    async (status) => {
      vi.useFakeTimers();
      state.matchState = status;
      await render(<CandidatesPage />);
      await click("Создать кандидата");
      const inputs = view.querySelectorAll<HTMLInputElement>(
        "fieldset > label > input",
      );
      type(inputs[0], "Иванов Иван");
      type(inputs[1], "+79000000000");
      type(inputs[2], "1991-02-03");
      await act(async () => vi.advanceTimersByTime(500));
      expect(
        view.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled,
      ).toBe(true);
      await submit("Создание кандидата");
      expect(state.create).not.toHaveBeenCalled();
      if (status === "error") {
        expect(view.textContent).toContain("Не удалось проверить совпадения");
        await click("Повторить проверку");
        expect(state.retryMatches).toHaveBeenCalledTimes(1);
        state.matchState = "ready";
        await act(async () => root.render(<CandidatesPage />));
        await submit("Создание кандидата");
        expect(state.create).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("requires a nonblank comment for Other before sending the edit", async () => {
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    await pick("Источник", "Другое");
    await submit("Редактирование кандидата");
    expect(state.update).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Укажите комментарий к источнику");
    const comment = view.querySelector<HTMLInputElement>(
      'input[aria-label="Текст комментария к источнику"]',
    )!;
    type(comment, "   ");
    await submit("Редактирование кандидата");
    expect(state.update).not.toHaveBeenCalled();
    type(comment, "Обратился самостоятельно");
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fields: {
            sourceId: "Другое",
            sourceComment: { kind: "text", text: "Обратился самостоятельно" },
          },
        }),
      }),
    );
  });
  it("clears the old source comment and requires a selected referrer on recommendation", async () => {
    state.profile.source = { id: "Другое", name: "Другое" };
    state.profile.sourceComment = { kind: "text", text: "Старое пояснение" };
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    await pick("Источник", "По рекомендации");
    expect(
      view.querySelector('input[aria-label="Текст комментария к источнику"]'),
    ).toBeNull();
    expect(
      view.querySelector<HTMLInputElement>(
        'input[aria-label="Физлицо в источнике"]',
      )?.value,
    ).toBe("");
    await submit("Редактирование кандидата");
    expect(state.update).not.toHaveBeenCalled();
    expect(view.textContent).toContain(
      "Выберите физлицо, которое рекомендовало кандидата",
    );
    await pick("Физлицо в источнике", "Ирина Рекомендатель");
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fields: {
            sourceId: "ПоРекомендации",
            sourceComment: {
              kind: "person",
              id: "referrer-person",
              name: "Ирина Рекомендатель",
            },
          },
        }),
      }),
    );
  });
  it("requires the practice end date after enabling the student flag", async () => {
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    const flag = [...view.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Студент на практике"))!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => flag.click());
    await submit("Редактирование кандидата");
    expect(state.update).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Укажите дату окончания практики");
    const end = [...view.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Окончание практики"))!
      .querySelector<HTMLInputElement>("input")!;
    expect(end.required).toBe(true);
    type(end, "2026-12-31");
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fields: { internship: true, internshipEndDate: "2026-12-31" },
        }),
      }),
    );
  });
  it("allows an unrelated phone edit on a legacy card with incomplete source and practice", async () => {
    state.profile.source = { id: "ПоРекомендации", name: "По рекомендации" };
    state.profile.sourceComment = { kind: "text", text: "Прежнее описание" };
    state.profile.internship = true;
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    type(view.querySelector('input[type="tel"]')!, "+79001112233");
    expect(view.querySelector("form")!.checkValidity()).toBe(true);
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fields: { phone: "+79001112233" } }),
      }),
    );
  });
  it("retains typed source-person and responsible-user references during a sparse card edit", async () => {
    state.profile.sourceComment = {
      kind: "person",
      id: "source-person",
      name: "Координатор",
    };
    state.profile.responsible = {
      kind: "user",
      id: "responsible-user",
      name: "Ирина Ответственная",
    };
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    expect(
      view.querySelector<HTMLSelectElement>(
        '[aria-label="Тип комментария к источнику"]',
      )?.value,
    ).toBe("person");
    expect(
      view.querySelector<HTMLInputElement>(
        'input[aria-label="Физлицо в источнике"]',
      )?.value,
    ).toBe("Координатор");
    expect(
      view.querySelector<HTMLInputElement>('input[aria-label="Ответственный"]')
        ?.value,
    ).toBe("Ирина Ответственная");
    type(view.querySelector('input[type="tel"]')!, "+79001112233");
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fields: { phone: "+79001112233" } }),
      }),
    );
  });
  it("keeps the manager fallback available in the expanded editor", async () => {
    state.managersUnavailable = true;
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    expect(view.textContent).toContain(
      "Менеджеры из ранее загруженных кандидатов",
    );
    await pick("Менеджер", "Борис");
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fields: { managerId: "other" } }),
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
  it("creates with minimal fields and looks up the operation before repeating an uncertain request", async () => {
    vi.useFakeTimers();
    state.create.mockRejectedValueOnce(new Error("Lost response"));
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    const form = view.querySelector("form")!;
    const inputs = form.querySelectorAll<HTMLInputElement>(
      "fieldset > label > input",
    );
    type(inputs[0], "Иванов Иван");
    type(inputs[1], "+79000000000");
    type(inputs[2], "1991-02-03");
    await act(async () => vi.advanceTimersByTime(500));
    await submit("Создание кандидата");
    expect(state.create).toHaveBeenCalledWith({
      data: {
        requestId: expect.any(String),
        fields: {
          fullName: "Иванов Иван",
          phone: "+79000000000",
          birthDate: "1991-02-03",
        },
      },
    });
    expect(form.querySelector("fieldset")!.disabled).toBe(true);
    state.matchState = "error";
    await act(async () => root.render(<CandidatesPage />));
    await submit("Создание кандидата");
    expect(state.operation).toHaveBeenCalledTimes(1);
    expect(state.create.mock.calls[0][0]).toEqual(
      state.create.mock.calls[1][0],
    );
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { candidateId: "current-cycle" } }),
    );
  });
  it("requires an explicit different-person acknowledgement for candidate matches", async () => {
    vi.useFakeTimers();
    state.candidateMatches = [
      {
        id: "other-erp",
        name: "Иванов Иван",
        birthDate: null,
        selection: "signed-other-candidate",
        matchedPhone: true,
      },
    ];
    await render(<CandidatesPage />);
    await click("Создать кандидата");
    const inputs = view.querySelectorAll<HTMLInputElement>(
      "fieldset > label > input",
    );
    type(inputs[0], "Иванов Иван");
    type(inputs[1], "+79000000000");
    type(inputs[2], "1991-02-03");
    await act(async () => vi.advanceTimersByTime(500));
    await submit("Создание кандидата");
    expect(state.create).not.toHaveBeenCalled();
    const ignored = [...view.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Это другой человек"))!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => ignored.click());
    await submit("Создание кандидата");
    expect(state.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ignoredSelections: ["signed-other-candidate"],
      }),
    });
  });
  it("edits an old card with null DOB without requiring a replacement date", async () => {
    state.profile.birthDate = null;
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Редактировать данные");
    expect(
      view.querySelector<HTMLInputElement>('input[type="date"]')?.required,
    ).toBe(false);
    type(view.querySelector('input[type="tel"]')!, "+79001112233");
    await submit("Редактирование кандидата");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fields: { phone: "+79001112233" } }),
      }),
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

  it("shows the exact linked person and does not offer ordinary relinking", async () => {
    state.profile.linkedPerson = true;
    state.profile.person = {
      id: "exact-person",
      name: "Иванов Иван Петрович",
      birthDate: null,
      code: "00123",
    };
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("Иванов Иван Петрович");
    expect(view.textContent).toContain("00123");
    expect(view.textContent).toContain("обратитесь к администратору");
    expect(button("Выбрать физлицо")).toBeUndefined();
    expect(state.link).not.toHaveBeenCalled();
  });
  it("requires an explicit signed selection before linking an unlinked card", async () => {
    vi.useFakeTimers();
    await render(<CandidateManagement candidateId="current-cycle" />);
    await click("Выбрать физлицо");
    const search = view.querySelector<HTMLInputElement>(
      'input[aria-label="Поиск физлица"]',
    )!;
    await act(async () =>
      search.dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
    );
    type(search, "Иван");
    await act(async () => vi.advanceTimersByTime(301));
    await pick("Поиск физлица", "Иванов Иван · 03.02.1990");
    expect(button("Связать с текущим кандидатом").disabled).toBe(true);
    await act(async () =>
      view.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await submit("Связывание с физлицом");
    expect(state.link).toHaveBeenCalledWith({
      candidateId: "current-cycle",
      data: {
        requestId: expect.any(String),
        personSelection: "signed-opaque-person",
      },
    });
  });

  it("shows old documents with their attributes and without manual recheck form", async () => {
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
          recordDate: "2020-02-03",
          isInvalid: false,
        },
        expiresAt: "2028-01-01",
        originalAvailable: false,
        status: "REQUIRES_REVIEW",
        reviewedAt: null,
      },
    ];
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("Требует проверки");
    expect(view.textContent).toContain("123456");
    expect(view.textContent).toContain("03.02.2020");
    expect(view.textContent).toContain("Отмечен недействительным в ERP");
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
    expect(view.querySelector("form")).toBeNull();
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

  it("renders status history timeline with status badge, author and blockquote comment", async () => {
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("История статусов");
    const timeline = view.querySelector("ol");
    expect(timeline).not.toBeNull();
    expect(timeline?.className).toContain("border-l-2");
    expect(view.textContent).toContain("Подбор");
    expect(view.textContent).toContain("Менеджер");
    const blockquote = view.querySelector("blockquote");
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent).toContain("Проверен телефон");
    expect(blockquote?.className).toContain("bg-[var(--muted)]/60");
  });

  it("renders EmptyState when status history is empty", async () => {
    state.profile.history = [];
    await render(<CandidateManagement candidateId="current-cycle" />);
    expect(view.textContent).toContain("История пока пуста");
    expect(view.querySelector("ol")).toBeNull();
  });

  it("renders collapsible accordion for previous documents with counter and details", async () => {
    state.profile.linkedPerson = true;
    state.previous = [
      {
        id: "old-doc-1",
        title: "Паспорт",
        fields: {},
        expiresAt: null,
        originalAvailable: true,
        status: "CONFIRMED",
        reviewedAt: null,
      },
      {
        id: "old-doc-2",
        title: "ИНН",
        fields: {},
        expiresAt: null,
        originalAvailable: false,
        status: "REQUIRES_REVIEW",
        reviewedAt: null,
      },
    ];
    await render(<CandidateManagement candidateId="current-cycle" />);
    const details = view.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    expect(details?.className).toContain("rounded-xl");
    const summary = details?.querySelector("summary");
    expect(summary?.textContent).toContain("История документов");
    expect(summary?.textContent).toContain("2");
  });
});
