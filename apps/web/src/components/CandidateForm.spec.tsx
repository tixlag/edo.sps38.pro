import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CandidateForm,
  candidateChangedFields,
  candidateFormFields,
  candidateError,
} from "./CandidateForm";
import type { CandidateWorkspaceDto } from "@edo/api-client";

const state = vi.hoisted(() => ({
  submit: vi.fn(),
  managers: [] as { id: string; name: string }[],
  catalogManagers: [] as { id: string; name: string }[],
  managerQueries: [] as ({ q?: string } | undefined)[],
  persons: [] as { id: string; name: string; personUid: string }[],
}));
vi.mock("@edo/api-client", () => {
  const empty = { data: { items: [] }, isLoading: false, isError: false };
  return {
    getListCandidateSettlementsQueryKey: () => ["settlements"],
    useListCandidateSettlements: () => ({
      data: { items: [] },
      isLoading: false,
      isError: false,
    }),
    useListCandidateCountries: () => empty,
    useListCandidateOrganizations: () => empty,
    useListCandidateSources: () => empty,
    useListCandidateResponsibles: () => empty,
    useListCandidateContactTypes: () => empty,
    useListCandidateContactKinds: () => empty,
    useListCandidateUniversities: () => empty,
    useGetMe: () => ({ data: { fullName: "Текущий менеджер" } }),
    useListCandidateManagers: (params?: { q?: string }) => {
      state.managerQueries.push(params);
      return {
        ...empty,
        data: {
          items: state.managers.filter((item) =>
            params?.q
              ? item.name
                  .toLocaleLowerCase("ru")
                  .includes(params.q.toLocaleLowerCase("ru"))
              : true,
          ),
        },
      };
    },
    useListCatalogManagers: () => ({
      ...empty,
      data: { items: state.catalogManagers },
    }),
    getListCatalogManagersQueryKey: () => ["catalog-managers"],
    useListCandidatePositions: () => empty,
    useListCandidateProjects: () => empty,
    useFindCandidatePersonMatches: () => ({
      ...empty,
      data: { items: state.persons },
    }),
    getFindCandidatePersonMatchesQueryKey: () => ["matches"],
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.clearAllMocks();
  state.managers = [];
  state.catalogManagers = [];
  state.managerQueries = [];
  state.persons = [];
  vi.useRealTimers();
});

describe("CandidateForm", () => {
  it("offers expanded creation fields without inventing citizenship or requiring work fields", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <CandidateForm
          pending={false}
          locked={false}
          error=""
          onSubmit={state.submit}
          onCancel={vi.fn()}
        />,
      ),
    );
    expect(
      container.querySelector('input[aria-label="Менеджер"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('input[aria-label="Должность"]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Дата рождения"]',
      )?.required,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
    expect(candidateFormFields()).toEqual({
      fullName: "",
      phone: "",
      birthDate: null,
      citizenship: "ru",
      sex: "male",
    });
  });
  it("preserves null birth date and unknown citizenship when computing a phone-only patch", () => {
    const fields = candidateFormFields({
      fullName: "Иванов Иван",
      phone: "1",
      birthDate: null,
      citizenship: null,
    } as CandidateWorkspaceDto);
    expect(fields.birthDate).toBeNull();
    expect(fields.citizenship).toBeNull();
    expect(candidateChangedFields(fields, { ...fields, phone: "2" })).toEqual({
      phone: "2",
    });
  });
  it("sends only changed contact rows and retains typed source and responsible references", () => {
    const initial = {
      contacts: [
        { rowNumber: 1, typeId: "Phone", kindId: "work", presentation: "111" },
        { rowNumber: 2, typeId: "Email", presentation: "a@b.ru" },
      ],
      responsible: { kind: "person" as const, id: "physical" },
      sourceComment: { kind: "person" as const, id: "source-person" },
    };
    expect(
      candidateChangedFields(initial, {
        ...initial,
        contacts: [
          initial.contacts[0],
          { ...initial.contacts[1], presentation: "c@b.ru" },
          { typeId: "Email", presentation: "new@b.ru" },
        ],
      }),
    ).toEqual({
      contacts: [
        { rowNumber: 2, typeId: "Email", presentation: "c@b.ru" },
        { typeId: "Email", presentation: "new@b.ru" },
      ],
    });
  });
  it("translates actor lookup failures into actionable guidance", () => {
    expect(
      candidateError({
        response: { data: { message: "ERP_ACTOR_NOT_FOUND_OR_AMBIGUOUS" } },
      }),
    ).toContain("Обратитесь к администратору 1С");
    expect(candidateError({})).toContain("Сначала проверьте результат");
  });
});

async function renderCreation() {
  if (!container?.isConnected) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root.render(
      <CandidateForm
        pending={false}
        locked={false}
        error=""
        onSubmit={state.submit}
        onCancel={vi.fn()}
      />,
    ),
  );
}
async function fillCreation() {
  const inputs = container.querySelectorAll<HTMLInputElement>(
    'fieldset > label > input, fieldset > div input[type="date"]',
  );
  for (const [index, value] of [
    "Иванов Иван",
    "+79000000000",
    "1991-02-03",
  ].entries()) {
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(inputs[index], value);
      inputs[index].dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => vi.advanceTimersByTime(500));
}
async function sendCreation() {
  await fillCreation();
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  return state.submit.mock.calls.at(-1)![0];
}
it("applies the current manager when their directory arrives and sends managerId on creation", async () => {
  vi.useFakeTimers();
  await renderCreation();
  expect(
    (container.querySelector('[aria-label="Менеджер"]') as HTMLInputElement)
      .value,
  ).toBe("");
  state.managers = [{ id: "self", name: "Текущий менеджер" }];
  await renderCreation();
  expect(
    (container.querySelector('[aria-label="Менеджер"]') as HTMLInputElement)
      .value,
  ).toBe("Текущий менеджер");
  expect((await sendCreation()).managerId).toBe("self");
});
it("prefills the current manager from the local catalog without an ERP search", async () => {
  vi.useFakeTimers();
  state.catalogManagers = [{ id: "self", name: "Текущий менеджер" }];
  await renderCreation();
  expect(
    (container.querySelector('[aria-label="Менеджер"]') as HTMLInputElement)
      .value,
  ).toBe("Текущий менеджер");
  expect((await sendCreation()).managerId).toBe("self");
  // The default must never trigger a filtered ERP managers request: only the
  // plain dropdown page is allowed.
  expect(state.managerQueries.length).toBeGreaterThan(0);
  expect(state.managerQueries.every((params) => !params?.q)).toBe(true);
});
it("does not overwrite a manually selected or cleared manager when the directory refreshes", async () => {
  vi.useFakeTimers();
  state.managers = [{ id: "other", name: "Другой менеджер" }];
  await renderCreation();
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Менеджер"]')!
      .focus(),
  );
  await act(async () =>
    container.querySelector<HTMLElement>('[role="option"]')!.click(),
  );
  state.managers = [
    ...state.managers,
    { id: "self", name: "Текущий менеджер" },
  ];
  await renderCreation();
  expect((await sendCreation()).managerId).toBe("other");
  const clear = [...container.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Очистить"),
  )!;
  await act(async () => clear.click());
  await renderCreation();
  expect((await sendCreation()).managerId).toBeNull();
});

it("saves a settlement absent from ERP suggestions", async () => {
  vi.useFakeTimers();
  await renderCreation();
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Населённый пункт"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Новый посёлок");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe("Новый посёлок");
  expect((await sendCreation()).settlement).toBe("Новый посёлок");
});

it("shows a saved settlement when the card is reopened", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CandidateForm
        profile={{ settlement: "Новый посёлок" } as CandidateWorkspaceDto}
        pending={false}
        locked={false}
        error=""
        onSubmit={state.submit}
        onCancel={vi.fn()}
      />,
    ),
  );
  expect(
    container.querySelector<HTMLInputElement>(
      'input[aria-label="Населённый пункт"]',
    )?.value,
  ).toBe("Новый посёлок");
});

it("puts duplicate results before collapsed details and keeps every creation field available", async () => {
  await renderCreation();
  const matches = container.querySelector('[aria-label="Совпадения в ERP"]')!;
  const sections = [
    ...container.querySelectorAll("details[data-candidate-section]"),
  ];
  expect(sections).toHaveLength(3);
  for (const section of sections) {
    expect((section as HTMLDetailsElement).open).toBe(false);
    expect(
      matches.compareDocumentPosition(section) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  expect(container.querySelector('[aria-label="Гражданство"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Организация"]')).not.toBeNull();
  expect(container.textContent).toContain("Добавить контакт");
  expect(container.textContent).toContain("ФИО · обязательно");
});

it("reveals the work section on a blocked save and preserves the validation rule", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CandidateForm
        profile={{ fullName: "Иванов Иван" } as CandidateWorkspaceDto}
        pending={false}
        locked={false}
        error=""
        onSubmit={state.submit}
        onCancel={vi.fn()}
      />,
    ),
  );
  const section = container.querySelector<HTMLDetailsElement>(
    'details[data-candidate-section="work"]',
  )!;
  section.open = true;
  const flag = [...section.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("Студент на практике"))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => flag.click());
  section.open = false;
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(section.open).toBe(true);
  expect(state.submit).not.toHaveBeenCalled();
  expect(section.textContent).toContain("Укажите дату окончания практики");
  expect(document.activeElement).toBe(section.querySelector("summary"));
});

it("reveals collapsed contacts when browser validation finds an incomplete new contact", async () => {
  await renderCreation();
  const section = container.querySelector<HTMLDetailsElement>(
    'details[data-candidate-section="contacts"]',
  )!;
  section.open = true;
  const add = [...section.querySelectorAll("button")].find(
    (button) => button.textContent === "Добавить контакт",
  )!;
  await act(async () => add.click());
  section.open = false;
  await act(async () =>
    expect(
      section
        .querySelector<HTMLSelectElement>("select[required]")!
        .checkValidity(),
    ).toBe(false),
  );
  expect(section.open).toBe(true);
  expect(state.submit).not.toHaveBeenCalled();
});

it("retains basic and expanded values when confirming a matching person", async () => {
  vi.useFakeTimers();
  state.persons = [
    { id: "signed-selection", name: "Иванов Иван", personUid: "person-uid" },
  ];
  await renderCreation();
  await fillCreation();
  const settlement = container.querySelector<HTMLInputElement>(
    '[aria-label="Населённый пункт"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(settlement, "Иркутск");
    settlement.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[name="person-selection"]')!
      .click(),
  );
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(state.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      fullName: "Иванов Иван",
      phone: "+79000000000",
      birthDate: "1991-02-03",
      settlement: "Иркутск",
    }),
    "signed-selection",
    [],
  );
});
