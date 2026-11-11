import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CandidateForm, candidateError, useCandidateRequest } from "./CandidateForm";

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

  describe("candidateError", () => {
    it("translates ACTOR_NOT_FOUND_OR_AMBIGUOUS into actionable user guidance", () => {
      const err = {
        response: {
          data: {
            message:
              "ERP_ACTOR_NOT_FOUND_OR_AMBIGUOUS: пользователь 1C для автора операции не найден",
          },
        },
      };
      expect(candidateError(err)).toBe(
        "Пользователь 1С для вашей учётной записи не найден или не сопоставлен с физическим лицом в ERP. Обратитесь к администратору 1С.",
      );
    });

    it("falls back to generic error when message is empty", () => {
      expect(candidateError({})).toBe(
        "ERP не подтвердила операцию. Повторите запрос с теми же данными.",
      );
    });
  });

  describe("useCandidateRequest", () => {
    it("unlocks when status is 403", () => {
      let state!: ReturnType<typeof useCandidateRequest>;
      function TestComponent() {
        state = useCandidateRequest();
        return null;
      }
      const container = document.createElement("div");
      const root = createRoot(container);
      act(() => {
        root.render(<TestComponent />);
      });
      act(() => {
        state.begin();
      });
      expect(state.locked).toBe(true);
      act(() => {
        state.fail({ response: { status: 403, data: { message: "FORBIDDEN" } } });
      });
      expect(state.locked).toBe(false);
      expect(state.error).toBe("FORBIDDEN");
      act(() => {
        root.unmount();
      });
    });
  });
});
