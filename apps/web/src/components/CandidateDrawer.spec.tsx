vi.mock("./CandidateDocumentThumbnail", () => ({ CandidateDocumentThumbnail: () => null }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CandidateDrawer } from "./CandidateDrawer";

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  request: vi.fn(),
  invalidate: vi.fn(),
  navigate: vi.fn(),
  data: null as unknown,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mock.navigate,
  useSearch: () => ({ candidate: "c1", candidateStage: "1" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mock.invalidate }),
}));
vi.mock("@edo/api-client", () => ({
  useGetDocumentVersion: () => ({
    data: { status: "APPROVED", files: [] },
    isFetching: false,
    isError: false,
    isSuccess: true,
  }),
  getGetDocumentVersionQueryKey: (id: string, version: number) => [
    "version",
    id,
    version,
  ],
  useGetDocumentFileBinary: () => ({ isFetching: false, isError: false }),
  getGetDocumentFileBinaryQueryKey: (
    id: string,
    version: number,
    file: string,
  ) => ["file", id, version, file],
  getGetCandidateDetailsQueryKey: (id: string) => ["candidate", id],
  getListCandidatePreviousDocumentsQueryKey: (id: string) => ["previous", id],
  getListReviewCandidatesQueryKey: () => ["review"],
  getListCandidateReviewQueueQueryKey: () => ["queue"],
  getListIgArrivalRegistryGroupsQueryKey: () => ["groups"],
  getListIgArrivalRegistryParticipationsQueryKey: () => ["people"],
  useRequestCandidateEnrichment: () => ({
    mutate: mock.request,
    isPending: false,
    isError: false,
  }),
  useGetCandidateDetails: (...args: unknown[]) => {
    mock.query(...args);
    return { data: mock.data };
  },
}));
vi.mock("./CandidateDrawerHistorySection", () => ({
  CandidateDrawerHistorySection: ({ candidateId }: { candidateId: string }) => (
    <div>История ERP: {candidateId}</div>
  ),
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
  arrivalContext?: {
    date?: string;
    arrivalDateTime?: string;
    location?: string;
    status: string;
  },
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
        arrivalContext={arrivalContext}
        onClose={() => {}}
      />,
    ),
  );
  return container;
}
describe("stage candidate drawer", () => {
  it("does not show the legacy aggregate for an arrival context", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        approvedDocuments: 1,
        requiredDocuments: 3,
      },
      documents: [],
    };
    const view = await render(false, "1", { status: "CURRENT" });
    expect(view.textContent).toContain(
      "Обязательные документы — по этапам ниже",
    );
    expect(view.textContent).not.toContain("Подтверждено 1 из 3");
    expect(view.querySelector('[role="progressbar"]')).toBeNull();
  });
  it("retains the ordinary candidate aggregate and progress bar", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        approvedDocuments: 1,
        requiredDocuments: 3,
      },
      documents: [],
    };
    const view = await render();
    expect(view.textContent).toContain("Подтверждено 1 из 3");
    expect(
      view.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
    ).toBe("33");
  });
  it("identifies the selected historic arrival while showing the current profile", async () => {
    const view = await render(false, "1", {
      date: "2026-11-10",
      arrivalDateTime: "2026-11-10T14:35:00",
      location: "Склад",
      status: "HISTORICAL",
    });
    expect(view.textContent).toContain("Исторический заезд");
    expect(view.textContent).toContain("10.11.2026, 14:35");
    expect(view.textContent).toContain("Склад");
    expect(view.textContent).toContain("текущий профиль");
  });
  it("hides stage totals in arrival context while preserving stage documents", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        approvedDocuments: 0,
        requiredDocuments: 1,
      },
      stageDocuments: {
        required: { documents: [doc("a", "Паспорт")], missingDocuments: [] },
        additional: { documents: [], missingDocuments: [] },
      },
    };
    const view = await render(false, "1", { status: "CURRENT" });
    const stage = [...view.querySelectorAll("button")].find((button) =>
      button.querySelector("h3"),
    )!;
    expect(stage.textContent).not.toContain("0 из 1");
    expect(stage.querySelector('[style*="width"]')).toBeNull();
    expect(view.textContent).toContain("Паспорт");
    expect(view.textContent).toContain("Проверить документ");
  });
  it("keeps stage totals in the ordinary drawer", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        approvedDocuments: 0,
        requiredDocuments: 1,
      },
      stageDocuments: {
        required: { documents: [doc("a", "Паспорт")], missingDocuments: [] },
        additional: { documents: [], missingDocuments: [] },
      },
    };
    const view = await render();
    const stage = [...view.querySelectorAll("button")].find((button) =>
      button.querySelector("h3"),
    )!;
    expect(stage.textContent).toContain("0 из 1");
    expect(stage.querySelector('[style*="width"]')).not.toBeNull();
  });
  it("shows ERP history for an IG candidate even within a stage", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        reviewGroup: "IG",
        code1c: "person-code",
        approvedDocuments: 0,
        requiredDocuments: 0,
      },
      stageDocuments: {
        required: { documents: [], missingDocuments: [] },
        additional: { documents: [], missingDocuments: [] },
      },
    };
    const view = await render();
    expect(view.textContent).toContain("История ERP: c1");
  });
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
    expect(mock.query).toHaveBeenCalledWith(
      "c1",
      { stage: "1" },
      expect.anything(),
    );
    expect(view.textContent).toContain("Этап 1");
    expect(view.textContent).toContain("Паспорт");
    expect(view.textContent).toContain("Справка");
    expect(view.textContent).not.toContain("Другой этап");
    expect(view.textContent!.indexOf("Обязательные")).toBeLessThan(
      view.textContent!.indexOf("Дополнительные"),
    );
  });
  it("keeps the complete object and profile values visible in the header", async () => {
    const objectName = "Логистический складской комплекс Восток-Ойл";
    const objectCode = "38/СУ112/ВОН/СПС/0701/ОР";
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Кандидат",
        birthDate: "2000-03-11",
        citizenship: "ru",
        positionName: "Электромонтажник",
        projectName: objectName,
        projectCode: objectCode,
        managerName: "Менеджер",
        mentorName: null,
        approvedDocuments: 1,
        requiredDocuments: 3,
      },
      documents: [],
      documentGroups: {
        required: { documents: [], missingDocuments: [] },
        additional: { documents: [], missingDocuments: [] },
      },
    };
    const view = await render(false, "");
    const fields = [...view.querySelectorAll("dt")];
    const object = fields.find((field) => field.textContent === "Объект");
    expect(object?.nextElementSibling?.textContent).toBe(
      `${objectName} (${objectCode})`,
    );
    expect(
      fields.find((field) => field.textContent === "Наставник")
        ?.nextElementSibling?.textContent,
    ).toBe("—");
    expect(
      view.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
    ).toBe("33");
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
    expect(mock.query).toHaveBeenCalledWith("c1", undefined, expect.anything());
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

  it("renders panel with agreed visual mock dimensions, badges and header", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        fullName: "Каримов Бахром Анварович",
        citizenship: "uz",
        isReemployment: true,
        reviewGroup: "IG",
        birthDate: "1995-04-12",
        positionName: "Бетонщик",
        approvedDocuments: 2,
        requiredDocuments: 4,
      },
      stages: [
        {
          stage: 1,
          title: "Этап 1",
          required: {
            documents: [doc("doc-pass", "Паспорт")],
            missingDocuments: [],
          },
          additional: { documents: [], missingDocuments: [] },
          previousDocuments: [],
        },
      ],
    };

    const view = await render(false, "1");

    // Panel styling
    const dialog = view.querySelector("dialog");
    expect(dialog?.className).toContain("bg-black/40");
    const panel = view.querySelector(".candidate-drawer-panel");
    expect(panel?.className).toContain("max-w-[760px]");
    expect(panel?.className).toContain("min-[640px]:w-[720px]");
    expect(panel?.className).toContain("lg:w-[760px]");

    // Initials avatar
    expect(view.textContent).toContain("КБ");

    // Full name and badges
    expect(view.textContent).toContain("Каримов Бахром Анварович");
    expect(view.textContent).toContain("UZ");
    expect(view.textContent).toContain("Повторный найм");

    // Stage header and progress
    expect(view.textContent).toContain("Этапы проверки документов");
    expect(view.textContent).toContain("Подтверждено 2 из 4");

    // Document review action opens review dialog via search navigation
    const reviewBtn = [...view.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Проверить документ"),
    );
    expect(reviewBtn).toBeTruthy();
    await act(async () => reviewBtn?.click());
    expect(mock.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.any(Function),
      }),
    );
    const searchUpdater = mock.navigate.mock.calls.at(-1)?.[0]?.search;
    expect(searchUpdater?.({})).toEqual(
      expect.objectContaining({
        documentCandidate: "c1",
        reviewerDocument: "doc-pass",
      }),
    );
  });
});

describe("priority document loading", () => {
  it("requests the opened employee ahead of the background queue and polls while pending", async () => {
    mock.data = {
      candidate: { id: "c1", reviewGroup: "IG", fullName: "Алиев" },
      documents: [],
      enrichment: {
        status: "PENDING",
        profileReady: false,
        documentsReady: false,
        retryAt: null,
      },
    };
    const view = await render(false, undefined);
    expect(mock.request).toHaveBeenCalledWith(
      { candidateId: "c1" },
      expect.anything(),
    );
    expect(view.textContent).toContain("Синхронизация профиля и документов");
    const options = mock.query.mock.calls.at(-1)![2];
    expect(options.query.refetchInterval({ state: { data: mock.data } })).toBe(
      5000,
    );
    expect(
      options.query.refetchInterval({
        state: { data: { enrichment: { status: "READY" } } },
      }),
    ).toBe(false);
  });
  it("does not enqueue complete employees or RU profiles", async () => {
    mock.data = {
      candidate: { id: "c1", reviewGroup: "IG" },
      documents: [],
      enrichment: { status: "READY", profileReady: true, documentsReady: true },
    };
    await render(false, undefined);
    expect(mock.request).not.toHaveBeenCalled();
  });
  it("refreshes RU documents on opening even when an old snapshot exists and no person is linked", async () => {
    mock.data = {
      candidate: {
        id: "c1",
        reviewGroup: "RU",
        erpUid: "erp-ru",
        personUid: null,
        code1c: null,
      },
      documents: [],
      enrichment: { status: "READY", profileReady: true, documentsReady: true },
    };
    await render(false, undefined);
    expect(mock.request).toHaveBeenCalledWith(
      { candidateId: "c1" },
      expect.anything(),
    );
  });
});
