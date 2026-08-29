// Trailing debounce for a displayed value: a change QUEUES, and becomes the
// displayed value only after `debounceMs` passes with no further changes —
// a flap A→B→A within the window shows A throughout. The chat feed uses it
// on the live activity card's derived phase/status, which can flip for a
// frame on sub-100ms journal ripples; nothing about it is phase-specific.
//
// Modeled as a query, not state + timers: `contentKey` (the value's content
// identity — same key means "would display the same") keys a query whose
// queryFn resolves the value after the window. `keepPreviousData` keeps
// showing the old value while the new key is "loading" (the debounce
// window), and `staleTime: Infinity` means a return to any already-displayed
// key hits cache and switches back instantly — flap suppression falls out
// of caching.

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

export function useDebouncedValue<T>(input: {
  /** Cache identity for this debounced stream (e.g. the feed item's id). */
  scope: string;
  /** Content identity: same key = same display. null = nothing to debounce —
   * the value passes straight through (the live card's settled state, which
   * is journal-final and must never wear a stale live status). */
  contentKey: string | null;
  value: T;
  debounceMs: number;
}): T {
  const queryClient = useQueryClient();
  const scopeKey = ["debounced-value", input.scope, input.debounceMs];
  const query = useQuery({
    queryKey: [...scopeKey, input.contentKey],
    queryFn: async () => {
      // The scope's FIRST value resolves instantly: nothing is displayed
      // yet, so there's nothing to flash from — and resolving (rather than
      // bypassing the cache) seeds keepPreviousData, so a change landing
      // even within the first window already debounces against it.
      const hasPrevious = queryClient
        .getQueriesData({ queryKey: scopeKey })
        .some(([, data]) => data !== undefined);
      if (hasPrevious) {
        await new Promise((resolve) => setTimeout(resolve, input.debounceMs));
      }
      return { value: input.value };
    },
    enabled: input.contentKey !== null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  if (input.contentKey === null) return input.value;
  // One frame at scope birth: the instant first resolution hasn't landed
  // yet and there is no previous data — paint the value it will cache.
  return query.data === undefined ? input.value : query.data.value;
}
