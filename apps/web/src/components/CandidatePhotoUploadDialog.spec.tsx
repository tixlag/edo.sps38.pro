import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CandidatePhotoUploadDialog } from "./CandidatePhotoUploadDialog";

const mock = vi.hoisted(() => ({
  uploadMutate: vi.fn(),
  invalidateQueries: vi.fn(),
  mutationError: null as unknown,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mock.invalidateQueries }),
}));

vi.mock("@edo/api-client", () => ({
  useUploadCandidatePhoto: ({
    mutation,
  }: {
    mutation?: {
      onSuccess?: (data: { photoPath: string }) => void;
      onError?: (err: unknown) => void;
    };
  }) => {
    return {
      mutate: (args: unknown) => {
        mock.uploadMutate(args);
        if (mock.mutationError) {
          mutation?.onError?.(mock.mutationError);
        } else {
          mutation?.onSuccess?.({ photoPath: "/api/v1/candidates/c1/photo?v=123" });
        }
      },
      isPending: false,
    };
  },
  getGetCandidateWorkspaceQueryKey: (id: string) => ["workspace", id],
  getGetCandidateDetailsQueryKey: (id: string) => ["details", id],
  getGetCandidatePhotoQueryKey: (id: string) => ["photo", id],
  getListCandidatesQueryKey: () => ["/api/v1/candidates"],
  getListCandidateReviewQueueQueryKey: () => ["/api/v1/candidate-review-queue"],
  getListReviewCandidatesQueryKey: () => ["/api/v1/review-candidates"],
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = vi.fn();
HTMLDialogElement.prototype.close = vi.fn();

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Mock URL.createObjectURL and revokeObjectURL
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-url");
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("CandidatePhotoUploadDialog", () => {
  it("does not render when isOpen is false", async () => {
    await act(async () => {
      root?.render(
        <CandidatePhotoUploadDialog
          candidateId="c1"
          isOpen={false}
          onClose={vi.fn()}
        />,
      );
    });

    expect(container?.querySelector("dialog")).toBeNull();
  });

  it("renders upload interface when isOpen is true", async () => {
    await act(async () => {
      root?.render(
        <CandidatePhotoUploadDialog
          candidateId="c1"
          fullName="Тестовый Кандидат"
          isOpen={true}
          onClose={vi.fn()}
        />,
      );
    });

    expect(container?.textContent).toContain("Фотография кандидата");
    expect(container?.textContent).toContain("Тестовый Кандидат");
    expect(container?.textContent).toContain("Нажмите для выбора или перетащите фото сюда");
  });

  it("validates file size (max 10MB)", async () => {
    await act(async () => {
      root?.render(
        <CandidatePhotoUploadDialog
          candidateId="c1"
          isOpen={true}
          onClose={vi.fn()}
        />,
      );
    });

    const fileInput = container?.querySelector("input[type='file']") as HTMLInputElement;
    const oversizedFile = new File(["a".repeat(100)], "big.png", { type: "image/png" });
    Object.defineProperty(oversizedFile, "size", { value: 11 * 1024 * 1024 });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [oversizedFile] });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container?.textContent).toContain("Размер файла превышает допустимые 10 МБ");
  });

  it("selects valid image and allows submitting", async () => {
    const onSuccess = vi.fn();
    await act(async () => {
      root?.render(
        <CandidatePhotoUploadDialog
          candidateId="c1"
          isOpen={true}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />,
      );
    });

    const fileInput = container?.querySelector("input[type='file']") as HTMLInputElement;
    const validFile = new File(["image-bytes"], "avatar.webp", { type: "image/webp" });
    Object.defineProperty(validFile, "size", { value: 500 * 1024 });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [validFile] });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container?.querySelector("img[alt='Предпросмотр']")).not.toBeNull();

    const saveButton = Array.from(container?.querySelectorAll("button") || []).find(
      (btn) => btn.textContent?.includes("Сохранить"),
    );
    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton?.click();
    });

    expect(mock.uploadMutate).toHaveBeenCalledWith({
      candidateId: "c1",
      data: { file: validFile },
    });
    expect(onSuccess).toHaveBeenCalledWith("/api/v1/candidates/c1/photo?v=123");
  });

  it("displays friendly Russian error message when 1C photo upload fails with PHOTO_UPLOAD_FAILED", async () => {
    mock.mutationError = {
      response: {
        data: {
          message: "Не удалось сохранить фотографию в 1С. Попробуйте ещё раз",
        },
      },
    };

    await act(async () => {
      root?.render(
        <CandidatePhotoUploadDialog
          candidateId="c1"
          isOpen={true}
          onClose={vi.fn()}
        />,
      );
    });

    const fileInput = container?.querySelector("input[type='file']") as HTMLInputElement;
    const validFile = new File(["image-bytes"], "avatar.webp", { type: "image/webp" });
    Object.defineProperty(validFile, "size", { value: 500 * 1024 });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [validFile] });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveButton = Array.from(container?.querySelectorAll("button") || []).find(
      (btn) => btn.textContent?.includes("Сохранить"),
    );
    await act(async () => {
      saveButton?.click();
    });

    expect(container?.textContent).toContain("Не удалось сохранить фотографию в 1С. Попробуйте ещё раз");
    mock.mutationError = null;
  });
});
