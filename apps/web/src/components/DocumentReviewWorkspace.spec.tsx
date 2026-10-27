import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useGetDocumentFileDownload,
  useRetryDocumentOcr,
  useEditDocumentFields,
  useGetDocumentOcrDetails,
  useGetMe,
  type DocumentVersionDto,
} from "@edo/api-client";
import { DocumentReviewWorkspace } from "./DocumentReviewWorkspace";

vi.mock("./annotations/DocumentAnnotations", () => ({
  DocumentAnnotations: ({ allowClaim }: { allowClaim: boolean }) => (
    <div data-annotation-claim={String(allowClaim)}>
      <input aria-label="Черновик разметки" defaultValue="" />
    </div>
  ),
}));

vi.mock("@edo/api-client", () => ({
  useGetMe: vi.fn(() => ({ data: { permissions: { "20002": true } } })),
  useEditDocumentFields: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useGetDocumentOcrDetails: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
  })),
  getGetDocumentOcrDetailsQueryKey: () => ["ocr-details"],
  useApproveDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useRejectDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useSendDocumentToErp: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryDocumentOcr: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useStartDocumentOcr: () => ({ mutate: vi.fn(), isPending: false }),
  getGetDashboardQueryKey: () => ["dashboard"],
  getGetDocumentVersionQueryKey: () => ["version"],
  getListEmployeeDocumentsQueryKey: () => ["employee-docs"],
  getListReviewDocumentsQueryKey: () => ["review-docs"],
  getListCandidateReviewQueueQueryKey: () => ["candidate-review-queue"],
  getGetCandidateDetailsQueryKey: (id: string) => ["candidate", id],
  getGetDocumentFileDownloadQueryKey: () => ["file-download"],
  useGetDocumentFileDownload: vi.fn(() => ({
    data: { url: "blob:fake-preview" },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  })),
}));

const G = globalThis as unknown as Record<string, unknown>;
G.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {};
}

function buildData(): DocumentVersionDto {
  return {
    documentId: "doc-1",
    version: 1,
    status: "IN_REVIEW",
    revision: 3,
    ocrSource: "EXTERNAL",
    files: [
      {
        id: "file-1",
        ordinal: 0,
        filename: "scan1.png",
        mimeType: "image/png",
        sizeBytes: 10,
        pageCount: 2,
        deleted: false,
      },
      {
        id: "file-2",
        ordinal: 1,
        filename: "scan2.png",
        mimeType: "image/png",
        sizeBytes: 10,
        pageCount: 1,
        deleted: false,
      },
    ],
    fields: [
      {
        name: "last_name",
        originalValue: "Иванов",
        value: "Иванов",
        editedBy: null,
        submittedValue: "Иванов",
        label: "Фамилия",
        kind: "text",
        required: true,
        mismatch: false,
        regions: [
          {
            id: "r-last",
            fileId: "file-1",
            fileOrdinal: 0,
            pageNumber: 1,
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.05,
            text: "Иванов",
          },
        ],
      },
      {
        name: "issued_at",
        originalValue: "2020-01-01",
        value: "2020-01-01",
        editedBy: null,
        submittedValue: "2020-01-01",
        label: "Дата выдачи",
        kind: "date",
        required: true,
        mismatch: true,
        regions: [
          {
            id: "r-date",
            fileId: "file-1",
            fileOrdinal: 0,
            pageNumber: 2,
            x: 0.2,
            y: 0.2,
            width: 0.2,
            height: 0.05,
            text: "2020-01-01",
          },
        ],
      },
      {
        name: "citizenship",
        originalValue: "true",
        value: "true",
        editedBy: null,
        submittedValue: "false",
        label: "Гражданство",
        kind: "boolean",
        required: false,
        mismatch: true,
        regions: [
          {
            id: "r-bool",
            fileId: "file-1",
            fileOrdinal: 0,
            pageNumber: 1,
            x: 0.3,
            y: 0.3,
            width: 0.2,
            height: 0.05,
            text: "РФ",
          },
        ],
      },
      {
        name: "first_name",
        originalValue: "Иван",
        value: "Иван",
        editedBy: null,
        submittedValue: "Иван",
        label: "Имя",
        kind: "text",
        required: true,
        mismatch: false,
        regions: [
          {
            id: "r-first",
            fileId: "file-2",
            fileOrdinal: 1,
            pageNumber: 1,
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.05,
            text: "Иван",
          },
        ],
      },
    ],
    issues: [],
    job: null,
    raw: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    delivery: null,
  } as unknown as DocumentVersionDto;
}

function fireImgLoad(container: Element) {
  const img = container.querySelector("img");
  if (img) {
    act(() => {
      img.dispatchEvent(new Event("load", { bubbles: false }));
    });
  }
}

function renderWorkspace(
  data: DocumentVersionDto,
  options: {
    readOnly?: boolean;
    allowAnnotation?: boolean;
    allowAnnotationClaim?: boolean;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root: Root = createRoot(container);
  const render = (nextData: DocumentVersionDto) =>
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <DocumentReviewWorkspace data={nextData} {...options} />
        </QueryClientProvider>,
      );
    });
  render(data);
  // Превью рендерит области только после ready (img onLoad).
  fireImgLoad(container);
  return {
    container,
    rerender: render,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function mouseOver(element: Element) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
    );
  });
}

function mouseOut(element: Element) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, cancelable: true }),
    );
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

function pageLabel(container: Element): string {
  return (
    Array.from(container.querySelectorAll("span")).find((node) =>
      node.textContent?.startsWith("Страница"),
    )?.textContent ?? ""
  );
}

function typeValue(
  input: HTMLTextAreaElement | HTMLInputElement,
  value: string,
) {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(container: Element) {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Сохранить исправления"),
  )!;
}

describe("DocumentReviewWorkspace hover vs select", () => {
  beforeEach(() => {
    vi.mocked(useGetMe).mockReturnValue({
      data: { permissions: { "20002": true } },
    } as never);
    vi.mocked(useGetDocumentOcrDetails).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    } as never);
    vi.mocked(useRetryDocumentOcr).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as never);
    vi.mocked(useGetDocumentFileDownload).mockClear();
    document.body.innerHTML = "";
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  it("substitutes OCR only in the draft and retains the original yellow mismatch after saving", () => {
    const mutate = vi.fn();
    vi.mocked(useEditDocumentFields).mockReturnValue({
      mutate,
      isPending: false,
    } as never);
    const data = buildData();
    Object.assign(data.fields[0], {
      submittedValue: "Петров",
      value: "Петров",
      mismatch: true,
    });
    const view = renderWorkspace(data);
    try {
      const row = view.container.querySelector('[data-field-row="last_name"]')!;
      const input = row.querySelector("textarea")!;
      expect(input.value).toBe("Петров");
      click(row.querySelector('[aria-label="Подставить OCR: Фамилия"]')!);
      expect(input.value).toBe("Иванов");
      expect(row.className).toContain("var(--warning-soft)");
      expect(row.textContent).toContain("Кандидат: Петров");
      expect(mutate).not.toHaveBeenCalled();
      click(saveButton(view.container));
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { revision: 3, fields: { last_name: "Иванов" } },
        }),
      );
      view.rerender({
        ...data,
        revision: 4,
        fields: data.fields.map((f, index) =>
          index ? f : { ...f, value: "Иванов", editedBy: "reviewer" },
        ),
      });
      expect(row.className).toContain("var(--warning-soft)");
    } finally {
      view.cleanup();
    }
  });

  it("keeps unformatted OCR dates visible while substituting a valid input date", () => {
    const data = buildData();
    Object.assign(data.fields[1], {
      value: "2019-01-01",
      ocrText: "01.01.2020",
    });
    const view = renderWorkspace(data);
    try {
      const row = view.container.querySelector('[data-field-row="issued_at"]')!;
      expect(row.textContent).toContain("OCR: 01.01.2020");
      click(row.querySelector('[aria-label="Подставить OCR: Дата выдачи"]')!);
      expect(row.querySelector("input")!.value).toBe("2020-01-01");
    } finally {
      view.cleanup();
    }
  });

  it("preserves input, focus and preview settings when live OCR advances the revision", () => {
    const mutate = vi.fn();
    vi.mocked(useEditDocumentFields).mockReturnValue({
      mutate,
      isPending: false,
    } as never);
    const data = buildData();
    data.ocrSource = null;
    data.job = {
      id: "ocr",
      status: "RUNNING",
      errorCode: null,
      cleanupPending: false,
    };
    const view = renderWorkspace(data);
    try {
      click(view.container.querySelector('[aria-label="Уменьшить превью"]')!);
      click(view.container.querySelector('[aria-label="Повернуть вправо"]')!);
      const input = view.container.querySelector<HTMLTextAreaElement>(
        "#field-doc-1-last_name",
      )!;
      typeValue(input, "Проверено сотрудником");
      const next: DocumentVersionDto = {
        ...data,
        revision: 4,
        ocrSource: "EXTERNAL",
        job: { ...data.job, status: "SUCCEEDED" as const },
        fields: data.fields.map((f, i) =>
          i
            ? f
            : {
                ...f,
                originalValue: "OCR прибыл",
                ocrText: "OCR прибыл",
                mismatch: true,
              },
        ),
      };
      view.rerender(next);
      expect(input.value).toBe("Проверено сотрудником");
      expect(document.activeElement).toBe(input);
      expect(view.container.querySelector("#field-doc-1-last_name")).toBe(
        input,
      );
      expect(view.container.textContent).toContain("OCR: OCR прибыл");
      expect(view.container.textContent).toContain("Распознавание завершено");
      expect(view.container.textContent).not.toContain(
        "Документ изменён другим проверяющим",
      );
      expect(
        view.container.querySelector<HTMLSelectElement>(
          '[aria-label="Масштаб превью"]',
        )!.value,
      ).toBe("0.75");
      expect(
        view.container.querySelector<HTMLElement>("[data-preview-page]")!.style
          .transform,
      ).toContain("rotate(90deg)");
      expect(saveButton(view.container).disabled).toBe(false);
      click(saveButton(view.container));
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { revision: 4, fields: { last_name: "Проверено сотрудником" } },
        }),
      );
    } finally {
      view.cleanup();
    }
  });

  it("retains a draft but blocks overwriting another reviewer's changes", () => {
    const data = buildData();
    const view = renderWorkspace(data);
    try {
      const input = view.container.querySelector<HTMLTextAreaElement>(
        "#field-doc-1-last_name",
      )!;
      typeValue(input, "Моя правка");
      view.rerender({
        ...data,
        revision: 4,
        fields: data.fields.map((f, i) =>
          i ? f : { ...f, value: "Чужая правка", editedBy: "other" },
        ),
      });
      expect(input.value).toBe("Моя правка");
      expect(view.container.textContent).toContain(
        "Документ изменён другим проверяющим",
      );
      expect(saveButton(view.container).disabled).toBe(true);
    } finally {
      view.cleanup();
    }
  });

  it("does not offer an empty or unconvertible OCR suggestion", () => {
    const data = buildData();
    Object.assign(data.fields[0], { ocrText: null, originalValue: null });
    Object.assign(data.fields[1], {
      ocrText: "31.02.2026",
      originalValue: null,
    });
    const view = renderWorkspace(data);
    try {
      expect(
        view.container.querySelector('[aria-label="Подставить OCR: Фамилия"]'),
      ).toBeNull();
      expect(view.container.textContent).toContain("OCR: Не распознано");
      expect(view.container.textContent).toContain("OCR: 31.02.2026");
      expect(
        view.container.querySelector(
          '[aria-label="Подставить OCR: Дата выдачи"]',
        ),
      ).toBeNull();
    } finally {
      view.cleanup();
    }
  });

  it("fills missing candidate fields from ready OCR and saves the displayed values", () => {
    const mutate = vi.fn();
    vi.mocked(useEditDocumentFields).mockReturnValue({
      mutate,
      isPending: false,
    } as never);
    const data = buildData();
    Object.assign(data.fields[0], {
      submittedValue: null,
      value: null,
      originalValue: "Иванов",
      mismatch: false,
    });
    const view = renderWorkspace(data);
    try {
      expect(
        view.container.querySelector<HTMLTextAreaElement>(
          "#field-doc-1-last_name",
        )!.value,
      ).toBe("Иванов");
      expect(view.container.textContent).toContain("Подставлено OCR");
      expect(saveButton(view.container).disabled).toBe(false);
      click(saveButton(view.container));
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { revision: 3, fields: { last_name: "Иванов" } },
        }),
      );
    } finally {
      view.cleanup();
    }
  });

  it("fills untouched inputs on live OCR arrival while preserving an already typed value", () => {
    const data = buildData();
    data.ocrSource = null;
    Object.assign(data.fields[0], {
      submittedValue: null,
      value: null,
      originalValue: null,
    });
    Object.assign(data.fields[3], {
      submittedValue: null,
      value: null,
      originalValue: null,
    });
    const view = renderWorkspace(data);
    try {
      const surname = view.container.querySelector<HTMLTextAreaElement>(
        "#field-doc-1-last_name",
      )!;
      typeValue(surname, "Правка сотрудника");
      view.rerender({
        ...data,
        revision: 4,
        ocrSource: "EXTERNAL",
        fields: data.fields.map((f, i) =>
          i === 0
            ? { ...f, originalValue: "Иванов" }
            : i === 3
              ? { ...f, originalValue: "Иван" }
              : f,
        ),
      });
      expect(surname.value).toBe("Правка сотрудника");
      expect(
        view.container.querySelector<HTMLTextAreaElement>(
          "#field-doc-1-first_name",
        )!.value,
      ).toBe("Иван");
      expect(document.activeElement).toBe(surname);
      expect(saveButton(view.container).disabled).toBe(false);
    } finally {
      view.cleanup();
    }
  });

  it("keeps an intentionally cleared input empty when OCR arrives, including after saving", () => {
    const mutate = vi.fn();
    vi.mocked(useEditDocumentFields).mockReturnValue({
      mutate,
      isPending: false,
    } as never);
    const data = buildData();
    data.ocrSource = null;
    Object.assign(data.fields[0], {
      submittedValue: null,
      value: null,
      originalValue: null,
    });
    const view = renderWorkspace(data);
    try {
      const input = view.container.querySelector<HTMLTextAreaElement>(
        "#field-doc-1-last_name",
      )!;
      typeValue(input, "Временное значение");
      typeValue(input, "");
      const next: DocumentVersionDto = {
        ...data,
        revision: 4,
        ocrSource: "EXTERNAL",
        fields: data.fields.map((f, i) =>
          i ? f : { ...f, originalValue: "Иванов" },
        ),
      };
      view.rerender(next);
      expect(input.value).toBe("");
      expect(saveButton(view.container).disabled).toBe(false);
      click(saveButton(view.container));
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { revision: 4, fields: { last_name: null } },
        }),
      );
      view.cleanup();
      const saved = renderWorkspace({
        ...next,
        revision: 5,
        fields: next.fields.map((f, i) =>
          i ? f : { ...f, value: null, editedBy: "reviewer" },
        ),
      });
      try {
        expect(
          saved.container.querySelector<HTMLTextAreaElement>(
            "#field-doc-1-last_name",
          )!.value,
        ).toBe("");
      } finally {
        saved.cleanup();
      }
    } finally {
      if (view.container.isConnected) view.cleanup();
    }
  });

  it.each(["20010", "20009"])(
    "offers all regions only with %s; disabled by default",
    (rule) => {
      vi.mocked(useGetMe).mockReturnValue({
        data: { permissions: { [rule]: [] } },
      } as never);
      const view = renderWorkspace(buildData());
      try {
        const label = [...view.container.querySelectorAll("label")].find(
          (item) => item.textContent === "Все области OCR",
        )!;
        expect(label).toBeDefined();
        expect(label.querySelector("input")!.checked).toBe(false);
        expect(
          vi.mocked(useGetDocumentOcrDetails).mock.lastCall![2]!.query!.enabled,
        ).toBe(false);
        click(label.querySelector("input")!);
        expect(
          vi.mocked(useGetDocumentOcrDetails).mock.lastCall![2]!.query!.enabled,
        ).toBe(true);
      } finally {
        view.cleanup();
      }
    },
  );
  it("offers OCR retry only when the backend permits it and sends the current revision", () => {
    const data = buildData();
    data.canRetryOcr = false;
    const hidden = renderWorkspace(data);
    expect(hidden.container.textContent).not.toContain("Повторить OCR");
    hidden.cleanup();
    data.canRetryOcr = true;
    const mutate = vi.fn();
    vi.mocked(useRetryDocumentOcr).mockReturnValue({
      mutate,
      isPending: false,
    } as never);
    const shown = renderWorkspace(data);
    try {
      const button = Array.from(
        shown.container.querySelectorAll("button"),
      ).find((node) => node.textContent === "Повторить OCR");
      expect(button).toBeDefined();
      act(() => button!.click());
      expect(mutate).toHaveBeenCalledWith({
        documentId: data.documentId,
        version: data.version,
        data: { revision: data.revision },
      });
    } finally {
      shown.cleanup();
    }
  });
  it("shows returned-version records without requesting files that the API denies", () => {
    const data = buildData();
    data.status = "RETURNED";
    data.rejectionReason = "Обрезан край документа";
    // Cleanup may not have marked the file deleted yet, but the API already denies downloads.
    const { container, cleanup } = renderWorkspace(data);
    try {
      expect(container.textContent).toContain(
        "Файлы возвращённой версии недоступны",
      );
      expect(container.textContent).toContain(
        "Причина возврата: Обрезан край документа",
      );
      expect(container.querySelector("textarea")).toBeNull();
      expect(useGetDocumentFileDownload).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("hides ERP response diagnostics from ordinary reviewers even if old cached data contains them", () => {
    const data = buildData();
    data.delivery = {
      status: "REQUIRES_MANUAL",
      errorCode: "PRIVATE_ERROR",
      attempts: [
        {
          id: "private-attempt",
          actorId: "private",
          startedAt: "2026-10-20T02:05:24.806Z",
          finishedAt: null,
          errorCode: "PRIVATE_ERROR",
          httpStatus: 500,
          responseBody: "PRIVATE_RESPONSE",
          responseTruncated: false,
          responseReadError: null,
        },
      ],
    };
    const { container, cleanup } = renderWorkspace(data);
    try {
      expect(container.textContent).toContain("Требует отправки в ERP");
      expect(container.textContent).not.toContain("PRIVATE_ERROR");
      expect(container.textContent).not.toContain("PRIVATE_RESPONSE");
      expect(container.textContent).not.toContain("История отправок");
    } finally {
      cleanup();
    }
  });

  it("shows the ERP response to admins and retains it as plain text in attempt history", () => {
    vi.mocked(useGetMe).mockReturnValue({
      data: { permissions: { "20009": [] } },
    } as never);
    const data = buildData();
    data.status = "APPROVED";
    data.delivery = {
      status: "REQUIRES_MANUAL",
      errorCode: "ERP_HTTP_400",
      attempts: [
        {
          id: "failed-send",
          actorId: "reviewer",
          startedAt: "2026-10-20T02:05:24.806Z",
          finishedAt: "2026-10-20T02:05:25.731Z",
          errorCode: "ERP_HTTP_400",
          httpStatus: 400,
          responseBody:
            '{"description":"Должность по positionUid не найдена. <script>alert(1)</script>"}',
          responseTruncated: true,
          responseReadError: "ERP_RESPONSE_READ_TIMEOUT",
        },
      ],
    };
    const { container, cleanup } = renderWorkspace(data);
    try {
      expect(container.textContent).toContain("Ответ 1С: HTTP 400");
      expect(container.textContent).toContain(
        "Должность по positionUid не найдена.",
      );
      expect(container.textContent).toContain("Ответ показан не полностью");
      expect(container.textContent).toContain("ERP_RESPONSE_READ_TIMEOUT");
      expect(container.querySelector("script")).toBeNull();
      expect(container.querySelector("details li")?.textContent).toContain(
        "positionUid",
      );
    } finally {
      cleanup();
    }
  });
  it("does not invent a response for historical attempts", () => {
    vi.mocked(useGetMe).mockReturnValue({
      data: { permissions: { "20009": [] } },
    } as never);
    const data = buildData();
    data.delivery = {
      status: "REQUIRES_MANUAL",
      errorCode: "ERP_HTTP_400",
      attempts: [
        {
          id: "old-send",
          actorId: "reviewer",
          startedAt: "2026-10-20T02:05:24.806Z",
          finishedAt: "2026-10-20T02:05:25.731Z",
          errorCode: "ERP_HTTP_400",
          httpStatus: null,
          responseBody: null,
          responseTruncated: false,
          responseReadError: null,
        },
      ],
    };
    const { container, cleanup } = renderWorkspace(data);
    try {
      expect(container.textContent).toContain(
        "Текст ответа для этой попытки не сохранён.",
      );
      expect(container.textContent).not.toContain("Ответ 1С: HTTP");
    } finally {
      cleanup();
    }
  });

  it("скрывает необязательные поля и их OCR-области", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      expect(
        container.querySelector('[data-field-row="citizenship"]'),
      ).toBeNull();
      expect(container.querySelector('[data-region="r-bool"]')).toBeNull();
      expect(container.textContent).toContain("Обязательные поля · 3");
      expect(container.textContent).toContain("Только расхождения (1)");
    } finally {
      cleanup();
    }
  });

  it("в исторической версии оставляет инструменты превью и запрещает правки", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <DocumentReviewWorkspace data={buildData()} readOnly />
        </QueryClientProvider>,
      ),
    );
    try {
      expect(
        container.querySelector('[aria-label="Действия проверки"]'),
      ).toBeNull();
      expect(container.querySelector("textarea")).toBeNull();
      const next = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Далее",
      );
      expect(next?.disabled).toBe(false);
      click(next!);
      expect(pageLabel(container)).toContain("Страница 2 из 2");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it.each(["APPROVED", "SIGNED"] as const)(
    "keeps retained historic %s annotation accessible independently of business editing and OCR permissions",
    (status) => {
      vi.mocked(useGetMe).mockReturnValue({
        data: { permissions: { "20002": [] } },
      } as never);
      const data = { ...buildData(), status };
      const { container, rerender, cleanup } = renderWorkspace(data, {
        readOnly: true,
        allowAnnotation: true,
        allowAnnotationClaim: false,
      });
      try {
        expect(
          container.querySelector('[aria-label="Действия проверки"]'),
        ).toBeNull();
        expect(container.querySelector("textarea")).toBeNull();
        click(
          [...container.querySelectorAll("button")].find(
            (button) => button.textContent === "Разметка строк",
          )!,
        );
        const input = container.querySelector<HTMLInputElement>(
          '[aria-label="Черновик разметки"]',
        )!;
        expect(input).not.toBeNull();
        expect(
          container.querySelector('[data-annotation-claim="false"]'),
        ).not.toBeNull();
        input.value = "Ранее начатая работа";
        rerender({
          ...data,
          revision: data.revision + 1,
          files: data.files.map((file) => ({ ...file, deleted: true })),
        });
        expect(
          container.querySelector<HTMLInputElement>(
            '[aria-label="Черновик разметки"]',
          )?.value,
        ).toBe("Ранее начатая работа");
      } finally {
        cleanup();
      }
    },
  );

  it.each([
    {
      name: "history reader",
      options: { readOnly: true },
      status: "APPROVED",
      permissions: { "20002": [] },
    },
    {
      name: "wrong reviewer group",
      options: { allowAnnotation: true },
      status: "APPROVED",
      permissions: { "20011": [] },
    },
    {
      name: "returned source",
      options: { allowAnnotation: true },
      status: "RETURNED",
      permissions: { "20002": [] },
    },
  ] as const)(
    "does not offer annotation for $name",
    ({ options, status, permissions }) => {
      vi.mocked(useGetMe).mockReturnValue({ data: { permissions } } as never);
      const data = buildData();
      const { container, cleanup } = renderWorkspace(
        { ...data, status },
        options,
      );
      try {
        expect(
          [...container.querySelectorAll("button")].find(
            (button) => button.textContent === "Разметка строк",
          ),
        ).toBeUndefined();
      } finally {
        cleanup();
      }
    },
  );

  it("клик по OCR-области открывает поле, скрытое фильтром расхождений", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      const filter = container.querySelector(
        '[aria-label="Поля документа"] input[type="checkbox"]',
      )!;
      click(filter);
      expect(
        container.querySelector('[data-field-row="last_name"]'),
      ).toBeNull();
      click(container.querySelector('[data-region="r-last"]')!);
      expect(
        container.querySelector('[data-field-row="last_name"]'),
      ).not.toBeNull();
      expect(document.activeElement).toBe(
        container.querySelector("#field-doc-1-last_name"),
      );
    } finally {
      cleanup();
    }
  });

  it("hover справа не меняет страницу/файл и не отнимает фокус, показывает бейдж", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      expect(pageLabel(container)).toContain("Страница 1 из 2");
      const row = container.querySelector('[data-field-row="issued_at"]');
      expect(row).not.toBeNull();
      const before = document.activeElement;
      mouseOver(row!);
      // Страница и файл не переключились: регион issued_at на стр. 2.
      expect(pageLabel(container)).toContain("Страница 1 из 2");
      expect(container.textContent).toContain("Область на стр. 2");
      // Фокус ввода не отнят.
      expect(document.activeElement).toBe(before);
      mouseOut(row!);
      // После mouseLeave страница по-прежнему та же.
      expect(pageLabel(container)).toContain("Страница 1 из 2");
    } finally {
      cleanup();
    }
  });

  it("hover справа в пределах текущей страницы не переключает файл", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      const row = container.querySelector('[data-field-row="first_name"]');
      expect(row).not.toBeNull();
      mouseOver(row!);
      // first_name лежит в file-2, текущий файл file-1 — перехода нет.
      expect(container.textContent).toContain("Файл 1");
      expect(container.textContent).toContain("файл 2");
      expect(pageLabel(container)).toContain("Страница 1 из 2");
    } finally {
      cleanup();
    }
  });

  it("hover слева подсвечивает поле справа без редактирования и смены страницы", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      const region = container.querySelector('[data-region="r-last"]');
      expect(region).not.toBeNull();
      const row = container.querySelector('[data-field-row="last_name"]');
      expect(row).not.toBeNull();
      expect(row!.className).not.toContain("outline");
      mouseOver(region!);
      expect(
        container.querySelector('[data-field-row="last_name"]')!.className,
      ).toContain("outline");
      // Страница не переключилась, фокус не начался.
      expect(pageLabel(container)).toContain("Страница 1 из 2");
      expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
      mouseOut(region!);
    } finally {
      cleanup();
    }
  });

  it("клик слева по текстовому полю фокусит textarea", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      click(container.querySelector('[data-region="r-last"]')!);
      const input = container.querySelector(
        "#field-doc-1-last_name",
      ) as HTMLTextAreaElement | null;
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
    } finally {
      cleanup();
    }
  });

  it("клик слева по дате фокусит input type=date", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      // Дата лежит на стр. 2: сначала явная навигация, затем клик слева.
      const next = Array.from(container.querySelectorAll("button")).find(
        (node) => node.textContent === "Далее",
      );
      expect(next).not.toBeUndefined();
      click(next!);
      expect(pageLabel(container)).toContain("Страница 2 из 2");
      fireImgLoad(container);
      const region = container.querySelector('[data-region="r-date"]');
      expect(region).not.toBeNull();
      click(region!);
      // Явный переход: страница переключилась на стр. 2.
      expect(pageLabel(container)).toContain("Страница 2 из 2");
      const input = container.querySelector(
        "#field-doc-1-issued_at",
      ) as HTMLInputElement | null;
      expect(input?.type).toBe("date");
      expect(document.activeElement).toBe(input);
    } finally {
      cleanup();
    }
  });

  it("клик слева по чекбоксу фокусит input type=checkbox", () => {
    const data = buildData();
    data.fields.find((field) => field.name === "citizenship")!.required = true;
    const { container, cleanup } = renderWorkspace(data);
    try {
      click(container.querySelector('[data-region="r-bool"]')!);
      const input = container.querySelector(
        "#field-doc-1-citizenship",
      ) as HTMLInputElement | null;
      expect(input?.type).toBe("checkbox");
      expect(document.activeElement).toBe(input);
    } finally {
      cleanup();
    }
  });

  it("кнопка «На превью» явно переключает файл/страницу", () => {
    const { container, cleanup } = renderWorkspace(buildData());
    try {
      const row = container.querySelector('[data-field-row="first_name"]')!;
      const button = Array.from(row.querySelectorAll("button")).find((node) =>
        node.textContent?.includes("На превью"),
      );
      expect(button).not.toBeUndefined();
      click(button!);
      expect(container.textContent).toContain("scan2.png");
    } finally {
      cleanup();
    }
  });
});
