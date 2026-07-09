import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";

/**
 * URL-backed view state for ProjectStreamView. Every route that mounts a
 * stream view registers this schema in its `validateSearch` — directly or via
 * `.extend()` — so the component reads/writes mode, filter, and processor-
 * sidebar state through the URL and every view is shareable.
 *
 * Every field is optional and omitted from the URL at its default. `.catch(undefined)`
 * keeps a hand-edited or stale param from bailing the whole route to its error
 * boundary — a bad value just reverts to the default.
 *
 * Modes (Pretty / Pretty+debug / Raw) are React view modes, not pure filters.
 * Agent streams offer all three; other domains default to the raw feed mode.
 * See modesForStream().
 */
export const StreamViewMode = z.enum(["pretty", "pretty-debug", "raw"]);
export type StreamViewMode = z.infer<typeof StreamViewMode>;

export const StreamViewSearch = z.object({
  /** Active view mode; omitted on the stream's default (pretty for agents, raw otherwise). */
  mode: StreamViewMode.optional().catch(undefined),
  /**
   * Legacy Feed/State tab. Accepted so old links don't break; State is ignored
   * (use panel/processor). Prefer `mode`.
   */
  tab: z.enum(["feed", "state"]).optional().catch(undefined),
  /** Feed-items preset id for non-agent / Raw domain filters; omitted on default. */
  preset: z.string().optional().catch(undefined),
  /** Feed text search query. */
  q: z.string().optional().catch(undefined),
  /** Exact event-type filters (any-of) for the feed-items (Raw) mode. */
  types: z.array(z.string()).optional().catch(undefined),
  /** Inclusive lower offset bound for feed-items mode. */
  from: z.number().optional().catch(undefined),
  /** Inclusive upper offset bound for feed-items mode. */
  to: z.number().optional().catch(undefined),
  /** Offset of the raw event open in the inspector side panel. */
  event: z.number().optional().catch(undefined),
  /** Whether the mode's search/filter row is open. */
  filter: z.boolean().optional().catch(undefined),
  /** Whether the processors sheet is open (overview when processor is absent). */
  panel: z.boolean().optional().catch(undefined),
  /** Whether the events sheet is open (full-panel layouts only). */
  events: z.boolean().optional().catch(undefined),
  /** Subscription key of the processor focused in the sheet. */
  processor: z.string().optional().catch(undefined),
});

export type StreamViewSearch = z.infer<typeof StreamViewSearch>;

/** One header mode tab offered by a stream path. */
export type StreamModeDefinition = {
  id: StreamViewMode;
  label: string;
  /** Shell shows the filter icon only when true. */
  filters: boolean;
};

/**
 * Modes available on a stream. Agents get Pretty / Pretty+debug / Raw; every
 * other domain is a single implicit Raw feed (no mode tabs).
 */
export function modesForStream(streamPath: string): StreamModeDefinition[] {
  if (streamPath.startsWith("/agents/")) {
    return [
      { id: "pretty", label: "Pretty", filters: true },
      { id: "pretty-debug", label: "Pretty + debug", filters: true },
      { id: "raw", label: "Raw", filters: true },
    ];
  }
  return [];
}

export function defaultModeForStream(streamPath: string): StreamViewMode {
  return streamPath.startsWith("/agents/") ? "pretty" : "raw";
}

export function streamViewMode(search: StreamViewSearch, streamPath: string): StreamViewMode {
  if (search.mode != null) return search.mode;
  // Stale `tab=state` links no longer open a State tab; fall through to default.
  return defaultModeForStream(streamPath);
}

export function activeModeDefinition(
  search: StreamViewSearch,
  streamPath: string,
): StreamModeDefinition | null {
  const modes = modesForStream(streamPath);
  if (modes.length === 0) return null;
  const id = streamViewMode(search, streamPath);
  return modes.find((mode) => mode.id === id) ?? modes[0]!;
}

/**
 * Read and patch the stream-view search params. Patches merge into the current
 * params and `replace` history so mode/filter clicks don't pile up back-button
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
        // stream-view route), so without a `to`/`from` the search reducer's
        // inferred type collapses to `never`. The reducer below is written
        // type-safely against our schema; we only erase its type at this
        // un-narrowable assignment boundary.
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
 * inspector and the processors sheet. They share the same screen edge, so
 * every setter keeps them mutually exclusive; if a hand-edited URL asks for
 * both, the inspector wins.
 */
export function useStreamViewPanels(): {
  /** Offset open in the raw-event inspector; null = closed. */
  inspectedOffset: number | null;
  /** Subscription key of the processor focused in the sheet; null = overview. */
  focusedProcessorKey: string | null;
  processorsPanelOpen: boolean;
  inspectEvent: (offset: number) => void;
  closeInspector: () => void;
  /** Focusing a processor implies the sheet is open. */
  focusProcessor: (subscriptionKey: string) => void;
  openProcessorsOverview: () => void;
  closeProcessorsPanel: () => void;
} {
  const { search, setSearch } = useStreamViewSearch();
  const inspectedOffset = search.event ?? null;
  const focusedProcessorKey = search.processor ?? null;
  const processorsPanelOpen =
    inspectedOffset == null && (search.panel === true || focusedProcessorKey != null);
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
