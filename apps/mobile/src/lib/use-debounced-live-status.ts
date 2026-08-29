// 250ms trailing debounce for the live activity card's phase/status display.
// Journal events can land in sub-100ms ripples that flip the DERIVED phase
// for a frame (the fold's certainty signals cover the known owed-turn gaps,
// not every event-arrival race), and a glyph that flashes for 80ms reads as
// a glitch. A phase change therefore QUEUES: it becomes the displayed value
// only after 250ms with no further changes, and a flap A→B→A within the
// window shows A throughout.
//
// Modeled as a query, not state + timers: the derived status's CONTENT keys
// a query whose queryFn resolves that value 250ms later.
// `keepPreviousData` keeps showing the old value while the new key is
// "loading" (the debounce window), and `staleTime: Infinity` means a return
// to any already-displayed value hits cache and switches back instantly —
// flap suppression falls out of caching.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AgentUiLiveStatus } from "./feed.ts";

const PHASE_DEBOUNCE_MS = 250;

export function useDebouncedLiveStatus(
  activityId: string | null,
  liveStatus: AgentUiLiveStatus | null,
): AgentUiLiveStatus | null {
  const query = useQuery({
    queryKey: [
      "live-status-debounce",
      activityId,
      liveStatus === null ? null : `${liveStatus.phase}|${liveStatus.statusText || ""}`,
    ],
    queryFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, PHASE_DEBOUNCE_MS));
      return liveStatus;
    },
    enabled: liveStatus !== null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  // The live→settled/absent switch is journal-final — pass null through
  // undebounced so a settled card never wears a stale live status.
  if (liveStatus === null) return null;
  // First value on mount: nothing is displayed yet, so nothing can flash —
  // show it immediately rather than holding an empty slot for 250ms.
  return query.data === undefined || query.data === null ? liveStatus : query.data;
}
