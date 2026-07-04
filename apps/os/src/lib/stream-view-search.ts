import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";

/**
 * URL-backed view state for ProjectStreamView. Every route that mounts a
 * stream view (every domain page plus the stream/agent detail
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
  /** Exact event-type filters (any-of) for the feed-items presets. */
  types: z.array(z.string()).optional().catch(undefined),
  /** Inclusive lower offset bound for the feed-items presets. */
  from: z.number().optional().catch(undefined),
  /** Inclusive upper offset bound for the feed-items presets. */
  to: z.number().optional().catch(undefined),
  /** Offset of the raw event open in the inspector side panel. */
  event: z.number().optional().catch(undefined),
  /** Whether the search/filter row is open. */
  filter: z.boolean().optional().catch(undefined),
  /** Whether the processors sidebar is open. */
  panel: z.boolean().optional().catch(undefined),
  /** Subscription key of the processor focused in the sidebar. */
  processor: z.string().optional().catch(undefined),
});

export type StreamViewSearch = z.infer<typeof StreamViewSearch>;

/** The stream view's two tabs; Feed is the URL-omitted default. */
export type StreamViewTab = NonNullable<StreamViewSearch["tab"]>;

export function streamViewTab(search: StreamViewSearch): StreamViewTab {
  return search.tab ?? "feed";
}

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

/**
 * URL state for the stream view's right-edge overlays — the raw-event
 * inspector and the processors sidebar. They share the same screen edge, so
 * every setter keeps them mutually exclusive; if a hand-edited URL asks for
 * both, the inspector wins. Callable from any component under a stream-view
 * route (header, feed rows, the view itself) — the URL is the single owner,
 * so there is nothing to prop-drill.
 */
export function useStreamViewPanels(): {
  /** Offset open in the raw-event inspector; null = closed. */
  inspectedOffset: number | null;
  /** Subscription key of the processor focused in the sidebar; null = overview. */
  focusedProcessorKey: string | null;
  processorsPanelOpen: boolean;
  inspectEvent: (offset: number) => void;
  closeInspector: () => void;
  /** Focusing a processor implies the sidebar is open. */
  focusProcessor: (subscriptionKey: string) => void;
  openProcessorsOverview: () => void;
  closeProcessorsPanel: () => void;
} {
  const { search, setSearch } = useStreamViewSearch();
  const inspectedOffset = search.event ?? null;
  const focusedProcessorKey = search.processor ?? null;
  const processorsPanelOpen =
    inspectedOffset == null && (search.panel === true || focusedProcessorKey != null);
  // Stable identities: these feed effect deps downstream (e.g. the inspector's
  // arrow-key listener re-subscribes when its navigate callback changes).
  const inspectEvent = useCallback(
    (offset: number) => setSearch({ event: offset, panel: undefined, processor: undefined }),
    [setSearch],
  );
  const closeInspector = useCallback(() => setSearch({ event: undefined }), [setSearch]);
  const focusProcessor = useCallback(
    (subscriptionKey: string) =>
      setSearch({ panel: true, processor: subscriptionKey, event: undefined }),
    [setSearch],
  );
  const openProcessorsOverview = useCallback(
    () => setSearch({ panel: true, processor: undefined, event: undefined }),
    [setSearch],
  );
  const closeProcessorsPanel = useCallback(
    () => setSearch({ panel: undefined, processor: undefined }),
    [setSearch],
  );
  return {
    inspectedOffset,
    focusedProcessorKey,
    processorsPanelOpen,
    inspectEvent,
    closeInspector,
    focusProcessor,
    openProcessorsOverview,
    closeProcessorsPanel,
  };
}
