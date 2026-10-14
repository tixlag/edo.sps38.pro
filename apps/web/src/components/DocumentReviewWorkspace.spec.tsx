import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentVersionDto } from "@edo/api-client";
import { DocumentReviewWorkspace } from "./DocumentReviewWorkspace";

vi.mock("@edo/api-client", () => ({
  useGetMe: () => ({ data: { permissions: { "20002": true } } }),
  useEditDocumentFields: () => ({ mutate: vi.fn(), isPending: false }),
  useApproveDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useRejectDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useSendDocumentToErp: () => ({ mutate: vi.fn(), isPending: false }),
  getGetDashboardQueryKey: () => ["dashboard"],
  getGetDocumentVersionQueryKey: () => ["version"],
  getListEmployeeDocumentsQueryKey: () => ["employee-docs"],
  getListReviewDocumentsQueryKey: () => ["review-docs"],
  getGetDocumentFileDownloadQueryKey: () => ["file-download"],
  useGetDocumentFileDownload: () => ({
    data: { url: "blob:fake-preview" },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
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

function renderWorkspace(data: DocumentVersionDto) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <DocumentReviewWorkspace data={data} />
      </QueryClientProvider>,
    );
  });
  // Превью рендерит области только после ready (img onLoad).
  fireImgLoad(container);
  return {
    container,
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

describe("DocumentReviewWorkspace hover vs select", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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
