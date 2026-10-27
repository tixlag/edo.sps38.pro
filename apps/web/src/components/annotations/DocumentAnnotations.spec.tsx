import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentVersionDto } from "@edo/api-client";
import { DocumentAnnotations } from "./DocumentAnnotations";
const state = vi.hoisted(() => ({
  enabled: true,
  existing: true,
  claim: vi.fn(),
  preference: vi.fn(),
  catalogs: [
    {
      id: "fallback",
      profile: "OTHER",
      version: 99,
      status: "PUBLISHED",
      title: "Общий",
      fields: [],
    },
    {
      id: "exact",
      profile: "UZ",
      version: 1,
      status: "PUBLISHED",
      title: "Паспорт УЗ",
      fields: [],
    },
  ],
}));
vi.mock("@edo/api-client", () => ({
  getGetAnnotationSourcesQueryKey: () => ["sources"],
  getListAnnotationCatalogsQueryKey: () => ["catalogs"],
  useGetAnnotationPreference: () => ({
    data: { enabled: state.enabled },
    refetch: vi.fn(),
  }),
  useSetAnnotationPreference: () => ({ mutateAsync: state.preference }),
  useGetAnnotationSources: () => ({
    data: { documentTypeCode: "passport", profile: "UZ" },
  }),
  useListAnnotations: () => ({
    data: { items: state.existing ? [{ id: "a", revision: 1 }] : [] },
    refetch: vi.fn(),
  }),
  useListAnnotationCatalogs: () => ({ data: { items: state.catalogs } }),
  useClaimAnnotation: () => ({ mutateAsync: state.claim }),
}));
vi.mock("./AnnotationEditor", () => ({
  AnnotationEditor: ({ active }: { active: boolean }) => (
    <div data-active={active}>
      <input aria-label="Черновик разметки" defaultValue="" />
    </div>
  ),
}));
const documentData = {
  documentId: "doc",
  version: 1,
  status: "APPROVED",
  files: [],
} as unknown as DocumentVersionDto;
describe("annotation availability and explicit variant", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    state.enabled = true;
    state.existing = true;
    vi.clearAllMocks();
  });
  it("keeps an unsaved draft mounted regardless of retired participation preference", async () => {
    const div = document.createElement("div"),
      root = createRoot(div);
    const render = () =>
      act(() => root.render(<DocumentAnnotations document={documentData} />));
    render();
    try {
      const input = div.querySelector<HTMLInputElement>(
        '[aria-label="Черновик разметки"]',
      )!;
      input.value = "Несохранённая строка";
      state.enabled = false;
      render();
      expect(div.querySelector('[aria-label="Черновик разметки"]')).toBe(input);
      expect(
        div.querySelector("[data-active]")?.getAttribute("data-active"),
      ).toBe("true");
      state.enabled = true;
      render();
      expect(
        div.querySelector<HTMLInputElement>('[aria-label="Черновик разметки"]')
          ?.value,
      ).toBe("Несохранённая строка");
      expect(
        div.querySelector("[data-active]")?.getAttribute("data-active"),
      ).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });
  it("requires choosing the document variant independently of citizenship", async () => {
    state.existing = false;
    state.claim.mockResolvedValue({ id: "a", revision: 1 });
    const div = document.createElement("div"),
      root = createRoot(div);
    act(() => root.render(<DocumentAnnotations document={documentData} />));
    try {
      expect(div.textContent).not.toContain("Взять разметку");
      const selector = div.querySelector("select")!;
      await act(async () => {
        selector.value = "exact";
        selector.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const take = [...div.querySelectorAll("button")].find(
        (button) => button.textContent === "Взять разметку",
      )!;
      await act(async () => take.click());
      expect(state.claim).toHaveBeenCalledWith({
        data: {
          documentId: "doc",
          version: 1,
          catalogId: "exact",
          sourceKind: "ORIGINAL",
        },
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("opens previously started annotation on a historical version without offering a new claim", () => {
    const div = document.createElement("div"),
      root = createRoot(div);
    act(() =>
      root.render(
        <DocumentAnnotations document={documentData} allowClaim={false} />,
      ),
    );
    try {
      expect(
        div.querySelector('[aria-label="Черновик разметки"]'),
      ).not.toBeNull();
      expect(div.querySelector('[data-active="true"]')).not.toBeNull();
      expect(div.textContent).not.toContain("Взять разметку");
      expect(state.claim).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("never offers a new historical claim when no annotation exists", () => {
    state.existing = false;
    const div = document.createElement("div"),
      root = createRoot(div);
    act(() =>
      root.render(
        <DocumentAnnotations document={documentData} allowClaim={false} />,
      ),
    );
    try {
      expect(div.textContent).toContain(
        "Для этой исторической версии нет начатой разметки",
      );
      expect(div.textContent).not.toContain("Взять разметку");
      expect(state.claim).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
