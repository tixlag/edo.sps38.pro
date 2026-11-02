import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CandidateListFilters } from "./CandidateListFilters";

vi.mock("@edo/api-client", () => ({
  useListPositions: () => ({
    data: { items: [{ code: "P1", name: "Сварщик" }] },
  }),
  useListCandidateProjects: () => ({
    data: { items: [{ id: "O1", code: "O1", name: "Объект" }] },
  }),
  useListCandidateManagers: () => ({
    data: { items: [{ id: "M1", name: "Менеджер" }] },
  }),
  useListCatalogMentors: () => ({
    data: { items: [{ code1c: "N1", name: "Наставник" }] },
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("shows searchable filters and applies the selected value", async () => {
  const onChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<CandidateListFilters values={{}} onChange={onChange} />),
  );
  for (const [label, option, key, value] of [
    ["Должность", "Сварщик", "positionCode", "P1"],
    ["Объект", "Объект", "projectCode", "O1"],
    ["Менеджер", "Менеджер", "managerId", "M1"],
    ["Наставник", "Наставник", "mentorCode1c", "N1"],
  ]) {
    const input = container.querySelector(
      `input[aria-label="${label}"]`,
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => input.focus());
    const entry = [...container.querySelectorAll('[role="option"]')].find(
      (node) => node.textContent === option,
    ) as HTMLElement;
    await act(async () => entry.click());
    expect(onChange).toHaveBeenLastCalledWith(key, value);
    await act(async () => input.blur());
  }
  await act(async () => root.unmount());
  container.remove();
});
