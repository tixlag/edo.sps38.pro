import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, UploadCloud, X } from "lucide-react";
import { Button } from "@edo/ui";
import {
  useUploadCandidatePhoto,
  getGetCandidateWorkspaceQueryKey,
  getGetCandidateDetailsQueryKey,
  getGetCandidatePhotoQueryKey,
  getListCandidatesQueryKey,
  getListCandidateReviewQueueQueryKey,
  getListReviewCandidatesQueryKey,
} from "@edo/api-client";

export interface CandidatePhotoUploadDialogProps {
  candidateId: string;
  fullName?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (photoPath: string) => void;
}

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

export function CandidatePhotoUploadDialog({
  candidateId,
  fullName,
  isOpen,
  onClose,
  onSuccess,
}: CandidatePhotoUploadDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadedSuccess, setUploadedSuccess] = useState(false);

  const uploadMutation = useUploadCandidatePhoto({
    mutation: {
      onSuccess: (data) => {
        setUploadedSuccess(true);
        queryClient.invalidateQueries({
          queryKey: getGetCandidateWorkspaceQueryKey(candidateId),
        });
        queryClient.invalidateQueries({
          queryKey: getGetCandidateDetailsQueryKey(candidateId),
        });
        queryClient.invalidateQueries({
          queryKey: getGetCandidatePhotoQueryKey(candidateId),
        });
        queryClient.invalidateQueries({
          queryKey: getListCandidatesQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListCandidateReviewQueueQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListReviewCandidatesQueryKey(),
        });
        onSuccess?.(data.photoPath);
        setTimeout(() => {
          onClose();
        }, 600);
      },
      onError: (err: unknown) => {
        const errorObj = err as {
          response?: { data?: { message?: string } };
          message?: string;
        } | null;
        let msg =
          errorObj?.response?.data?.message ||
          errorObj?.message ||
          "Не удалось загрузить фотографию. Проверьте формат и размер файла.";
        if (
          typeof msg === "string" &&
          (msg.includes("PHOTO_UPLOAD_FAILED") ||
            msg.includes("ERP_PHOTO_UPLOAD_FAILED") ||
            msg.includes("ERP_OPERATION_RESULT_UNKNOWN"))
        ) {
          msg = "Не удалось сохранить фотографию в 1С. Попробуйте ещё раз";
        }
        setErrorMessage(typeof msg === "string" ? msg : JSON.stringify(msg));
      },
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      setFile(null);
      setPreviewUrl(null);
      setErrorMessage(null);
      setUploadedSuccess(false);
      if (!dialog.open && typeof dialog.showModal === "function") {
        dialog.showModal();
      }
    } else {
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const validateAndSelectFile = (selected: File) => {
    setErrorMessage(null);
    if (selected.size > MAX_BYTES) {
      setErrorMessage("Размер файла превышает допустимые 10 МБ.");
      return;
    }
    const ext = selected.name.split(".").pop()?.toLowerCase();
    const isHeic = ext === "heic" || ext === "heif";
    if (!ACCEPTED_TYPES.includes(selected.type) && !isHeic) {
      setErrorMessage(
        "Недопустимый формат. Разрешены только JPG, PNG, WebP и HEIC.",
      );
      return;
    }
    setFile(selected);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      validateAndSelectFile(selected);
    }
  };

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      validateAndSelectFile(dropped);
    }
  };

  const handleSubmit = async () => {
    if (!file) return;
    setErrorMessage(null);
    uploadMutation.mutate({
      candidateId,
      data: { file },
    });
  };

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-auto max-h-[90vh] w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--foreground)] shadow-2xl backdrop:bg-black/50"
    >
      <div className="flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[var(--foreground)]">
              Фотография кандидата
            </h3>
            {fullName && (
              <p className="truncate text-xs text-[var(--muted-foreground)]">
                {fullName}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Закрыть"
            className="h-8 w-8 p-0"
          >
            <X size={18} />
          </Button>
        </div>

        {/* Content */}
        <div className="space-y-4 p-5">
          {errorMessage && (
            <div className="flex items-start gap-2 rounded-lg bg-[var(--destructive)]/10 p-3 text-xs text-[var(--destructive)]">
              <AlertCircle size={16} className="shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {uploadedSuccess ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-sm">
              <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                <Check size={24} />
              </div>
              <p className="font-medium text-[var(--foreground)]">
                Фотография успешно обновлена!
              </p>
            </div>
          ) : previewUrl ? (
            <div className="flex flex-col items-center gap-3">
              <div className="relative h-44 w-44 overflow-hidden rounded-full border-2 border-[var(--primary)] shadow-md">
                <img
                  src={previewUrl}
                  alt="Предпросмотр"
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  disabled={uploadMutation.isPending}
                >
                  Выбрать другое фото
                </Button>
              </div>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
                isDragging
                  ? "border-[var(--primary)] bg-[var(--primary)]/5"
                  : "border-[var(--border)] hover:border-[var(--muted-foreground)] hover:bg-[var(--muted)]/30"
              }`}
            >
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">
                <UploadCloud size={24} />
              </div>
              <p className="text-sm font-medium text-[var(--foreground)]">
                Нажмите для выбора или перетащите фото сюда
              </p>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                JPG, PNG, WebP или HEIC до 10 МБ
              </p>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Footer */}
        {!uploadedSuccess && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--muted)]/20 px-5 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={uploadMutation.isPending}
            >
              Отмена
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={!file || uploadMutation.isPending}
            >
              {uploadMutation.isPending ? "Загрузка…" : "Сохранить"}
            </Button>
          </div>
        )}
      </div>
    </dialog>
  );
}
