import { Badge } from "./badge";
import type { ReactNode } from "react";

const toneByStatus: Record<
  string,
  "info" | "success" | "warning" | "danger" | "default" | "purple"
> = {
  INVITED: "default",
  ONBOARDING: "info",
  BLOCKED: "warning",
  IN_REVIEW: "purple",
  SIGNING: "info",
  HIRED: "success",
  TODO: "default",
  IN_PROGRESS: "info",
  DONE: "success",
  DRAFT: "default",
  UPLOADED: "info",
  OCR_PENDING: "warning",
  OCR_FAILED: "danger",
  RETURNED: "warning",
  APPROVED: "success",
  SIGNED: "success",
  EXPIRED: "danger",
};

const labelByStatus: Record<string, string> = {
  INVITED: "Приглашён",
  ONBOARDING: "Оформление",
  BLOCKED: "Заблокирован",
  IN_REVIEW: "Проверка",
  SIGNING: "Подписание",
  HIRED: "Оформлен",
  TODO: "К выполнению",
  IN_PROGRESS: "В работе",
  DONE: "Готово",
  DRAFT: "Черновик",
  UPLOADED: "Загружен",
  OCR_PENDING: "OCR",
  OCR_FAILED: "OCR ошибка",
  RETURNED: "Возвращён",
  APPROVED: "Одобрен",
  SIGNED: "Подписан",
  EXPIRED: "Истёк",
};

export function StatusBadge({
  status,
  document,
  icon,
}: {
  status: string;
  document?: boolean;
  icon?: ReactNode;
}) {
  const tone =
    document && status === "IN_REVIEW"
      ? "warning"
      : document && status === "RETURNED"
        ? "danger"
        : (toneByStatus[status] ?? "default");
  const label = document
    ? (
        {
          IN_REVIEW: "Ожидает проверки",
          APPROVED: "Документ принят",
          RETURNED: "Документ не принят",
        } as Record<string, string>
      )[status]
    : undefined;
  return (
    <Badge tone={tone}>
      <span className="inline-flex items-center gap-1.5">
        {icon}
        {label ?? labelByStatus[status] ?? status}
      </span>
    </Badge>
  );
}
