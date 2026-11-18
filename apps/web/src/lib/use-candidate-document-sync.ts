import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCandidateDetails,
  getGetCandidateDetailsQueryKey,
  useRequestCandidateEnrichment,
  getCandidateEnrichmentBatchStatus,
  getListCandidatePreviousDocumentsQueryKey,
  getListCandidateReviewQueueQueryKey,
  getListReviewCandidatesQueryKey,
  getListIgArrivalRegistryGroupsQueryKey,
  getListIgArrivalRegistryParticipationsQueryKey,
} from "@edo/api-client";
import {
  subscribeRuEnrichmentEvents,
  subscribeDocumentStreamState,
  invalidateRuEnrichmentCandidates,
} from "./document-events";
import {
  type CandidateSyncStatus,
  type CandidateSyncState,
} from "./use-visible-ru-document-sync";

/** Keep incomplete ERP snapshots out of document counters and empty states. */
export function useCandidateDocumentSync(candidateId: string, stage?: string) {
  const client = useQueryClient();
  const refresh = useRequestCandidateEnrichment();
  const requested = useRef<string>();
  const previous = useRef<string>();
  const syncRunIdRef = useRef(0);
  const isCompletedRef = useRef(false);
  const sseSettledRef = useRef<"READY" | "RETRY" | null>(null);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const [syncState, setSyncState] = useState<CandidateSyncState | undefined>();

  useEffect(() => {
    syncRunIdRef.current++;
    setSyncState(undefined);
    isCompletedRef.current = false;
    sseSettledRef.current = null;
    requested.current = undefined;
    previous.current = undefined;
  }, [candidateId]);

  const params = stage ? { stage } : undefined;
  const details = useGetCandidateDetails(candidateId, params, {
    query: {
      queryKey: getGetCandidateDetailsQueryKey(candidateId, params),
      refetchInterval: (query) => {
        const status = query.state.data?.enrichment?.status;
        if (!status || status === "READY") return false;
        const group = query.state.data?.candidate?.reviewGroup;
        if (group === "RU") {
          return false;
        }
        return 5000;
      },
    },
  });
  const enrichment = details.data?.enrichment;
  const isRu = details.data?.candidate.reviewGroup === "RU";

  const effectiveSyncState: CandidateSyncState | undefined =
    isRu && syncState
      ? syncState
      : enrichment
        ? {
            status: enrichment.status as CandidateSyncStatus,
            retryAt: enrichment.retryAt,
          }
        : undefined;

  const effectiveStatus = effectiveSyncState?.status;

  const isPending =
    awaitingRefresh ||
    refresh.isPending ||
    (Boolean(effectiveStatus) && effectiveStatus !== "READY");

  const needsRequest =
    !!enrichment &&
    requested.current !== candidateId &&
    (!isRu || enrichment.status !== "RETRY") &&
    (isRu || enrichment.status !== "READY");

  const requestSync = () => {
    const runId = ++syncRunIdRef.current;
    requested.current = candidateId;
    isCompletedRef.current = false;
    sseSettledRef.current = null;
    setAwaitingRefresh(true);
    if (isRu) {
      setSyncState({ status: "PENDING", retryAt: null });
    }
    refresh.mutate(
      { candidateId },
      {
        onSuccess: (data) => {
          if (runId !== syncRunIdRef.current) return;
          if (isRu && sseSettledRef.current) {
            return;
          }
          if (data?.status === "READY") {
            isCompletedRef.current = true;
            sseSettledRef.current = "READY";
            setAwaitingRefresh(false);
            if (isRu) {
              setSyncState({ status: "READY", retryAt: null });
            }
          } else {
            if (data?.status === "RETRY") {
              sseSettledRef.current = "RETRY";
              setAwaitingRefresh(false);
            } else {
              setAwaitingRefresh(true);
            }
            if (isRu) {
              setSyncState({
                status: (data?.status as CandidateSyncStatus) ?? "PENDING",
                retryAt: data?.retryAt ?? null,
              });
            }
          }
          previous.current = data?.status ?? "PENDING";
          void details.refetch();
        },
        onError: () => {
          if (runId !== syncRunIdRef.current) return;
          if (isRu && sseSettledRef.current) return;
          setAwaitingRefresh(false);
        },
      },
    );
  };

  useEffect(() => {
    if (needsRequest) requestSync();
    if (
      !isRu &&
      enrichment?.status === "READY" &&
      previous.current &&
      previous.current !== "READY"
    ) {
      for (const key of [
        getGetCandidateDetailsQueryKey(candidateId),
        getListCandidatePreviousDocumentsQueryKey(candidateId),
        getListCandidateReviewQueueQueryKey(),
        getListReviewCandidatesQueryKey(),
        getListIgArrivalRegistryGroupsQueryKey(),
        getListIgArrivalRegistryParticipationsQueryKey({ groupKey: "" }),
      ])
        void client.invalidateQueries({ queryKey: key.slice(0, 1) });
    }
    previous.current = enrichment?.status;
  }, [candidateId, enrichment?.status, details.dataUpdatedAt, isRu]);

  // Update local waiting state on SSE events
  useEffect(() => {
    return subscribeRuEnrichmentEvents((event) => {
      const match = event.items.find(
        (item) => item.candidateId === candidateId,
      );
      if (!match) return;

      if (match.status === "READY") {
        isCompletedRef.current = true;
        sseSettledRef.current = "READY";
        setAwaitingRefresh(false);
        setSyncState({ status: "READY", retryAt: null });
      } else if (!isCompletedRef.current) {
        if (match.status === "RETRY") {
          sseSettledRef.current = "RETRY";
          setAwaitingRefresh(false);
        }
        setSyncState({
          status: match.status as CandidateSyncStatus,
          retryAt: match.retryAt,
        });
      }
    });
  }, [candidateId]);

  const checkStatus = async (activeCheck: () => boolean) => {
    if (!activeCheck()) return;
    try {
      const statusData = await getCandidateEnrichmentBatchStatus({
        candidateIds: [candidateId],
      });
      if (!activeCheck()) return;
      const item = statusData.items.find((i) => i.candidateId === candidateId);
      if (!item) return;

      if (item.status === "READY") {
        isCompletedRef.current = true;
        sseSettledRef.current = "READY";
        setAwaitingRefresh(false);
        setSyncState({ status: "READY", retryAt: null });
        await invalidateRuEnrichmentCandidates(client, [candidateId]);
      } else if (!isCompletedRef.current) {
        if (item.status === "RETRY") {
          sseSettledRef.current = "RETRY";
          setAwaitingRefresh(false);
        }
        setSyncState({
          status: item.status as CandidateSyncStatus,
          retryAt: item.retryAt,
        });
      }
    } catch {
      // Non-blocking fallback
    }
  };

  // Rare safety fallback check for open RU card (every 60s) while sync is active/pending
  useEffect(() => {
    if (!isRu || !isPending) return;
    let active = true;

    const interval = setInterval(() => {
      void checkStatus(() => active);
    }, 60_000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [candidateId, client, isRu, isPending]);

  // Reconnection listener with stable dependencies and unmount protection
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;
  const isRuRef = useRef(isRu);
  isRuRef.current = isRu;

  useEffect(() => {
    let active = true;
    let wasReconnecting = false;
    const unsubscribe = subscribeDocumentStreamState((state) => {
      if (state === "reconnecting") {
        wasReconnecting = true;
      } else if (state === "connected" && wasReconnecting) {
        wasReconnecting = false;
        if (isRuRef.current) {
          if (isPendingRef.current) {
            void checkStatus(() => active);
          }
        } else {
          const currentDetails = detailsRef.current;
          const status = currentDetails.data?.enrichment?.status;
          if (active && status && status !== "READY") {
            void currentDetails.refetch();
          }
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [candidateId, client]);

  const lastComplete = useRef<{
    candidateId: string;
    stage?: string;
    data: typeof details.data;
  }>();
  const denied =
    details.isError &&
    [401, 403, 404].includes(
      (details.error as { response?: { status?: number } } | null)?.response
        ?.status ?? 0,
    );
  if (
    lastComplete.current?.candidateId !== candidateId ||
    lastComplete.current?.stage !== stage ||
    denied
  )
    lastComplete.current = undefined;
  if (
    !denied &&
    details.data &&
    (!enrichment || (enrichment.profileReady && enrichment.documentsReady))
  ) {
    lastComplete.current = { candidateId, stage, data: details.data };
  }
  const completeData = denied ? undefined : lastComplete.current?.data;
  const busy =
    details.isLoading ||
    needsRequest ||
    awaitingRefresh ||
    refresh.isPending ||
    refresh.isError ||
    details.isError ||
    (Boolean(effectiveStatus) && effectiveStatus !== "READY");
  return {
    ...details,
    data: denied ? undefined : (completeData ?? details.data),
    isError: details.isError && !completeData,
    synchronizing: !details.isError && busy && !completeData,
    updating: busy && Boolean(completeData),
    syncError:
      refresh.isError || details.isError || effectiveStatus === "RETRY",
    syncState: effectiveSyncState,
    requestSync,
  };
}
