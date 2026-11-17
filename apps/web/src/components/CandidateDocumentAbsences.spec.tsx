import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CandidateDocumentAbsences } from "./CandidateDocumentAbsences";
const api = vi.hoisted(() => ({ report: vi.fn().mockResolvedValue({}), decide: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@edo/api-client", () => ({
  useGetMe: () => ({ data: { permissions: { "20002": [] } } }),
  useListCandidateDocumentAbsences: () => ({ data: [] }),
  getListCandidateDocumentAbsencesQueryKey: () => ["absences"],
  getGetCandidateDetailsQueryKey: () => ["candidate"],
  useReportCandidateDocumentAbsence: () => ({ mutateAsync: api.report }),
  useDecideCandidateDocumentAbsence: () => ({ mutateAsync: api.decide }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("explains that saving an absence reason is separate from agreeing to it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<CandidateDocumentAbsences candidateId="c1" missing={[{ code: "diploma", title: "Диплом" }]} />));
    expect(host.textContent).toContain("Сохранение причины само по себе не снимает требование документа");
    await act(async () => host.querySelector("button")!.click());
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Не получал диплом");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Сохранить причину")!;
    expect(button).toBeTruthy();
    expect(host.textContent).not.toContain("Передать на решение");
    await act(async () => button.click());
    expect(api.report).toHaveBeenCalledWith({ candidateId: "c1", data: { documentTypeCode: "diploma", reason: "Не получал диплом" } });
    expect(api.decide).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
