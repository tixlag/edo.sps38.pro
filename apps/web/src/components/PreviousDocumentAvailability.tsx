import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  type PreviousDocumentAvailabilityDto,
} from "@edo/api-client";
import { Badge, Button } from "@edo/ui";
import { CheckCircle2, History as HistoryIcon } from "lucide-react";
import { formatDateRu } from "../lib/date-format";
import { candidateError } from "./CandidateForm";

const presentation = {
  REUSED: {
    label: "Зачтён ранее",
    explanation:
      "Зачтён с прошлого приёма/заезда. Повторная загрузка не требуется.",
    tone: "success",
  },
  EXPIRED: {
    label: "Нужна замена",
    explanation: "Срок действия истёк. Нужно предоставить новый документ.",
    tone: "danger",
  },
  REPLACE_REQUIRED: {
    label: "Нужна замена",
    explanation: "Для текущего оформления нужен новый документ.",
    tone: "warning",
  },
  REQUIRES_REVIEW: {
    label: "Проверить актуальность",
    explanation:
      "Документ предоставлялся ранее; действительность пока не подтверждена.",
    tone: "warning",
  },
  ORIGINAL_UNAVAILABLE: {
    label: "Оригинал недоступен",
    explanation:
      "Есть запись о прежнем документе. Для зачёта нужен доступный оригинал.",
    tone: "warning",
  },
} as const;

export function PreviousDocumentAvailability({
  candidateId,
  document,
}: {
  candidateId: string;
  document: PreviousDocumentAvailabilityDto;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const view = presentation[document.state];
  let navigate: ReturnType<typeof useNavigate> | undefined;
  try {
    navigate = useNavigate();
  } catch {
    navigate = undefined;
  }
  const open = async () => {
    if (!navigate) return;
    setOpening(true); setError("");
    try {
      await navigate({ to: "/review/candidates/$candidateId", params: { candidateId }, search: { previousDocument: document.id } });
    } catch (cause) { setError(candidateError(cause)); }
    finally { setOpening(false); }
  };
  const Icon = document.state === "REUSED" ? CheckCircle2 : HistoryIcon;
  return (
    <li className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 break-words text-[13px] font-semibold">
          {document.title}
        </span>
        <Badge tone={view.tone}>{view.label}</Badge>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-[var(--muted-foreground)]">
        <Icon size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>{view.explanation}</span>
      </p>
      <p className="text-xs text-[var(--muted-foreground)]">
        {document.expiresAt
          ? `${document.state === "EXPIRED" ? "Срок истёк" : "Действителен до"} ${formatDateRu(document.expiresAt)}`
          : "Срок действия не указан в источнике"}
        {document.recordedAt
          ? ` · Запись от ${formatDateRu(document.recordedAt)}`
          : ""}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="max-w-full"
        disabled={!document.originalAvailable || opening}
        onClick={() => void open()}
      >
        {opening
          ? "Открытие…"
          : document.originalAvailable
            ? "Открыть прежний документ"
            : "Оригинал недоступен"}
      </Button>
      {error && (
        <p role="alert" className="break-words text-xs text-[var(--primary)]">
          {error}
        </p>
      )}
    </li>
  );
}
