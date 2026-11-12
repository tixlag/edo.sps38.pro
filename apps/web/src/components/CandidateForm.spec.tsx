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
}));
vi.mock("@edo/api-client", () => {
  const empty = { data: { items: [] }, isLoading: false, isError: false };
  return {
    useGetMe: () => ({ data: { fullName: "Текущий менеджер" } }),
    useListCandidateManagers: () => ({
      ...empty,
      data: { items: state.managers },
    }),
    useListCatalogManagers: () => empty,
    getListCatalogManagersQueryKey: () => ["catalog-managers"],
    useListCandidatePositions: () => empty,
    useListCandidateProjects: () => empty,
    useFindCandidatePersonMatches: () => empty,
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
});

describe("CandidateForm", () => {
  it("creates with only name, phone and DOB without inventing citizenship or requiring work fields", async () => {
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
    expect(container.querySelector('input[aria-label="Должность"]')).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[type="date"]')?.required,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(false);
    expect(candidateFormFields()).toEqual({
      fullName: "",
      phone: "",
      birthDate: null,
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
async function sendCreation() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  return state.submit.mock.calls.at(-1)![0];
}
it("applies the current manager when their directory arrives and sends managerId on creation", async () => {
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
it("does not overwrite a manually selected or cleared manager when the directory refreshes", async () => {
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
