import type { DocumentStatus } from "@edo/api-client";

/** Presentation only: approval and ERP delivery are independent backend facts. */
export function documentDeliveryPresentation(
  status: DocumentStatus,
  deliveryStatus: string | null | undefined,
): {
  label: string;
  tone: "success" | "info" | "danger" | "warning";
  problem: boolean;
} | null {
  if (status !== "APPROVED" && status !== "SIGNED") return null;
  switch (deliveryStatus) {
    case "SENT":
      return { label: "Сохранён в ERP", tone: "success", problem: false };
    case "PENDING":
    case "SENDING":
      return { label: "Отправляется в ERP", tone: "info", problem: false };
    case "REQUIRES_MANUAL":
      return { label: "Не сохранён в ERP", tone: "danger", problem: true };
    case "WAITING_CONTRACT":
      return {
        label: "Отправка в ERP недоступна",
        tone: "warning",
        problem: true,
      };
    default:
      return {
        label: "Сохранение в ERP не подтверждено",
        tone: "warning",
        problem: true,
      };
  }
}
