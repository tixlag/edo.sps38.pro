import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCandidateDetails,
  getGetCandidateDetailsQueryKey,
  useRequestCandidateEnrichment,
  getListCandidatePreviousDocumentsQueryKey,
  getListCandidateReviewQueueQueryKey,
  getListReviewCandidatesQueryKey,
  getListIgArrivalRegistryGroupsQueryKey,
  getListIgArrivalRegistryParticipationsQueryKey,
} from "@edo/api-client";
import {
  subscribeRuEnrichmentEvents,
  subscribeDocumentStreamState,
  getDocumentStreamState,
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
          const streamState = getDocumentStreamState();
          return streamState === "connected" ? false : 60_000;
        }
        return 5000;
      },
    },
  });
  const enrichment = details.data?.enrichment;
  const needsRequest =
    !!enrichment &&
    requested.current !== candidateId &&
    (details.data?.candidate.reviewGroup === "RU" ||
      enrichment.status !== "READY");
  const requestSync = () => {
    requested.current = candidateId;
    setAwaitingRefresh(true);
    refresh.mutate(
      { candidateId },
      {
        onSuccess: () => {
          previous.current = "PENDING";
          void details.refetch().finally(() => setAwaitingRefresh(false));
        },
        onError: () => setAwaitingRefresh(false),
      },
    );
  };
  useEffect(() => {
    if (needsRequest) requestSync();
    if (
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
  }, [candidateId, enrichment?.status, details.dataUpdatedAt]);

  useEffect(() => {
    return subscribeRuEnrichmentEvents((event) => {
      const match = event.items.find(
        (item) => item.candidateId === candidateId && item.status === "READY",
      );
      if (match) {
        for (const key of [
          getGetCandidateDetailsQueryKey(candidateId),
          getListCandidatePreviousDocumentsQueryKey(candidateId),
          getListCandidateReviewQueueQueryKey(),
          getListReviewCandidatesQueryKey(),
          getListIgArrivalRegistryGroupsQueryKey(),
          getListIgArrivalRegistryParticipationsQueryKey({ groupKey: "" }),
        ]) {
          void client.invalidateQueries({ queryKey: key.slice(0, 1) });
        }
      }
    });
  }, [candidateId, client]);

  useEffect(() => {
    let wasReconnecting = false;
    return subscribeDocumentStreamState((state) => {
      if (state === "reconnecting") {
        wasReconnecting = true;
      } else if (state === "connected" && wasReconnecting) {
        wasReconnecting = false;
        if (enrichment?.status && enrichment.status !== "READY") {
          void details.refetch();
        }
      }
    });
  }, [details, enrichment?.status]);
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
    refresh.isError ||
    details.isError ||
    (!!enrichment && enrichment.status !== "READY");
  return {
    ...details,
    data: denied ? undefined : (completeData ?? details.data),
    isError: details.isError && !completeData,
    synchronizing: !details.isError && busy && !completeData,
    updating: busy && !!completeData,
    syncError: refresh.isError || details.isError,
    requestSync,
  };
}
