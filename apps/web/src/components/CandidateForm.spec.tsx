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

const state = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("@edo/api-client", () => {
  const empty = { data: { items: [] }, isLoading: false, isError: false };
  return {
    useListCandidateManagers: () => empty,
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
    expect(container.querySelector('input[aria-label="Менеджер"]')).toBeNull();
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
