import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  getDocumentStreamConnection,
  subscribeDocumentStatuses,
  type DocumentDto,
  type RuEnrichmentStreamEvent,
} from "@edo/api-client";

export type RuEnrichmentListener = (event: RuEnrichmentStreamEvent) => void;
export type DocumentStreamState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";
export type StreamStateListener = (state: DocumentStreamState) => void;

const ruEnrichmentListeners = new Set<RuEnrichmentListener>();
const streamStateListeners = new Set<StreamStateListener>();
let currentStreamState: DocumentStreamState = "disconnected";

export function subscribeRuEnrichmentEvents(
  listener: RuEnrichmentListener,
): () => void {
  ruEnrichmentListeners.add(listener);
  return () => {
    ruEnrichmentListeners.delete(listener);
  };
}

export function subscribeDocumentStreamState(
  listener: StreamStateListener,
): () => void {
  streamStateListeners.add(listener);
  listener(currentStreamState);
  return () => {
    streamStateListeners.delete(listener);
  };
}

export function getDocumentStreamState(): DocumentStreamState {
  return currentStreamState;
}

function dispatchRuEnrichment(event: RuEnrichmentStreamEvent) {
  for (const listener of ruEnrichmentListeners) {
    try {
      listener(event);
    } catch {
      // ignore
    }
  }
}

function dispatchStreamState(state: DocumentStreamState) {
  currentStreamState = state;
  for (const listener of streamStateListeners) {
    try {
      listener(state);
    } catch {
      // ignore
    }
  }
}

export function isRuEnrichmentQueryAffected(
  path: string,
  candidateIds: Set<string>,
): boolean {
  if (candidateIds.size === 0) return false;
  if (/\/files\/|\/original$|\/annotation/.test(path)) return false;

  const candidate = /^\/api\/v1\/candidates\/([^/]+)(?:\/|$)/.exec(path);
  if (candidate) {
    if (candidate[1] === "catalog") return true;
    return candidateIds.has(candidate[1]);
  }

  return /^\/api\/v1\/(?:review-candidates|review-documents|candidate-review-queue|dashboard|candidates)(?:\/|$)/.test(
    path,
  );
}

export async function invalidateRuEnrichmentCandidates(
  client: QueryClient,
  candidateIds: string[],
): Promise<void> {
  if (candidateIds.length === 0) return;
  const targetIds = new Set(candidateIds);
  await client.invalidateQueries(
    {
      predicate: (query) => {
        const path = String(query.queryKey[0]);
        return isRuEnrichmentQueryAffected(path, targetIds);
      },
    },
    { cancelRefetch: false },
  );
}

/** Coalesce snapshot changes; immutable file contents are never status queries. */
export function subscribeDocumentQueryUpdates(client: QueryClient): () => void {
  let previous = new Map<string, DocumentDto>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let stopped = false;
  const documentIds = new Set<string>();
  const candidateIds = new Set<string>();
  const profileIds = new Set<string>();
  const schedule = () => {
    if (
      !stopped &&
      !flushing &&
      !timer &&
      (documentIds.size || profileIds.size)
    )
      timer = setTimeout(() => void flush(), 100);
  };
  const flush = async () => {
    timer = undefined;
    if (stopped) return;
    flushing = true;
    const documents = new Set(documentIds);
    const candidates = new Set(candidateIds);
    const profiles = new Set(profileIds);
    documentIds.clear();
    candidateIds.clear();
    profileIds.clear();
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
            if (candidate) {
              if (candidate[1] === "catalog") return profiles.size > 0;
              return candidates.has(candidate[1]) || profiles.has(candidate[1]);
            }
            if (
              profiles.size &&
              /^\/api\/v1\/(?:review-candidates|review-documents|candidate-review-queue|dashboard|candidates)(?:\/|$)/.test(
                path,
              )
            )
              return true;
            if (!documents.size) return false;
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
  const candidateFingerprint = (document: DocumentDto) =>
    JSON.stringify(document.candidate);
  const mark = (document: DocumentDto) => {
    documentIds.add(document.id);
    if (document.candidateId) candidateIds.add(document.candidateId);
  };
  const unsubscribe = subscribeDocumentStatuses({
    connect: getDocumentStreamConnection,
    onState: (state) => dispatchStreamState(state),
    onRuEnrichment: (event) => {
      let anyReady = false;
      for (const item of event.items) {
        if (item.status === "READY") {
          candidateIds.add(item.candidateId);
          profileIds.add(item.candidateId);
          anyReady = true;
        }
      }
      if (anyReady) {
        schedule();
      }
      dispatchRuEnrichment(event);
    },
    onDocuments: ({ items }) => {
      const next = new Map(items.map((document) => [document.id, document]));
      for (const document of items) {
        const old = previous.get(document.id);
        if (!old || fingerprint(old) !== fingerprint(document)) {
          mark(document);
          if (old) mark(old);
        }
        if (
          old &&
          candidateFingerprint(old) !== candidateFingerprint(document)
        ) {
          if (old.candidateId) profileIds.add(old.candidateId);
          if (document.candidateId) profileIds.add(document.candidateId);
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
    dispatchStreamState("disconnected");
  };
}

export function useDocumentEvents(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (enabled) return subscribeDocumentQueryUpdates(client);
  }, [client, enabled]);
}
