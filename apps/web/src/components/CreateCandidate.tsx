import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@edo/ui";
import {
  getListCommunicationCandidatesQueryKey,
  getListCandidateReviewQueueQueryKey,
  useCreateCandidate,
  useOpenExistingCandidate,
  useUploadCandidatePhoto,
  type CandidatePatchFieldsDto,
  type CandidateWorkspaceDto,
} from "@edo/api-client";
import { CandidateAvatar } from "./CandidateAvatar";
import {
  CandidateForm,
  candidateError,
  useCandidateRequest,
} from "./CandidateForm";

export function CreateCandidate({ onCancel }: { onCancel: () => void }) {
  const create = useCreateCandidate();
  const open = useOpenExistingCandidate();
  const upload = useUploadCandidatePhoto();
  const [openError, setOpenError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState("");
  const [created, setCreated] = useState<CandidateWorkspaceDto | null>(null);
  const [existing, setExisting] = useState<CandidateWorkspaceDto | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const request = useCandidateRequest();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pending =
    create.isPending || open.isPending || request.checking || upload.isPending;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);
  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const confirmed = async (candidate: CandidateWorkspaceDto) => {
    await Promise.all([
      cache.invalidateQueries({
        queryKey: getListCommunicationCandidatesQueryKey(),
      }),
      cache.invalidateQueries({
        queryKey: getListCandidateReviewQueueQueryKey(),
      }),
    ]);
    void navigate({
      to: "/review/candidates/$candidateId",
      params: { candidateId: candidate.id },
      search: { section: "profile" },
    });
  };
  const uploadAndOpen = async (
    candidate: CandidateWorkspaceDto,
    isExisting = false,
  ) => {
    if (photo) {
      setPhotoError("");
      try {
        await upload.mutateAsync({
          candidateId: candidate.id,
          data: { file: photo },
        });
      } catch {
        if (isExisting) setExisting(candidate);
        else setCreated(candidate);
        setPhotoError(
          isExisting
            ? "Не удалось заменить фотографию. Повторите загрузку или откройте карточку без замены фото."
            : "Кандидат создан, но фотографию загрузить не удалось. Повторите загрузку или откройте карточку и добавьте фото позже.",
        );
        return;
      }
    }
    await confirmed(candidate);
  };
  const submit = (
    fields: CandidatePatchFieldsDto,
    personSelection?: string,
    ignoredSelections?: string[],
  ) => {
    const data = {
      requestId: request.requestId,
      fields: {
        ...fields,
        fullName: fields.fullName ?? "",
        phone: fields.phone ?? "",
        birthDate: fields.birthDate ?? "",
      },
      ...(personSelection ? { personSelection } : {}),
      ...(ignoredSelections?.length ? { ignoredSelections } : {}),
    };
    void request.execute(() => create.mutateAsync({ data }), uploadAndOpen);
  };
  const openCandidate = async (erpUid: string) => {
    setOpenError("");
    try {
      const candidate = await open.mutateAsync({ data: { erpUid } });
      if (photo) {
        setPhotoError("");
        setExisting(candidate);
      } else await confirmed(candidate);
    } catch (cause) {
      setOpenError(candidateError(cause));
    }
  };
  const selectPhoto = (file: File | undefined) => {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (file.size > 10 * 1024 * 1024) {
      setPhotoError("Размер файла превышает допустимые 10 МБ.");
    } else if (
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
      ].includes(file.type) &&
      !["heic", "heif"].includes(extension ?? "")
    ) {
      setPhotoError("Разрешены только JPG, PNG, WebP и HEIC.");
    } else {
      setPhotoError("");
      setPhoto(file);
    }
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="create-candidate-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending && !request.locked) onCancel();
      }}
      className="fixed inset-0 m-auto max-h-[90vh] w-[min(920px,calc(100vw-2rem))] max-w-none overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--foreground)] shadow-2xl backdrop:bg-black/50"
    >
      <div className="p-6">
        <h2 id="create-candidate-title" className="mb-2 text-lg font-semibold">
          Создать кандидата
        </h2>
        {existing ? (
          <div className="space-y-4 pt-4">
            <p className="text-sm">
              Открыть карточку «{existing.fullName}» с выбранной фотографией?
              Применение заменит фотографию в карточке.
            </p>
            {photoError && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {photoError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={upload.isPending}
                onClick={() => void uploadAndOpen(existing, true)}
              >
                {upload.isPending
                  ? "Загрузка…"
                  : photoError
                    ? "Повторить загрузку фото"
                    : "Применить выбранное фото"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={upload.isPending}
                onClick={() => void confirmed(existing)}
              >
                Открыть без замены фото
              </Button>
            </div>
          </div>
        ) : created ? (
          <div className="space-y-4 pt-4">
            <p role="alert" className="text-sm text-[var(--danger)]">
              {photoError}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={upload.isPending}
                onClick={() => void uploadAndOpen(created)}
              >
                {upload.isPending ? "Загрузка…" : "Повторить загрузку фото"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={upload.isPending}
                onClick={() => void confirmed(created)}
              >
                Открыть карточку
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-[var(--muted-foreground)]">
              Укажите ФИО, телефон и дату рождения, затем проверьте совпадения.
              Остальные данные можно заполнить сейчас или позже.
            </p>
            <CandidateForm
              pending={pending}
              locked={request.locked}
              retryBlocked={request.blocked}
              error={request.error || openError}
              onSubmit={submit}
              onOpenCandidate={(id) => void openCandidate(id)}
              onCancel={onCancel}
              creationPhoto={
                <div className="flex items-center gap-3">
                  {preview ? (
                    <img
                      src={preview}
                      alt="Предпросмотр фотографии кандидата"
                      className="h-20 w-20 rounded-full object-cover"
                    />
                  ) : (
                    <CandidateAvatar size="xl" />
                  )}
                  <div className="space-y-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending || request.locked}
                      onClick={() => photoInputRef.current?.click()}
                    >
                      {photo ? "Изменить фото" : "Добавить фото"}
                    </Button>
                    {photo && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending || request.locked}
                        onClick={() => {
                          setPhoto(null);
                          setPhotoError("");
                        }}
                      >
                        Удалить
                      </Button>
                    )}
                    <p className="text-xs text-[var(--muted-foreground)]">
                      JPG, PNG, WebP или HEIC до 10 МБ
                    </p>
                    {photoError && (
                      <p role="alert" className="text-sm text-[var(--danger)]">
                        {photoError}
                      </p>
                    )}
                  </div>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                    className="hidden"
                    onChange={(event) => selectPhoto(event.target.files?.[0])}
                  />
                </div>
              }
            />
          </>
        )}
      </div>
    </dialog>
  );
}
