import {
  getGetDocumentVersionQueryKey,
  useGetDocumentVersion,
} from "@edo/api-client";

/** SSE invalidates this same cache entry; polling also works without the stream. */
export function useLiveDocumentVersion(documentId: string, version: number) {
  return useGetDocumentVersion(documentId, version, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(documentId, version),
      enabled: version > 0,
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
      refetchInterval: (query) =>
        ["UPLOADING", "QUEUED", "RUNNING"].includes(
          query.state.data?.job?.status ?? "",
        ) ||
        ["UPLOADED", "OCR_PENDING"].includes(query.state.data?.status ?? "")
          ? 3000
          : false,
    },
  });
}
