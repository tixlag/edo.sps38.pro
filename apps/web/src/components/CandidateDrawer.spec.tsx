import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CandidateDrawer } from "./CandidateDrawer";

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  navigate: vi.fn(),
  data: null as unknown,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mock.navigate,
  useSearch: () => ({ candidate: "c1", candidateStage: "1" }),
}));
vi.mock("@edo/api-client", () => ({
  useGetCandidateDetails: (...args: unknown[]) => {
    mock.query(...args);
    return { data: mock.data };
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = vi.fn();
HTMLDialogElement.prototype.close = vi.fn();
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});
const doc = (id: string, title: string, returnedVersions: unknown[] = []) => ({
  id,
  title,
  status: "IN_REVIEW",
  currentVersion: 1,
  returnedVersions,
});
async function render(
  returnedHistory = false,
  stage: string | undefined = "1",
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <CandidateDrawer
        candidateId="c1"
        stage={stage}
        profile={null}
        returnedHistory={returnedHistory}
        onClose={() => {}}
      />,
    ),
  );
  return container;
}
describe("stage candidate drawer", () => {
  it("shows the chosen stage in required and additional sections including missing types", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        approvedDocuments: 0,
        requiredDocuments: 2,
      },
      documents: [doc("other", "Другой этап")],
      stageDocuments: {
        required: { documents: [doc("a", "Паспорт")], missingDocuments: [] },
        additional: {
          documents: [],
          missingDocuments: [{ code: "b", title: "Справка" }],
        },
      },
    };
    const view = await render();
    expect(mock.query).toHaveBeenCalledWith("c1", { stage: "1" });
    expect(view.textContent).toContain("Этап 1");
    expect(view.textContent).toContain("Паспорт");
    expect(view.textContent).toContain("Справка");
    expect(view.textContent).not.toContain("Другой этап");
    expect(view.textContent!.indexOf("Обязательные")).toBeLessThan(
      view.textContent!.indexOf("Дополнительные"),
    );
  });
  it("groups all documents when opening the candidate card", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        approvedDocuments: 0,
        requiredDocuments: 1,
      },
      documents: [],
      documentGroups: {
        required: {
          documents: [doc("a", "Паспорт")],
          missingDocuments: [{ code: "c", title: "Анкета" }],
        },
        additional: { documents: [doc("b", "Справка")], missingDocuments: [] },
      },
    };
    const view = await render(false, "");
    expect(mock.query).toHaveBeenCalledWith("c1", undefined);
    const sections = view.querySelectorAll("section");
    expect(sections[0].textContent).toContain("Обязательные");
    expect(sections[0].textContent).toContain("Паспорт");
    expect(sections[0].textContent).toContain("Анкета");
    expect(sections[1].textContent).toContain("Дополнительные");
    expect(sections[1].textContent).toContain("Справка");
  });
  it("shows only returned versions of the chosen stage", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        approvedDocuments: 0,
        requiredDocuments: 2,
      },
      documents: [],
      stageDocuments: {
        required: {
          documents: [
            doc("a", "Паспорт", [{ version: 1, rejectionReason: "Фото" }]),
          ],
          missingDocuments: [{ code: "missing", title: "Отсутствующий" }],
        },
        additional: { documents: [doc("b", "Справка")], missingDocuments: [] },
      },
    };
    const view = await render(true);
    expect(view.textContent).toContain("Паспорт");
    expect(view.textContent).toContain("Фото");
    expect(view.textContent).not.toContain("Справка");
    expect(view.textContent).not.toContain("Отсутствующий");
  });
});
