import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { DocumentFieldDto, DocumentFileDto } from "@edo/api-client";
import { DocumentPreview } from "./DocumentPreview";

vi.mock("@edo/api-client", () => ({
  getGetDocumentFileDownloadQueryKey: () => ["file-download"],
  useGetDocumentFileDownload: () => ({
    data: { url: "blob:fake-preview" },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 900 * scale,
        }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      }),
    }),
    destroy: async () => undefined,
  }),
}));

const G = globalThis as unknown as Record<string, unknown>;
G.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const file = {
  id: "file-1",
  ordinal: 0,
  filename: "scan1.png",
  mimeType: "image/png",
  sizeBytes: 10,
  pageCount: 2,
  deleted: false,
} as unknown as DocumentFileDto;

const fields = [
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
] as unknown as DocumentFieldDto[];

function renderPreview(props: {
  onSelectRegion: (name: string, region: unknown) => void;
  onHoverRegion: (name: string | null, region: unknown) => void;
  file?: DocumentFileDto;
  selectedRegionId?: string;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DocumentPreview
        documentId="doc-1"
        version={1}
        file={props.file ?? file}
        pageNumber={1}
        fields={fields}
        selectedField={null}
        selectedRegionId={props.selectedRegionId ?? null}
        hoveredField={null}
        onSelectRegion={props.onSelectRegion as never}
        onHoverRegion={props.onHoverRegion as never}
      />,
    );
  });
  const img = container.querySelector("img");
  if (img) {
    Object.defineProperties(img, {
      naturalWidth: { value: 600 },
      naturalHeight: { value: 900 },
    });
    act(() => {
      img.dispatchEvent(new Event("load", { bubbles: false }));
    });
  }
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

describe("DocumentPreview hover vs select", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    HTMLElement.prototype.scrollTo = vi.fn();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  it("hover области зовёт onHoverRegion и НЕ зовёт onSelectRegion", () => {
    const onSelectRegion = vi.fn();
    const onHoverRegion = vi.fn();
    const { container, cleanup } = renderPreview({
      onSelectRegion,
      onHoverRegion,
    });
    try {
      const region = container.querySelector('[data-region="r-last"]');
      expect(region).not.toBeNull();
      act(() => {
        region!.dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
        );
      });
      expect(onHoverRegion).toHaveBeenCalledTimes(1);
      expect(onHoverRegion.mock.calls[0][0]).toBe("last_name");
      expect(onSelectRegion).not.toHaveBeenCalled();
      act(() => {
        region!.dispatchEvent(
          new MouseEvent("mouseout", { bubbles: true, cancelable: true }),
        );
      });
      expect(onHoverRegion).toHaveBeenLastCalledWith(null, null);
      expect(onSelectRegion).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("клик области зовёт onSelectRegion", () => {
    const onSelectRegion = vi.fn();
    const onHoverRegion = vi.fn();
    const { container, cleanup } = renderPreview({
      onSelectRegion,
      onHoverRegion,
    });
    try {
      const region = container.querySelector('[data-region="r-last"]');
      expect(region).not.toBeNull();
      act(() => {
        region!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      expect(onSelectRegion).toHaveBeenCalledTimes(1);
      expect(onSelectRegion.mock.calls[0][0]).toBe("last_name");
    } finally {
      cleanup();
    }
  });

  it("масштаб 75%, 50% и 25% сохраняет OCR и позволяет снова увеличить", () => {
    const { container, cleanup } = renderPreview({
      onSelectRegion: vi.fn(),
      onHoverRegion: vi.fn(),
    });
    try {
      const page = container.querySelector<HTMLElement>("[data-preview-page]")!;
      const minus = container.querySelector<HTMLButtonElement>(
        '[aria-label="Уменьшить превью"]',
      )!;
      const select = container.querySelector<HTMLSelectElement>(
        '[aria-label="Масштаб превью"]',
      )!;
      for (const [level, width] of [
        [0.75, "450px"],
        [0.5, "300px"],
        [0.25, "150px"],
      ] as const) {
        act(() => minus.click());
        expect(select.value).toBe(String(level));
        expect(page.style.width).toBe(width);
        expect(page.querySelector('[data-region="r-last"]')).not.toBeNull();
      }
      expect(minus.disabled).toBe(true);
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Увеличить превью"]')!
          .click(),
      );
      expect(select.value).toBe("0.5");
    } finally {
      cleanup();
    }
  });

  it("поворот меняет размер прокручиваемой страницы и переносит OCR вместе с изображением", () => {
    const onSelectRegion = vi.fn();
    const { container, cleanup } = renderPreview({
      onSelectRegion,
      onHoverRegion: vi.fn(),
      selectedRegionId: "r-last",
    });
    try {
      const page = container.querySelector<HTMLElement>("[data-preview-page]")!;
      const stage = container.querySelector<HTMLElement>(
        "[data-preview-stage]",
      )!;
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Повернуть вправо"]')!
          .click(),
      );
      expect(page.style.transform).toBe("translate(-50%, -50%) rotate(90deg)");
      expect(stage.style.width).toBe("900px");
      expect(stage.style.height).toBe("624px");
      expect(page.querySelector("img")).not.toBeNull();
      const region = page.querySelector('[data-region="r-last"]')!;
      expect(region.getAttribute("x")).toBe("100");
      const scroll = vi.mocked(HTMLElement.prototype.scrollTo).mock
        .lastCall![0] as { left?: number; top?: number };
      expect(scroll.left).toBeCloseTo(787.5);
      expect(scroll.top).toBeCloseTo(132);
      act(() =>
        region.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      expect(onSelectRegion).toHaveBeenCalledWith(
        "last_name",
        expect.objectContaining({ id: "r-last" }),
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Повернуть влево"]')!
          .click(),
      );
      expect(page.style.transform).toBe("translate(-50%, -50%) rotate(0deg)");
      expect(stage.style.width).toBe("600px");
      expect(stage.style.height).toBe("924px");
    } finally {
      cleanup();
    }
  });

  it("PDF-страница поддерживает уменьшение, поворот и отключение OCR", async () => {
    const { container, cleanup } = renderPreview({
      onSelectRegion: vi.fn(),
      onHoverRegion: vi.fn(),
      file: { ...file, filename: "passport.pdf", mimeType: "application/pdf" },
    });
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const page = container.querySelector<HTMLElement>("[data-preview-page]")!;
      expect(page.querySelector("canvas")).not.toBeNull();
      expect(page.querySelector('[data-region="r-last"]')).not.toBeNull();
      const scale = container.querySelector<HTMLSelectElement>(
        '[aria-label="Масштаб превью"]',
      )!;
      act(() => {
        scale.value = "0.5";
        scale.dispatchEvent(new Event("change", { bubbles: true }));
        container
          .querySelector<HTMLButtonElement>('[aria-label="Повернуть влево"]')!
          .click();
      });
      expect(page.style.width).toBe("300px");
      expect(page.style.transform).toBe("translate(-50%, -50%) rotate(270deg)");
      expect(page.querySelector('[data-region="r-last"]')).not.toBeNull();
      act(() =>
        container
          .querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .click(),
      );
      expect(page.querySelector('[data-region="r-last"]')).toBeNull();
      expect(page.querySelector("canvas")).not.toBeNull();
    } finally {
      cleanup();
    }
  });
});
