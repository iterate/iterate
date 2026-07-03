import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";

/**
 * URL-backed view state for ProjectStreamView. Every route that mounts a
 * stream view (all the StreamPage domain pages plus the stream/agent detail
 * routes) registers this schema in its `validateSearch` — directly or via
 * `.extend()` — so the component reads/writes its tab, filter, and
 * processor-sidebar state through the URL and every view is shareable.
 *
 * Every field is optional and omitted from the URL at its default: the active
 * tab falls back to a per-stream default in the component, an absent `panel`
 * means the processors sidebar is closed, and so on. `.catch(undefined)` keeps
 * a hand-edited or stale param from bailing the whole route to its error
 * boundary — a bad value just reverts to the default.
 */
export const StreamViewSearch = z.object({
  /** Active tab; omitted on the default (Feed). */
  tab: z.enum(["feed", "state"]).optional().catch(undefined),
  /** Feed preset id; omitted on the stream's default preset. */
  preset: z.string().optional().catch(undefined),
  /** Feed text search query. */
  q: z.string().optional().catch(undefined),
  /** Exact event-type filter for the feed-items presets. */
  type: z.string().optional().catch(undefined),
  /** Whether the search/filter row is open. */
  filter: z.boolean().optional().catch(undefined),
  /** Whether the processors sidebar is open. */
  panel: z.boolean().optional().catch(undefined),
  /** Subscription key of the processor focused in the sidebar. */
  processor: z.string().optional().catch(undefined),
});

export type StreamViewSearch = z.infer<typeof StreamViewSearch>;

/**
 * Read and patch the stream-view search params. The component is only rendered
 * under routes that validate against {@link StreamViewSearch}, so reading
 * loosely (`strict: false`) and casting is safe. Patches merge into the current
 * params and `replace` history so tab/filter clicks don't pile up back-button
 * entries; setting a key to `undefined` drops it from the URL.
 */
export function useStreamViewSearch(): {
  search: StreamViewSearch;
  setSearch: (patch: Partial<StreamViewSearch>) => void;
} {
  const search = useSearch({ strict: false }) as StreamViewSearch;
  const navigate = useNavigate();
  const setSearch = useCallback(
    (patch: Partial<StreamViewSearch>) => {
      void navigate({
        // `useNavigate()` isn't scoped to one route (this hook serves every
        // stream-view route), so
        // without a `to`/`from` the search reducer's inferred type collapses to
        // `never`. The reducer below is written type-safely against our schema;
        // we only erase its type at this un-narrowable assignment boundary.
        search: ((previous: StreamViewSearch) => ({ ...previous, ...patch })) as unknown as never,
        replace: true,
      });
    },
    [navigate],
  );
  return { search, setSearch };
}
