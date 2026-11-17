import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewerDocumentUpload } from "./ReviewerDocumentUpload";

type QueryState = {
  data: {
    items?: {
      code: string;
      title: string;
      multipleInstancesAllowed: boolean;
    }[];
    documents: {
      id: string;
      documentTypeCode: string;
      status: string;
      currentVersion: number;
    }[];
  };
  refetch: ReturnType<typeof vi.fn>;
  isError?: boolean;
};
const api = vi.hoisted(() => ({
  catalog: {} as QueryState,
  details: {} as QueryState,
  upload: { mutate: vi.fn() },
}));
vi.mock("@edo/api-client", async (original) => ({
  ...(await original<typeof import("@edo/api-client")>()),
  useListReviewerCandidateDocumentTypes: () => api.catalog,
  useGetCandidateDetails: () => api.details,
  useUploadReviewerCandidateDocument: () => api.upload,
  useGetDocumentVersion: (id: string) => ({
    data: {
      fields: [{ name: "number", value: id === "one" ? "Д-123" : "Д-456" }],
    },
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("reviewer document upload", () => {
  let root: Root;
  let node: HTMLDivElement;
  const render = async () =>
    act(async () =>
      root.render(
        <ReviewerDocumentUpload
          candidateId="candidate"
          onUploaded={vi.fn()}
          onState={vi.fn()}
        />,
      ),
    );
  const change = async (label: string, value: string) =>
    act(async () => {
      const select = node.querySelector(
        `select[aria-label="${label}"]`,
      ) as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const chooseFiles = async (
    files = [new File(["page"], "page.pdf", { type: "application/pdf" })],
  ) =>
    act(async () => {
      const input = node.querySelector('input[type="file"]')!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: files,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const submit = async () =>
    act(async () =>
      node
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  beforeEach(() => {
    api.catalog = {
      data: {
        documents: [],
        items: [
          { code: "diploma", title: "Диплом", multipleInstancesAllowed: true },
          {
            code: "passport",
            title: "Паспорт",
            multipleInstancesAllowed: false,
          },
        ],
      },
      refetch: vi.fn(),
    };
    api.details = { data: { documents: [] }, refetch: vi.fn() };
    api.upload = { mutate: vi.fn() };
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  it("uploads the first document without asking for a mode", async () => {
    await render();
    await change("Вид документа", "diploma");
    await chooseFiles();
    expect(
      node.querySelector('[aria-label="Действие с документом"]'),
    ).toBeNull();
    await submit();
    expect(api.upload.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mode: "replace",
          documentTypeCode: "diploma",
        }),
      }),
      expect.anything(),
    );
  });
  it("selects a distinguishable instance before append, replace or a separate document", async () => {
    api.details.data.documents = ["one", "two"].map((id) => ({
      id,
      documentTypeCode: "diploma",
      status: "APPROVED",
      currentVersion: 2,
    }));
    await render();
    await change("Вид документа", "diploma");
    await chooseFiles();
    const target = node.querySelector('[aria-label="Экземпляр документа"]')!;
    const mode = node.querySelector('[aria-label="Действие с документом"]')!;
    expect(target.textContent).toContain("№ Д-123");
    expect(target.textContent).toContain("№ Д-456");
    expect(
      target.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await change("Экземпляр документа", "two");
    await change("Действие с документом", "append");
    await submit();
    expect(api.upload.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentId: "two", mode: "append" }),
      }),
      expect.anything(),
    );
    await change("Действие с документом", "new");
    await submit();
    const data = api.upload.mutate.mock.lastCall![0].data;
    expect(data.mode).toBe("new");
    expect(data.documentId).toBeUndefined();
    await change("Вид документа", "passport");
    expect(node.textContent).not.toContain("Добавить ещё документ");
  });
  it("explains failed details, retries and retains selected files", async () => {
    api.details.isError = true;
    await render();
    await change("Вид документа", "diploma");
    await chooseFiles();
    expect(node.textContent).toContain("Не удалось загрузить сведения");
    expect(
      (node.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await submit();
    expect(api.upload.mutate).not.toHaveBeenCalled();
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((button) => button.textContent === "Повторить запрос документов")!
        .click(),
    );
    expect(api.details.refetch).toHaveBeenCalledOnce();
    api.details.isError = false;
    await render();
    expect(node.textContent).toContain("page.pdf");
    expect(
      (node.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  it("explains locked targets and invalid file limits", async () => {
    api.details.data.documents = [
      {
        id: "one",
        documentTypeCode: "diploma",
        status: "IN_REVIEW",
        currentVersion: 1,
      },
    ];
    await render();
    await change("Вид документа", "diploma");
    await chooseFiles();
    expect(node.textContent).toContain("Выбранный документ уже на проверке");
    await submit();
    expect(api.upload.mutate).not.toHaveBeenCalled();
    await change("Действие с документом", "new");
    const oversized = new File(["page"], "large.pdf");
    Object.defineProperty(oversized, "size", { value: 11 * 1024 * 1024 });
    await chooseFiles([oversized]);
    expect(node.textContent).toContain("Один из файлов больше 10 МиБ");
    await submit();
    expect(api.upload.mutate).not.toHaveBeenCalled();
  });
});
