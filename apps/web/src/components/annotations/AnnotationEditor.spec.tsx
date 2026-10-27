import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationDto } from "@edo/api-client";
import { AnnotationEditor } from "./AnnotationEditor";
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  submit: vi.fn(),
  accept: vi.fn(),
  changes: vi.fn(),
}));
vi.mock("@edo/api-client", () => ({
  useGetMe: () => ({ data: { uuid: "author" } }),
  useSaveAnnotation: () => ({ isPending: false, mutateAsync: mocks.save }),
  useSubmitAnnotation: () => ({ isPending: false, mutateAsync: mocks.submit }),
  useAcceptAnnotation: () => ({ isPending: false, mutateAsync: mocks.accept }),
  useRequestAnnotationChanges: () => ({
    isPending: false,
    mutateAsync: mocks.changes,
  }),
  useSuggestAnnotationCatalogField: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock("../DocumentPreview", () => ({
  DocumentPreview: () => <div data-source-preview="">Оригинал</div>,
}));
const fixture = {
  id: "a",
  documentId: "doc",
  authorId: "author",
  revision: 1,
  status: "DRAFT",
  editable: true,
  catalogId: "c",
  schema: {
    title: "Паспорт РФ",
    version: 1,
    fields: [{ key: "name", label: "Фамилия", ordinal: 0, multiline: false }],
  },
  sources: {
    available: true,
    version: 1,
    pages: [
      {
        id: "p",
        fileId: "f",
        pageNumber: 1,
        width: 600,
        height: 900,
        mimeType: "image/png",
        sizeBytes: 100,
        previewUrl: "https://private-source.example/original",
      },
    ],
  },
  fields: [
    {
      key: "name",
      disposition: "PRESENT",
      lines: [
        {
          id: "l",
          pageId: "p",
          order: 0,
          text: "ИВАНОВ",
          quad: [0.1, 0.1, 0.3, 0.1, 0.3, 0.15, 0.1, 0.15],
        },
      ],
    },
  ],
  note: null,
} as unknown as AnnotationDto;
function render(annotation = fixture, admin = false) {
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  const saved = vi.fn();
  const rerender = (value: AnnotationDto) =>
    act(() =>
      root.render(
        <AnnotationEditor annotation={value} onSaved={saved} admin={admin} />,
      ),
    );
  rerender(annotation);
  return {
    div,
    saved,
    rerender,
    cleanup: () => {
      act(() => root.unmount());
      div.remove();
    },
  };
}
function button(div: HTMLElement, text: string) {
  return [...div.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  )!;
}
function input(div: HTMLElement, text: string) {
  const element = div.querySelector<HTMLInputElement>(
    '[aria-label="Текст строки 1"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("annotation editor lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  it("retains text after a save conflict and after a live revision refresh", async () => {
    mocks.save.mockRejectedValue({ status: 409 });
    const view = render();
    try {
      input(view.div, "ИВАНОФФ");
      await act(async () => button(view.div, "Сохранить черновик").click());
      expect(view.div.textContent).toContain(
        "Все ваши правки остались на экране",
      );
      expect(
        view.div.querySelector<HTMLInputElement>(
          '[aria-label="Текст строки 1"]',
        )?.value,
      ).toBe("ИВАНОФФ");
      view.rerender({ ...fixture, revision: 2 });
      expect(
        view.div.querySelector<HTMLInputElement>(
          '[aria-label="Текст строки 1"]',
        )?.value,
      ).toBe("ИВАНОФФ");
      expect(button(view.div, "Отправить разметку").disabled).toBe(true);
    } finally {
      view.cleanup();
    }
  });
  it("saves with the draft revision and submits only the resulting revision", async () => {
    mocks.save.mockResolvedValue({ ...fixture, revision: 2 });
    mocks.submit.mockResolvedValue({
      ...fixture,
      revision: 3,
      status: "SUBMITTED",
      editable: false,
    });
    const view = render();
    try {
      input(view.div, "ИВАНОФФ");
      await act(async () => button(view.div, "Отправить разметку").click());
      expect(mocks.save.mock.calls[0][0].data.revision).toBe(1);
      expect(mocks.save.mock.calls[0][0].data.fields[0].lines[0].text).toBe(
        "ИВАНОФФ",
      );
      expect(mocks.submit).toHaveBeenCalledWith({
        id: "a",
        data: { revision: 2 },
      });
    } finally {
      view.cleanup();
    }
  });
  it("allows saving an empty transcript draft while blocking submission", async () => {
    const view = render();
    try {
      input(view.div, "");
      expect(button(view.div, "Сохранить черновик").disabled).toBe(false);
      expect(button(view.div, "Отправить разметку").disabled).toBe(true);
    } finally {
      view.cleanup();
    }
  });
  it("requires a return reason for submitted admin work and keeps accepted work readonly", () => {
    const view = render(
      { ...fixture, status: "SUBMITTED", editable: false },
      true,
    );
    try {
      expect(button(view.div, "Вернуть на доработку").disabled).toBe(true);
      expect(
        view.div.querySelector<HTMLInputElement>(
          '[aria-label="Текст строки 1"]',
        )?.disabled,
      ).toBe(true);
      view.rerender({ ...fixture, status: "ACCEPTED", editable: false });
      expect(button(view.div, "Отправить разметку").disabled).toBe(true);
      expect(view.div.textContent).toContain("Разметка принята");
    } finally {
      view.cleanup();
    }
  });

  it.each(["unavailable", "empty URL"])(
    "blocks original preview and annotation mutations for %s sources while preserving a draft",
    (failure) => {
      const view = render();
      try {
        input(view.div, "Несохранённый текст");
        view.rerender({
          ...fixture,
          sources: {
            ...fixture.sources,
            available: failure !== "unavailable",
            pages: fixture.sources.pages.map((page) => ({
              ...page,
              previewUrl: "",
            })),
          },
        });
        expect(view.div.textContent).toContain("Оригинал недоступен");
        expect(view.div.querySelector("[data-source-preview]")).toBeNull();
        expect(
          view.div.querySelector<HTMLInputElement>(
            '[aria-label="Текст строки 1"]',
          )?.value,
        ).toBe("Несохранённый текст");
        expect(button(view.div, "Сохранить черновик").disabled).toBe(true);
        expect(button(view.div, "Отправить разметку").disabled).toBe(true);
        expect(mocks.save).not.toHaveBeenCalled();
        expect(mocks.submit).not.toHaveBeenCalled();
      } finally {
        view.cleanup();
      }
    },
  );

  it("blocks accepting an unavailable original but lets an administrator return work with a reason", async () => {
    const annotation = {
      ...fixture,
      status: "SUBMITTED" as const,
      editable: false,
      sources: { ...fixture.sources, available: false },
    };
    mocks.changes.mockResolvedValue({
      ...annotation,
      status: "CHANGES_REQUESTED",
    });
    const view = render(annotation, true);
    try {
      expect(button(view.div, "Принять разметку").disabled).toBe(true);
      const note = view.div.querySelector<HTMLTextAreaElement>("textarea")!;
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(note, "Оригинал удалён");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(button(view.div, "Вернуть на доработку").disabled).toBe(false);
      await act(async () => button(view.div, "Вернуть на доработку").click());
      expect(mocks.changes).toHaveBeenCalledWith({
        id: "a",
        data: { revision: 1, note: "Оригинал удалён" },
      });
      expect(mocks.accept).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });
});
