import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@edo/ui";
import {
  useListDocumentReturnNotifications,
  useRetryDocumentReturnNotification,
  getListDocumentReturnNotificationsQueryKey,
} from "@edo/api-client";
import { candidateError } from "./CandidateForm";

export function DocumentReturnNotifications({
  documentId,
}: {
  documentId: string;
}) {
  const query = useListDocumentReturnNotifications(documentId);
  const retry = useRetryDocumentReturnNotification();
  const cache = useQueryClient();
  if (query.isError)
    return (
      <p className="py-2 text-xs" role="status">
        Не удалось проверить доставку сообщения о возврате.{" "}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Повторить
        </Button>
      </p>
    );
  const messages = query.data?.filter((item) => item.status !== "SENT") ?? [];
  if (!messages.length) return null;
  return (
    <div
      className="space-y-2 py-2 text-xs"
      aria-label="Доставка сообщения о возврате"
    >
      {messages.map((item) => (
        <div key={item.id} className="space-y-1">
          <p role="status">
            {item.status === "FAILED"
              ? "Сообщение о возврате не доставлено кандидату."
              : item.status === "UNKNOWN"
                ? "Доставка сообщения о возврате не подтверждена. Проверьте чат перед повторной отправкой."
                : "Сообщение о возврате ожидает отправки."}{" "}
            Статус документа сохранён.
          </p>
          {item.status === "FAILED" && (
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(
                  { documentId, operationId: item.id },
                  {
                    onSuccess: () =>
                      void cache.invalidateQueries({
                        queryKey:
                          getListDocumentReturnNotificationsQueryKey(
                            documentId,
                          ),
                      }),
                  },
                )
              }
            >
              {retry.isPending ? "Отправка…" : "Повторить сообщение"}
            </Button>
          )}
        </div>
      ))}
      {retry.isError && <p role="alert">{candidateError(retry.error)}</p>}
    </div>
  );
}
