vi.mock("../lib/use-visible-ru-document-sync", () => ({
  useVisibleRuDocumentSync: () => ({
    pendingIds: new Set(),
    error: false,
    retry: vi.fn(),
  }),
}));
import { afterEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CandidatesPage } from "./CandidatesPage";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  list: vi.fn(),
  me: { permissions: { "20002": [] }, fullName: "Менеджер Иванов" } as unknown,
  managers: [{ id: "mgr-1", name: "Менеджер Иванов" }] as unknown[],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => state.navigate,
  useSearch: () => ({ cursor: "old" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@edo/api-client", () => {
  const empty = { data: { items: [] }, refetch: vi.fn() };
  return {
    useGetMe: () => ({ data: state.me }),
    useCreateCandidate: vi.fn(),
    getListCommunicationCandidatesQueryKey: vi.fn(),
    useListCandidateManagers: () => ({
      data: { items: state.managers },
      refetch: vi.fn(),
    }),
    useListCandidateProjects: () => empty,
    useListCandidateStatuses: () => empty,
    useListPositions: () => ({
      data: { items: [{ code: "P1", name: "Сварщик" }] },
    }),
    useListCatalogMentors: () => ({
      data: { items: [{ code1c: "M1", name: "Наставник" }] },
    }),
    useListCommunicationCandidates: (params: unknown) => {
      state.list(params);
      return empty;
    },
  };
});
vi.mock("../components/CandidateForm", () => ({
  CandidateForm: () => null,
  CANDIDATE_CONTROL: "",
  useCandidateRequest: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.clearAllMocks());
it("selects a position and mentor and resets pagination", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CandidatesPage />));
  for (const [label, text, expected] of [
    [
      "Должность кандидата",
      "Сварщик",
      { positionCodes: ["P1"], positionCode: undefined },
    ],
    [
      "Наставник кандидата",
      "Наставник",
      { mentorCodes1c: ["M1"], mentorCode1c: undefined },
    ],
  ] as const) {
    const input = container.querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement;
    await act(async () => input.click());
    const option = [...container.querySelectorAll('[role="option"]')].find(
      (node) => node.textContent === text,
    ) as HTMLElement;
    await act(async () => option.click());
    const navigation = state.navigate.mock.calls.at(-1)![0];
    expect(navigation.search({ cursor: "old", statusId: "active" })).toEqual({
      statusId: "active",
      cursor: undefined,
      ...expected,
    });
  }
  await act(async () => root.unmount());
  container.remove();
});

it("defaults manager filter to current user when matching candidate managers", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CandidatesPage />));
  expect(state.list).toHaveBeenCalledWith(
    expect.objectContaining({ managerId: "mgr-1" }),
  );
  await act(async () => root.unmount());
  container.remove();
});
