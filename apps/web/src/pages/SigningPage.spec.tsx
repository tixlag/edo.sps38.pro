import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SigningPage, MyDocumentsPage } from "./SigningPage";

const state = vi.hoisted(() => ({
  search: {} as Record<string, string>,
  navigate: vi.fn(),
  invalidate: vi.fn(),
  create: vi.fn(),
  send: vi.fn(),
  confirm: vi.fn(),
  decline: vi.fn(),
  upload: vi.fn(),
  doc: {} as Record<string, unknown>,
  code1c: "employee-1",
  typesFailed: false,
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state.search,
  useNavigate: () => state.navigate,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("@edo/api-client", () => {
  const result = (data: unknown) => ({
    data,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
  return {
    useGetMe: () => result({ uuid: "hr-1", code1c: state.code1c }),
    useGetSigningCandidate: () =>
      result({
        id: "candidate-1",
        fullName: "Тестовый Сотрудник",
        birthDate: "1990-03-15",
        code1c: "employee-1",
      }),
    useListSigningDocumentTypes: () => ({
      ...result({
        items: [
          {
            code: "from_zup",
            name: "Форма из ЗУП",
            source_object: "Справочник.Сотрудники",
          },
        ],
      }),
      isError: state.typesFailed,
      data: state.typesFailed
        ? undefined
        : { items: [{ code: "from_zup", name: "Форма из ЗУП" }] },
    }),
    useListSigningContracts: () => result({ items: [] }),
    useListMySigningContracts: () => result({ items: [state.doc] }),
    useGetSigningContract: () => result(state.doc),
    useGetMySigningContract: () => result(state.doc),
    useCreateSigningContract: () => ({
      mutateAsync: state.create,
      isPending: false,
    }),
    useSendSigningContract: () => ({
      mutateAsync: state.send,
      isPending: false,
    }),
    useConfirmMySigningContract: () => ({
      mutateAsync: state.confirm,
      isPending: false,
    }),
    useDeclineMySigningContract: () => ({
      mutateAsync: state.decline,
      isPending: false,
    }),
    useUploadSigningContractFile: () => ({
      mutateAsync: state.upload,
      isPending: false,
    }),
    getListSigningContractsQueryKey: (params: unknown) => [
      "/api/contracts",
      params,
    ],
    getGetSigningContractQueryKey: (id: string) => ["/api/contracts", id],
    getListMySigningContractsQueryKey: () => ["/api/my/contracts"],
    getGetMySigningContractQueryKey: (id: string) => ["/api/my/contracts", id],
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  state.search = { contractId: "contract-1" };
  state.code1c = "employee-1";
  state.typesFailed = false;
  state.doc = {
    id: "contract-1",
    candidateId: "candidate-1",
    fullName: "Тестовый Сотрудник",
    birthDate: "1990-03-15",
    code1c: "employee-1",
    documentType: "from_zup",
    documentTypeName: "Форма из ЗУП",
    status: "WAITING_EMPLOYEE",
    revision: 2,
    version: 1,
    hasFile: true,
    filename: "contract.pdf",
    createdBy: "hr-1",
    sentBy: "hr-1",
    createdAt: "2026-10-30T00:00:00Z",
    sentAt: "2026-10-30T00:00:00Z",
    completedAt: null,
    errorMessage: null,
    confirmations: [],
    previewUrl: "https://s3.example/contract.pdf",
    downloadUrl: "https://s3.example/download",
    originalDownloadUrl: null,
    journalDownloadUrl: null,
  };
  state.create.mockResolvedValue({ ...state.doc, id: "new-contract" });
  state.send.mockResolvedValue(state.doc);
  state.confirm.mockResolvedValue(state.doc);
  state.decline.mockResolvedValue(state.doc);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(own = false) {
  await act(async () =>
    root.render(own ? <MyDocumentsPage /> : <SigningPage />),
  );
}
async function click(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (item) =>
      item.textContent?.trim() === label ||
      item.getAttribute("aria-label") === label,
  );
  expect(element, label).toBeDefined();
  await act(async () => element!.click());
}
describe("real document signing flow with simulated signatures", () => {
  it("selects a bank without confirming until the explicit final action", async () => {
    await render(true);
    await click("Подписать");
    expect(container.textContent).toContain("Подтвердите личность");
    expect(
      container.querySelector('img[src="/banks/sber.ico"]'),
    ).not.toBeNull();
    await click("Войти по Сбер ID");
    expect(state.confirm).not.toHaveBeenCalled();
    await click("Подписать документ");
    expect(state.confirm).toHaveBeenCalledWith({
      id: "contract-1",
      data: { revision: 2, bank: "sber", requestId: expect.any(String) },
    });
    expect(container.textContent).toContain("Кадровик получит уведомление");
    expect(container.textContent).not.toContain("Иванов Алексей");
  });
  it("keeps the same idempotency key when retrying a confirmation after a transport failure", async () => {
    state.confirm.mockRejectedValueOnce(new Error("offline"));
    await render(true);
    await click("Подписать");
    await click("Войти по Т-ID");
    await click("Подписать документ");
    expect(container.textContent).toContain("повторите");
    await click("Подписать документ");
    expect(state.confirm.mock.calls[0][0]).toEqual(
      state.confirm.mock.calls[1][0],
    );
  });
  it("requires the employer's certificate confirmation before sending", async () => {
    state.doc.status = "DRAFT";
    await render();
    await click("Подписать и отправить сотруднику");
    expect(state.send).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Усиленная квалифицированная подпись",
    );
    expect(container.textContent).not.toContain("Войти по Сбер ID");
    await click("Подписать и отправить");
    expect(state.send).toHaveBeenCalledOnce();
  });
  it("blocks sending without the canonical employee code", async () => {
    state.doc.status = "DRAFT";
    state.doc.code1c = null;
    await render();
    const send = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Подписать и отправить сотруднику"),
    );
    expect(send?.disabled).toBe(true);
    expect(container.textContent).toContain("code1c");
  });
  it("creates a draft using the selected code returned by ZUP", async () => {
    state.search = { candidateId: "candidate-1" };
    await render();
    await click("Сформировать договор");
    expect(state.create).toHaveBeenCalledWith({
      data: {
        candidateId: "candidate-1",
        documentType: "from_zup",
        manual: false,
        requestId: expect.any(String),
      },
    });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/signing",
      search: { candidateId: "candidate-1", contractId: "new-contract" },
    });
  });
  it("allows a manual draft when ZUP types are unavailable", async () => {
    state.search = { candidateId: "candidate-1" };
    state.typesFailed = true;
    await render();
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => checkbox.click());
    await click("Создать черновик");
    expect(state.create.mock.calls[0][0].data).toMatchObject({
      documentType: "manual",
      manual: true,
    });
  });
  it("keeps the reader stable during polling and refreshes it for a new version", async () => {
    await render(true);
    const iframe = () => container.querySelector("iframe")!;
    const firstUrl = iframe().getAttribute("src");
    state.doc = { ...state.doc, previewUrl: "https://s3.example/renewed.pdf" };
    await render(true);
    expect(iframe().getAttribute("src")).toBe(firstUrl);
    await click("Обновить просмотр");
    expect(iframe().getAttribute("src")).toBe("https://s3.example/renewed.pdf");
    state.doc = {
      ...state.doc,
      version: 2,
      previewUrl: "https://s3.example/version-2.pdf",
    };
    await render(true);
    expect(iframe().getAttribute("src")).toBe(
      "https://s3.example/version-2.pdf",
    );
  });

  it("does not allow replacing an already sent version", async () => {
    await render();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});
