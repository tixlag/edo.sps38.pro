import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CandidateForm } from "./CandidateForm";

const state = vi.hoisted(() => ({
  me: { fullName: "Петрова Анна" },
  managers: [{ id: "mgr-petrova", name: "Петрова Анна" }],
  submit: vi.fn(),
}));

vi.mock("@edo/api-client", () => {
  const empty = { data: { items: [] }, isLoading: false, isError: false };
  return {
    useGetMe: () => ({ data: state.me, isLoading: false }),
    useListCandidateManagers: () => ({
      data: { items: state.managers },
      isLoading: false,
      isError: false,
    }),
    useListCatalogManagers: () => empty,
    getListCatalogManagersQueryKey: () => ["catalog-managers"],
    useListCandidatePositions: () => ({
      data: { items: [{ code: "POS1", name: "Инженер" }] },
      isLoading: false,
      isError: false,
    }),
    useListCandidateProjects: () => empty,
    useFindCandidatePersonMatches: () => empty,
    getFindCandidatePersonMatchesQueryKey: () => ["matches"],
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.clearAllMocks();
});

describe("CandidateForm", () => {
  it("defaults managerId to matching current user when creating a new candidate", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
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

    const managerInput = container.querySelector(
      'input[aria-label="Менеджер"]',
    ) as HTMLInputElement;
    expect(managerInput).not.toBeNull();
    expect(managerInput.value).toBe("Петрова Анна");

    await act(async () => root.unmount());
    container.remove();
  });
});
