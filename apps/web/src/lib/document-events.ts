import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getDocumentStreamConnection,
  subscribeDocumentStatuses,
} from "@edo/api-client";

export function useDocumentEvents(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return subscribeDocumentStatuses({
      connect: getDocumentStreamConnection,
      onDocuments: () => {
        void client.invalidateQueries({
          predicate: (query) =>
            /documents|candidate|dashboard/.test(String(query.queryKey[0])),
        });
      },
    });
  }, [client, enabled]);
}
