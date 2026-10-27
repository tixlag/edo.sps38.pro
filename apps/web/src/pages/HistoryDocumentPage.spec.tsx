import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewDocumentPage } from "./ReviewPage";
const state = vi.hoisted(() => ({
  version: 1,
  status: "IN_REVIEW",
  navigate: vi.fn(),
  versionQuery: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({ documentId: "ig-document" }),
  useSearch: () => ({ version: state.version }),
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
}));
vi.mock("@edo/api-client", () => ({
  useGetDocumentInfo: () => ({
    data: {
      candidate: { reviewGroup: "IG", fullName: "Кандидат" },
      title: "Паспорт",
      currentVersion: 3,
      status: "IN_REVIEW",
      pendingDeliveryVersions: [],
    },
  }),
}));
vi.mock("../lib/use-live-document-version", () => ({
  useLiveDocumentVersion: (documentId: string, version: number) => {
    state.versionQuery(documentId, version);
    return {
      data: {
        documentId,
        version,
        status: state.status,
        approvedAt: null,
        rejectionReason: null,
      },
    };
  },
}));
vi.mock("../components/DocumentReviewWorkspace", () => ({
  DocumentReviewWorkspace: (props: {
    readOnly: boolean;
    allowAnnotation: boolean;
    allowAnnotationClaim: boolean;
  }) => {
    state.workspace({
      readOnly: props.readOnly,
      allowAnnotation: props.allowAnnotation,
      allowAnnotationClaim: props.allowAnnotationClaim,
    });
    return <div data-readonly={String(props.readOnly)}>Просмотр документа</div>;
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
  state.version = 1;
  state.status = "IN_REVIEW";
});
async function render(readOnly = true) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<ReviewDocumentPage readOnly={readOnly} />),
  );
  return container;
}
describe("read-only history document detail", () => {
  it.each([1, 3])(
    "loads the exact URL version %s in read-only mode, including current versions",
    async (version) => {
      state.version = version;
      const view = await render();
      expect(state.versionQuery).toHaveBeenCalledWith("ig-document", version);
      expect(state.workspace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readOnly: true,
          allowAnnotation: false,
          allowAnnotationClaim: false,
        }),
      );
      expect(view.querySelector("a")?.getAttribute("href")).toBe("/history");
    },
  );
  it("keeps version navigation in the history reader instead of a departmental queue", async () => {
    const view = await render();
    const button = [...view.querySelectorAll("button")].find(
      (item) => item.textContent === "Перейти к актуальной версии",
    )!;
    await act(async () => button.click());
    const navigation = state.navigate.mock.calls.at(-1)![0];
    expect(navigation.to).toBe("/history/documents/$documentId");
    expect(navigation.search({ version: 1 })).toEqual({ version: 3 });
    expect(state.workspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
  });
  it.each(["APPROVED", "SIGNED"])(
    "lets the review route finish retained historic %s annotation while keeping business data read-only",
    async (status) => {
      state.status = status;
      await render(false);
      expect(state.workspace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readOnly: true,
          allowAnnotation: true,
          allowAnnotationClaim: false,
        }),
      );
    },
  );
  it("does not open annotation for a superseded in-review source", async () => {
    await render(false);
    expect(state.workspace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        readOnly: true,
        allowAnnotation: false,
        allowAnnotationClaim: false,
      }),
    );
  });
  it("allows claiming annotation on the current review version", async () => {
    state.version = 3;
    await render(false);
    expect(state.workspace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        readOnly: false,
        allowAnnotation: true,
        allowAnnotationClaim: true,
      }),
    );
  });
  it.each(["APPROVED", "SIGNED"])(
    "keeps retained %s annotation closed on the history route",
    async (status) => {
      state.status = status;
      await render();
      expect(state.workspace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readOnly: true,
          allowAnnotation: false,
          allowAnnotationClaim: false,
        }),
      );
    },
  );
});
