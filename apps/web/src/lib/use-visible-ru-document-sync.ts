import { useEffect, useRef, useState } from "react";
import {
  useRequestCandidateEnrichmentBatch,
  getCandidateEnrichmentBatchStatus,
  type RuEnrichmentStreamEvent,
} from "@edo/api-client";
import {
  subscribeRuEnrichmentEvents,
  subscribeDocumentStreamState,
} from "./document-events";

/**
 * Initiates candidate enrichment batch once per visible page / filter set,
 * then updates pending candidates and triggers React Query refetches via SSE events.
 * Eliminates repeated POST polling; uses rare read-only status checks as safety net.
 */
export function useVisibleRuDocumentSync(
  ids: string[],
  enabled: boolean,
  refetch: () => Promise<unknown>,
) {
  const batch = useRequestCandidateEnrichmentBatch();
  const actions = useRef({ mutate: batch.mutate, refetch });
  actions.current = { mutate: batch.mutate, refetch };
  const key = ids.join(",");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    pending: string[];
    error?: boolean;
  }>();

  useEffect(() => {
    if (!enabled || !key) return;
    let active = true;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const candidateIds = key.split(",");
    const completedDuringPost = new Set<string>();
    let pendingSet = new Set<string>();
    let postFinished = false;

    // Fast status check for reconciling state if SSE missed an event or after reconnect
    const checkStatus = async () => {
      if (!active || pendingSet.size === 0) return;
      try {
        const statusData = await getCandidateEnrichmentBatchStatus({
          candidateIds: Array.from(pendingSet),
        });
        if (!active) return;
        let anyCompleted = false;
        for (const item of statusData.items) {
          if (item.status === "READY" && pendingSet.has(item.candidateId)) {
            pendingSet.delete(item.candidateId);
            anyCompleted = true;
          }
        }
        if (anyCompleted) {
          setResult({ key, pending: Array.from(pendingSet) });
          void actions.current.refetch();
        }
      } catch {
        // Non-blocking fallback
      }
    };

    // Listen to ru-enrichment SSE events
    const unsubscribeSse = subscribeRuEnrichmentEvents(
      (event: RuEnrichmentStreamEvent) => {
        if (!active) return;
        let anyCompleted = false;
        for (const item of event.items) {
          if (item.status === "READY") {
            if (!postFinished) {
              completedDuringPost.add(item.candidateId);
            }
            if (pendingSet.has(item.candidateId)) {
              pendingSet.delete(item.candidateId);
              anyCompleted = true;
            }
          }
        }
        if (anyCompleted) {
          setResult({ key, pending: Array.from(pendingSet) });
          void actions.current.refetch();
        }
      },
    );

    // Reconcile status when stream reconnects
    let wasReconnecting = false;
    const unsubscribeStreamState = subscribeDocumentStreamState((state) => {
      if (!active) return;
      if (state === "reconnecting") {
        wasReconnecting = true;
      } else if (state === "connected" && wasReconnecting) {
        wasReconnecting = false;
        if (pendingSet.size > 0) {
          void checkStatus();
        }
      }
    });

    // Reconcile status when tab regains visibility
    const onVisibilityChange = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        pendingSet.size > 0
      ) {
        void checkStatus();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    // Rare fallback check for long-pending jobs (every 60s)
    const safetyInterval = setInterval(() => {
      if (pendingSet.size > 0) {
        void checkStatus();
      }
    }, 60_000);

    // Initial POST: queued once upon page open / filter change
    actions.current.mutate(
      { data: { candidateIds } },
      {
        onSuccess: (data) => {
          if (!active) return;
          postFinished = true;
          // Exclude any candidates that completed via SSE while POST was in-flight
          const actualPending = data.pendingCandidateIds.filter(
            (id) => !completedDuringPost.has(id),
          );
          pendingSet = new Set(actualPending);
          setResult({ key, pending: actualPending });

          // If there are pending jobs, schedule a one-time check after 1s to resolve race conditions
          if (actualPending.length > 0) {
            fallbackTimer = setTimeout(() => void checkStatus(), 1000);
          }
        },
        onError: () => {
          if (active) setResult({ key, pending: candidateIds, error: true });
        },
      },
    );

    return () => {
      active = false;
      clearTimeout(fallbackTimer);
      clearInterval(safetyInterval);
      unsubscribeSse();
      unsubscribeStreamState();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [key, enabled, attempt]);

  return {
    pendingIds: new Set(
      enabled ? (result?.key === key ? result.pending : ids) : [],
    ),
    retry: () => setAttempt((value) => value + 1),
    error: enabled && result?.key === key && result.error,
  };
}
