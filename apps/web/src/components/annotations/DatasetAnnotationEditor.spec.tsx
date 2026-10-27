import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AnnotationDto } from "@edo/api-client";
import type { DocumentPreview } from "../DocumentPreview";
import { DatasetAnnotationEditor } from "./DatasetAnnotationEditor";
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  submit: vi.fn(),
  preview: null as unknown,
}));
vi.mock("@edo/api-client", () => ({
  useSaveAnnotation: () => ({ isPending: false, mutateAsync: mocks.save }),
  useSubmitAnnotation: () => ({ isPending: false, mutateAsync: mocks.submit }),
  useAcceptAnnotation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRequestAnnotationChanges: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock("../DocumentPreview", () => ({
  DocumentPreview: (props: unknown) => {
    mocks.preview = props;
    return <div>Оригинал</div>;
  },
}));
const fixture = () =>
  ({
    id: "ann",
    documentId: "document",
    catalogId: "catalog",
    versionId: "version",
    authorId: "author",
    revision: 1,
    status: "DRAFT",
    editable: true,
    sourceKind: "ORIGINAL",
    schema: {
      id: "catalog",
      documentTypeCode: "PASSPORT",
      profile: "CUSTOM",
      title: "Паспорт",
      version: 1,
      revision: 1,
      status: "PUBLISHED",
      sections: [
        {
          key: "main",
          label: "Основной разворот",
          ordinal: 0,
          repeatable: false,
        },
        { key: "stamps", label: "Регистрация", ordinal: 1, repeatable: true },
      ],
      fields: [
        {
          key: "birth_place",
          label: "Место рождения",
          ordinal: 0,
          sectionKey: "main",
          kind: "TEXT",
          multiline: true,
        },
        {
          key: "photo",
          label: "Фотография",
          ordinal: 1,
          sectionKey: "main",
          kind: "PHOTO",
          multiline: false,
        },
        {
          key: "address",
          label: "Адрес",
          ordinal: 2,
          sectionKey: "stamps",
          kind: "TEXT",
          multiline: true,
        },
      ],
    },
    sources: {
      available: true,
      version: 1,
      documentId: "document",
      documentTypeCode: "PASSPORT",
      versionId: "version",
      sourceKind: "ORIGINAL",
      profile: "RU",
      pages: [
        {
          id: "page",
          fileId: "file",
          pageNumber: 1,
          width: 1000,
          height: 800,
          sha256: "hash",
          sizeBytes: 100,
          mimeType: "image/png",
          previewUrl: "https://example.invalid/original",
          rotation: 0,
          renderDpi: 200,
          frame: "UPRIGHT_PIXELS_V1",
        },
      ],
    },
    sections: [
      {
        id: "main",
        sectionKey: "main",
        availability: "PRESENT",
        pageIds: ["page"],
      },
      {
        id: "stamps",
        sectionKey: "stamps",
        availability: "NOT_UPLOADED",
        pageIds: [],
      },
    ],
    fields: [],
    note: null,
    submittedAt: null,
    acceptedAt: null,
  }) as AnnotationDto;
function mount() {
  let annotation = fixture();
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  const onSaved = vi.fn();
  const render = () =>
    act(() =>
      root.render(
        <DatasetAnnotationEditor annotation={annotation} onSaved={onSaved} />,
      ),
    );
  render();
  return {
    div,
    render,
    changeRevision: () => {
      annotation = { ...annotation, revision: 2 };
      render();
    },
    dispose: () => {
      act(() => root.unmount());
      div.remove();
    },
  };
}
function select(div: HTMLElement, label: string, value: string) {
  const node = [...div.querySelectorAll("select")].find((s) =>
    s.closest("label")?.textContent?.startsWith(label),
  )!;
  act(() => {
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function button(div: HTMLElement, label: string) {
  return [...div.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
}
function preview() {
  return (mocks.preview as ComponentProps<typeof DocumentPreview>).annotation!;
}
const polygon = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9];
describe("dataset editor", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.save.mockImplementation(async ({ data }) => ({
      ...fixture(),
      ...data,
      revision: data.revision + 1,
    }));
  });
  it("saves a photo contour and its 180-degree heading without transcription", async () => {
    const view = mount();
    try {
      select(view.div, "Поле документа", "photo");
      act(() =>
        preview().regionLayer!.onCreate({
          id: "photo-region",
          pageId: "page",
          shape: "POLYGON",
          orientationDeg: 0,
          polygon,
        }),
      );
      act(() => button(view.div, "Развернуть на 180°").click());
      expect(button(view.div, "Добавить строку")).toBeUndefined();
      await act(async () => button(view.div, "Сохранить черновик").click());
      const data = mocks.save.mock.calls[0][0].data;
      expect(data.fields[0]).toMatchObject({
        key: "photo",
        instanceId: "main",
        disposition: "PRESENT",
        lines: [],
        regions: [{ orientationDeg: 180, polygon }],
      });
    } finally {
      view.dispose();
    }
  });
  it("keeps separate visual lines and explicitly creates a second registration block", async () => {
    const view = mount();
    try {
      act(() =>
        preview().regionLayer!.onCreate({
          id: "region",
          pageId: "page",
          shape: "POLYGON",
          orientationDeg: 0,
          polygon,
        }),
      );
      act(() => preview().onCreate([0.2, 0.2, 0.7, 0.2, 0.7, 0.3, 0.2, 0.3]));
      act(() => preview().onCreate([0.2, 0.4, 0.7, 0.4, 0.7, 0.5, 0.2, 0.5]));
      select(view.div, "Раздел и экземпляр блока", "stamps");
      act(() => button(view.div, "Добавить блок").click());
      await act(async () => button(view.div, "Сохранить черновик").click());
      const data = mocks.save.mock.calls[0][0].data;
      expect(
        data.fields[0].lines.map((l: { order: number }) => l.order),
      ).toEqual([0, 1]);
      expect(
        data.sections.filter(
          (s: { sectionKey: string }) => s.sectionKey === "stamps",
        ),
      ).toHaveLength(2);
      expect(data.sections[1].availability).toBe("NOT_UPLOADED");
      expect(data.sections[2]).toMatchObject({
        availability: "PRESENT",
        pageIds: ["page"],
      });
    } finally {
      view.dispose();
    }
  });
  it("preserves the local draft and blocks writes after a server revision change", () => {
    const view = mount();
    try {
      act(() =>
        preview().regionLayer!.onCreate({
          id: "region",
          pageId: "page",
          shape: "POLYGON",
          orientationDeg: 270,
          polygon,
        }),
      );
      view.changeRevision();
      expect(view.div.textContent).toContain("Ваши правки остались на экране");
      expect(
        (view.div.querySelector('input[type="number"]') as HTMLInputElement)
          .value,
      ).toBe("270");
      expect(button(view.div, "Сохранить черновик").disabled).toBe(true);
      expect(mocks.save).not.toHaveBeenCalled();
    } finally {
      view.dispose();
    }
  });
});
