import {
  useGetDocumentVersion,
  getGetDocumentVersionQueryKey,
  type CandidateDocumentSummaryDto,
} from "@edo/api-client";
import { documentInstanceLabel } from "../lib/document-instance-label";

export function useDocumentInstanceLabel(
  document: CandidateDocumentSummaryDto,
  index = 0,
  version = document.currentVersion,
) {
  const details = useGetDocumentVersion(document.id, version, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(document.id, version),
      staleTime: 240_000,
      retry: false,
    },
  });
  return documentInstanceLabel(document, index, details.data);
}

export function DocumentInstanceCaption({
  document,
  index = 0,
  version = document.currentVersion,
  id,
}: {
  document: CandidateDocumentSummaryDto;
  index?: number;
  version?: number;
  id?: string;
}) {
  const label = useDocumentInstanceLabel(document, index, version);
  return (
    <span
      id={id}
      className="block break-words text-sm leading-5 text-[var(--muted-foreground)]"
    >
      {label}
    </span>
  );
}
