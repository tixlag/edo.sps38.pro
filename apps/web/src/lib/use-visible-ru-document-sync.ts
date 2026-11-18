import { useEffect, useRef, useState } from "react";
import { useRequestCandidateEnrichmentBatch } from "@edo/api-client";

/** One request per visible page; poll the existing queue only while it has work. */
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
    let timer: ReturnType<typeof setTimeout>;
    const candidateIds = key.split(",");
    let lastPending = candidateIds;
    const update = () =>
      actions.current.mutate(
        { data: { candidateIds } },
        {
          onSuccess: async (data) => {
            if (!active) return;
            const newPending = data.pendingCandidateIds;
            const anyFinished =
              lastPending.some((id) => !newPending.includes(id)) ||
              (newPending.length === 0 && lastPending.length > 0);
            lastPending = newPending;
            if (anyFinished) {
              await actions.current.refetch();
              if (!active) return;
            }
            setResult({ key, pending: newPending });
            if (newPending.length)
              timer = setTimeout(update, 5000);
          },
          onError: () => {
            if (active) setResult({ key, pending: candidateIds, error: true });
          },
        },
      );
    update();
    return () => {
      active = false;
      clearTimeout(timer);
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
