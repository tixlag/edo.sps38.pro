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

/** Keep incomplete ERP snapshots out of document counters and empty states. */
export function useCandidateDocumentSync(candidateId: string, stage?: string) {
  const client = useQueryClient();
  const refresh = useRequestCandidateEnrichment();
  const requested = useRef<string>();
  const previous = useRef<string>();
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
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
  const isPending =
    awaitingRefresh ||
    refresh.isPending ||
    (Boolean(enrichment?.status) && enrichment?.status !== "READY");

  const needsRequest =
    !!enrichment &&
    requested.current !== candidateId &&
    (isRu || enrichment.status !== "READY");

  const requestSync = () => {
    requested.current = candidateId;
    setAwaitingRefresh(true);
    refresh.mutate(
      { candidateId },
      {
        onSuccess: (data) => {
          if (data?.status === "READY") {
            setAwaitingRefresh(false);
          } else {
            setAwaitingRefresh(true);
          }
          previous.current = data?.status ?? "PENDING";
          void details.refetch();
        },
        onError: () => setAwaitingRefresh(false),
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

  // Update local waiting state on SSE READY without redundant manual query invalidations
  useEffect(() => {
    return subscribeRuEnrichmentEvents((event) => {
      const match = event.items.find(
        (item) => item.candidateId === candidateId,
      );
      if (match?.status === "READY") {
        setAwaitingRefresh(false);
      }
    });
  }, [candidateId]);

  // Rare safety fallback check for open RU card (every 60s) while sync is active/pending
  useEffect(() => {
    if (!isRu || !isPending) return;
    let active = true;

    const checkStatus = async () => {
      if (!active) return;
      try {
        const statusData = await getCandidateEnrichmentBatchStatus({
          candidateIds: [candidateId],
        });
        if (!active) return;
        const item = statusData.items.find(
          (i) => i.candidateId === candidateId,
        );
        if (item?.status === "READY") {
          setAwaitingRefresh(false);
          await invalidateRuEnrichmentCandidates(client, [candidateId]);
        }
      } catch {
        // Non-blocking fallback
      }
    };

    const interval = setInterval(() => {
      void checkStatus();
    }, 60_000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [candidateId, client, isRu, isPending]);

  // Reconnection listener with stable dependencies to prevent resetting wasReconnecting
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;
  const isRuRef = useRef(isRu);
  isRuRef.current = isRu;

  useEffect(() => {
    let wasReconnecting = false;
    return subscribeDocumentStreamState((state) => {
      if (state === "reconnecting") {
        wasReconnecting = true;
      } else if (state === "connected" && wasReconnecting) {
        wasReconnecting = false;
        if (isRuRef.current) {
          if (isPendingRef.current) {
            void getCandidateEnrichmentBatchStatus({
              candidateIds: [candidateId],
            })
              .then((statusData) => {
                const item = statusData.items.find(
                  (i) => i.candidateId === candidateId,
                );
                if (item?.status === "READY") {
                  setAwaitingRefresh(false);
                  void invalidateRuEnrichmentCandidates(client, [candidateId]);
                }
              })
              .catch(() => {});
          }
        } else {
          const currentDetails = detailsRef.current;
          const status = currentDetails.data?.enrichment?.status;
          if (status && status !== "READY") {
            void currentDetails.refetch();
          }
        }
      }
    });
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
    (!!enrichment && enrichment.status !== "READY");
  return {
    ...details,
    data: denied ? undefined : (completeData ?? details.data),
    isError: details.isError && !completeData,
    synchronizing: !details.isError && busy && !completeData,
    updating: busy && !!completeData,
    syncError:
      refresh.isError || details.isError || enrichment?.status === "RETRY",
    requestSync,
  };
}
