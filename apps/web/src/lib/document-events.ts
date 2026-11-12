import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  getDocumentStreamConnection,
  subscribeDocumentStatuses,
  type DocumentDto,
} from "@edo/api-client";

/** Coalesce snapshot changes; immutable file contents are never status queries. */
export function subscribeDocumentQueryUpdates(client: QueryClient): () => void {
  let previous = new Map<string, DocumentDto>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let stopped = false;
  const documentIds = new Set<string>();
  const candidateIds = new Set<string>();
  const schedule = () => {
    if (!stopped && !flushing && !timer && documentIds.size)
      timer = setTimeout(() => void flush(), 100);
  };
  const flush = async () => {
    timer = undefined;
    if (stopped) return;
    flushing = true;
    const documents = new Set(documentIds);
    const candidates = new Set(candidateIds);
    documentIds.clear();
    candidateIds.clear();
    try {
      await client.invalidateQueries(
        {
          predicate: (query) => {
            const path = String(query.queryKey[0]);
            // Original EDO/ERP files and rendered annotation pages do not change
            // when approval/delivery changes. Permissions still gate every read.
            if (/\/files\/|\/original$|\/annotation/.test(path)) return false;
            const document =
              /^\/api\/v1\/documents\/([^/]+)(?:\/versions\/\d+(?:\/ocr-details)?)?$/.exec(
                path,
              );
            if (document) return documents.has(document[1]);
            const candidate = /^\/api\/v1\/candidates\/([^/]+)(?:\/|$)/.exec(
              path,
            );
            if (candidate) return candidates.has(candidate[1]);
            return (
              /^\/api\/v1\/(?:candidate-review-queue|review-documents|review-candidates|dashboard)(?:\/|$)/.test(
                path,
              ) ||
              /^\/api\/v1\/employees\/[^/]+\/documents$/.test(path) ||
              path === "/api/candidate-documents" ||
              path === "/api/candidate-documents/my/history"
            );
          },
        },
        { cancelRefetch: false },
      );
    } finally {
      flushing = false;
      // A change received during a slow read needs one trailing refresh.
      schedule();
    }
  };
  const fingerprint = (document: DocumentDto) =>
    JSON.stringify({ ...document, candidate: undefined });
  const mark = (document: DocumentDto) => {
    documentIds.add(document.id);
    if (document.candidateId) candidateIds.add(document.candidateId);
  };
  const unsubscribe = subscribeDocumentStatuses({
    connect: getDocumentStreamConnection,
    onDocuments: ({ items }) => {
      const next = new Map(items.map((document) => [document.id, document]));
      for (const document of items) {
        const old = previous.get(document.id);
        if (!old || fingerprint(old) !== fingerprint(document)) {
          mark(document);
          if (old) mark(old);
        }
      }
      for (const old of previous.values()) if (!next.has(old.id)) mark(old);
      previous = next;
      schedule();
    },
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}

export function useDocumentEvents(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (enabled) return subscribeDocumentQueryUpdates(client);
  }, [client, enabled]);
}
