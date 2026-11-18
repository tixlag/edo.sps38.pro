import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRequestCandidateEnrichmentBatch,
  getCandidateEnrichmentBatchStatus,
  type RuEnrichmentStreamEvent,
} from "@edo/api-client";
import {
  subscribeRuEnrichmentEvents,
  subscribeDocumentStreamState,
  invalidateRuEnrichmentCandidates,
} from "./document-events";

export type CandidateSyncStatus = "PENDING" | "RUNNING" | "RETRY" | "READY";

export interface CandidateSyncState {
  status: CandidateSyncStatus;
  retryAt: string | null;
}

/**
 * Initiates candidate enrichment batch once per visible page / filter set,
 * then updates pending candidates and triggers React Query refetches via SSE events.
 * Eliminates repeated POST polling; uses rare read-only status checks as safety net.
 */
export function useVisibleRuDocumentSync(ids: string[], enabled: boolean) {
  const queryClient = useQueryClient();
  const batch = useRequestCandidateEnrichmentBatch();
  const mutateRef = useRef(batch.mutate);
  mutateRef.current = batch.mutate;
  const key = ids.join(",");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    pending: string[];
    error?: boolean;
  }>();
  const [candidateStates, setCandidateStates] = useState<
    Map<string, CandidateSyncState>
  >(() => new Map());

  useEffect(() => {
    if (!enabled || !key) return;
    let active = true;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const candidateIds = key.split(",");
    const completedIds = new Set<string>();
    const pendingSet = new Set<string>();
    const statesMap = new Map<string, CandidateSyncState>();

    const updateStates = () => {
      if (!active) return;
      setCandidateStates(new Map(statesMap));
      setResult({ key, pending: Array.from(pendingSet) });
    };

    // Fast status check for reconciling state if SSE missed an event or after reconnect
    const checkStatus = async () => {
      if (!active || pendingSet.size === 0) return;
      try {
        const statusData = await getCandidateEnrichmentBatchStatus({
          candidateIds: Array.from(pendingSet),
        });
        if (!active) return;
        const newlyCompleted: string[] = [];
        for (const item of statusData.items) {
          if (completedIds.has(item.candidateId)) {
            // Monotonic: do not allow older responses to regress READY status
            continue;
          }
          if (item.status === "READY") {
            completedIds.add(item.candidateId);
            pendingSet.delete(item.candidateId);
            newlyCompleted.push(item.candidateId);
          }
          statesMap.set(item.candidateId, {
            status: item.status,
            retryAt: item.retryAt,
          });
        }
        if (newlyCompleted.length > 0) {
          updateStates();
          await invalidateRuEnrichmentCandidates(queryClient, newlyCompleted);
        } else if (statusData.items.length > 0) {
          updateStates();
        }
      } catch {
        // Non-blocking fallback
      }
    };

    // Listen to ru-enrichment SSE events
    const unsubscribeSse = subscribeRuEnrichmentEvents(
      (event: RuEnrichmentStreamEvent) => {
        if (!active) return;
        let anyChanged = false;
        for (const item of event.items) {
          if (item.status === "READY") {
            completedIds.add(item.candidateId);
            if (pendingSet.has(item.candidateId)) {
              pendingSet.delete(item.candidateId);
              anyChanged = true;
            }
          } else if (completedIds.has(item.candidateId)) {
            // Monotonic: do not revert a completed candidate to non-ready
            continue;
          }
          const prev = statesMap.get(item.candidateId);
          if (
            !prev ||
            prev.status !== item.status ||
            prev.retryAt !== item.retryAt
          ) {
            statesMap.set(item.candidateId, {
              status: item.status,
              retryAt: item.retryAt,
            });
            anyChanged = true;
          }
        }
        if (anyChanged) {
          updateStates();
          // Do not call actions.current.refetch() here.
          // subscribeDocumentQueryUpdates in document-events.ts handles query invalidation via React Query.
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
    mutateRef.current(
      { data: { candidateIds } },
      {
        onSuccess: (data) => {
          if (!active) return;
          const returnedPending = new Set(data.pendingCandidateIds);
          for (const id of candidateIds) {
            if (completedIds.has(id)) {
              // Completed via SSE while POST was in flight
              statesMap.set(id, { status: "READY", retryAt: null });
            } else if (returnedPending.has(id)) {
              pendingSet.add(id);
              if (!statesMap.has(id)) {
                statesMap.set(id, { status: "PENDING", retryAt: null });
              }
            } else {
              // Candidates not returned in pending are already READY
              completedIds.add(id);
              statesMap.set(id, { status: "READY", retryAt: null });
            }
          }
          updateStates();

          // If there are pending jobs, schedule a one-time check after 1s to resolve race conditions
          if (pendingSet.size > 0) {
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
  }, [key, enabled, attempt, queryClient]);

  return {
    pendingIds: new Set(
      enabled ? (result?.key === key ? result.pending : ids) : [],
    ),
    candidateStates,
    getSyncState: (id: string): CandidateSyncState | undefined =>
      candidateStates.get(id),
    retry: () => setAttempt((value) => value + 1),
    error: enabled && result?.key === key && result.error,
  };
}
