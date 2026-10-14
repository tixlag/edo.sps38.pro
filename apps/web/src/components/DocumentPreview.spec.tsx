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
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DocumentPreview
        documentId="doc-1"
        version={1}
        file={file}
        pageNumber={1}
        fields={fields}
        selectedField={null}
        selectedRegionId={null}
        hoveredField={null}
        onSelectRegion={props.onSelectRegion as never}
        onHoverRegion={props.onHoverRegion as never}
      />,
    );
  });
  const img = container.querySelector("img");
  if (img) {
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
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
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
});
