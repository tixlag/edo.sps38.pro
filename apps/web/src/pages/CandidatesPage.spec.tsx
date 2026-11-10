vi.mock("../lib/use-visible-ru-document-sync", () => ({ useVisibleRuDocumentSync: () => ({ pendingIds: new Set(), error: false, retry: vi.fn() }) }));
import { afterEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CandidatesPage } from "./CandidatesPage";

const state = vi.hoisted(() => ({ navigate: vi.fn(), list: vi.fn() }));
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
    useGetMe: () => ({ data: { permissions: { "20002": [] } } }),
    useCreateCandidate: vi.fn(),
    getListCommunicationCandidatesQueryKey: vi.fn(),
    useListCandidateManagers: () => empty,
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
    ["Должность кандидата", "Сварщик", { positionCode: "P1" }],
    ["Наставник кандидата", "Наставник", { mentorCode1c: "M1" }],
  ] as const) {
    const input = container.querySelector(
      `input[aria-label="${label}"]`,
    ) as HTMLInputElement;
    await act(async () => input.focus());
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
