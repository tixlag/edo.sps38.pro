import { useEffect, useState } from "react";
import { Camera, X } from "lucide-react";
import { candidateInitials } from "../lib/review-groups";

export interface CandidateAvatarProps {
  candidateId?: string | null;
  fullName?: string | null;
  photoPath?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
  editable?: boolean;
  onUploadClick?: () => void;
  allowEnlarge?: boolean;
}

const SIZE_CLASSES = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-base",
  xl: "h-20 w-20 text-xl",
};

const CAMERA_ICON_SIZES = {
  xs: 10,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
};

export function CandidateAvatar({
  candidateId,
  fullName,
  photoPath,
  size = "md",
  className = "",
  editable = false,
  onUploadClick,
  allowEnlarge = false,
}: CandidateAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [isEnlarged, setIsEnlarged] = useState(false);

  // Derive photo URL
  const isDirectUrl =
    typeof photoPath === "string" &&
    (photoPath.startsWith("/api/") || photoPath.startsWith("http://") || photoPath.startsWith("https://"));

  const photoUrl = isDirectUrl
    ? photoPath
    : candidateId
      ? `/api/v1/candidates/${candidateId}/photo?size=${size === "lg" || size === "xl" ? "full" : "thumb"}`
      : null;

  const fullPhotoUrl = candidateId
    ? `/api/v1/candidates/${candidateId}/photo?size=full${photoPath?.includes("?v=") ? `&v=${photoPath.split("?v=")[1]}` : ""}`
    : photoUrl;

  useEffect(() => {
    setImgError(false);
  }, [photoPath, candidateId]);

  const showImage = Boolean(photoUrl && !imgError);

  const handleAvatarClick = () => {
    if (allowEnlarge && showImage) {
      setIsEnlarged(true);
    }
  };

  return (
    <>
      <div
        className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--avatar)] font-semibold text-[var(--foreground)] select-none ${
          SIZE_CLASSES[size]
        } ${allowEnlarge && showImage ? "cursor-pointer" : ""} ${className}`}
        onClick={handleAvatarClick}
        title={allowEnlarge && showImage ? "Нажмите для увеличения" : undefined}
      >
        <span aria-hidden className="uppercase leading-none">
          {candidateInitials(fullName)}
        </span>

        {showImage && (
          <img
            src={photoUrl!}
            alt={fullName ? `Фото: ${fullName}` : "Фото кандидата"}
            loading="lazy"
            onError={() => setImgError(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}

        {editable && onUploadClick && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUploadClick();
            }}
            aria-label="Сменить фото кандидата"
            title="Сменить фото кандидата"
            className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 focus:outline-none"
          >
            <Camera size={CAMERA_ICON_SIZES[size]} aria-hidden />
          </button>
        )}
      </div>

      {isEnlarged && fullPhotoUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={fullName ? `Фото кандидата: ${fullName}` : "Фото кандидата"}
          onClick={() => setIsEnlarged(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl bg-[var(--card)] p-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsEnlarged(false)}
              aria-label="Закрыть"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
            >
              <X size={18} />
            </button>
            <img
              src={fullPhotoUrl}
              alt={fullName ? `Фото: ${fullName}` : "Фото кандидата"}
              className="max-h-[85vh] max-w-[85vw] rounded-xl object-contain"
            />
            {fullName && (
              <p className="mt-2 text-center text-xs font-medium text-[var(--muted-foreground)]">
                {fullName}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
