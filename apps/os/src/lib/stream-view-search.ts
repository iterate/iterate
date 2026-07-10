import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";

/**
 * URL-backed view state for ProjectStreamView. Every route that mounts a
 * stream view registers this schema in its `validateSearch` — directly or via
 * `.extend()` — so the component reads/writes mode, filter, and processor-
 * sidebar state through the URL and every view is shareable.
 *
 * Modes (Pretty / Pretty+raw / Raw) are React view modes. Agent streams offer
 * all three; other domains default to raw. Pretty+raw = pretty agent feed +
 * raw feed_items (with the event inspector). Filters encode both feed-item
 * *components* and contained raw *event types* (see stream-feed-filters.ts).
 */
const StreamViewModeRaw = z.enum(["pretty", "pretty-raw", "raw", "pretty-debug"]);
export type StreamViewMode = "pretty" | "pretty-raw" | "raw";

export const StreamViewSearch = z.object({
  /**
   * Active view mode; omitted on the stream's default (pretty for agents, raw
   * otherwise). `pretty-debug` is accepted as a legacy alias of `pretty-raw`.
   */
  mode: StreamViewModeRaw.optional().catch(undefined),
  /**
   * Legacy Feed/State tab. Accepted so old links don't break; State is ignored
   * (use panel/processor). Prefer `mode`.
   */
  tab: z.enum(["feed", "state"]).optional().catch(undefined),
  /** Feed-items domain preset id; omitted on default. */
  preset: z.string().optional().catch(undefined),
  /** Text query (agent feed and/or feed_items, depending on mode). */
  q: z.string().optional().catch(undefined),
  /**
   * Event-type filter (any-of) for feed_items rows — matches the primary event
   * type of a group or singleton (see FEED_TYPE_EXPRESSION).
   */
  types: z.array(z.string()).optional().catch(undefined),
  /**
   * Raw feed-item *kind* filter (any-of) — `feed_items.kind` values such as
   * `raw.group`, `raw.stream.woken`, `raw.stream.child-stream-created`.
   */
  components: z.array(z.string()).optional().catch(undefined),
  /** Legacy Pretty+raw raw-rail toggle. Accepted so old links keep parsing. */
  raw: z.boolean().optional().catch(undefined),
  /** Inclusive lower offset bound for feed_items. */
  from: z.number().optional().catch(undefined),
  /** Inclusive upper offset bound for feed_items. */
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

/** What filter / body surfaces a mode exposes. Modes encode this as the preset. */
type StreamModeCapabilities = {
  /** Agent chat rows (feed_items kind `agent.*`). */
  agentFeed: boolean;
  /** Include agent debug kinds (wakes, etc.) in the agent rows. */
  agentShowDebug: boolean;
  /** Raw rows (feed_items kind `raw.*`). */
  rawFeed: boolean;
  /** Raw event inspector (`?event=`) is meaningful. */
  eventInspector: boolean;
  /** Shell filter icon. */
  filters: boolean;
  /** Search box in the filter row. */
  search: boolean;
  /** Domain feed-items preset pills. */
  rawPresets: boolean;
  /** Event-type multi-select (types inside feed items). */
  rawEventTypes: boolean;
  /** Raw kind multi-select (feed_items.kind, raw.* family). */
  rawComponents: boolean;
  /** Offset from/to bounds. */
  rawOffsets: boolean;
};

const PRETTY_CAPS: StreamModeCapabilities = {
  agentFeed: true,
  agentShowDebug: false,
  rawFeed: false,
  eventInspector: false,
  filters: true,
  search: true,
  rawPresets: false,
  rawEventTypes: false,
  rawComponents: false,
  rawOffsets: false,
};

const PRETTY_RAW_CAPS: StreamModeCapabilities = {
  agentFeed: true,
  agentShowDebug: true,
  rawFeed: true,
  eventInspector: true,
  filters: true,
  search: true,
  rawPresets: false,
  rawEventTypes: true,
  rawComponents: true,
  rawOffsets: false,
};

const RAW_CAPS: StreamModeCapabilities = {
  agentFeed: false,
  agentShowDebug: false,
  rawFeed: true,
  eventInspector: true,
  filters: true,
  search: true,
  rawPresets: true,
  rawEventTypes: true,
  rawComponents: true,
  rawOffsets: true,
};

/** One header mode tab offered by a stream path. */
type StreamModeDefinition = {
  id: StreamViewMode;
  label: string;
  capabilities: StreamModeCapabilities;
};

/**
 * Modes available on a stream. Agents get Pretty / Pretty+raw / Raw; every
 * other domain is a single implicit Raw feed (no mode tabs).
 */
export function modesForStream(streamPath: string): StreamModeDefinition[] {
  if (streamPath.startsWith("/agents/")) {
    return [
      { id: "pretty", label: "Pretty", capabilities: PRETTY_CAPS },
      { id: "pretty-raw", label: "Pretty + raw", capabilities: PRETTY_RAW_CAPS },
      { id: "raw", label: "Raw", capabilities: RAW_CAPS },
    ];
  }
  return [];
}

export function defaultModeForStream(streamPath: string): StreamViewMode {
  return streamPath.startsWith("/agents/") ? "pretty" : "raw";
}

/** Normalize legacy `pretty-debug` → `pretty-raw`. */
function normalizeStreamViewMode(
  mode: z.infer<typeof StreamViewModeRaw> | undefined,
): StreamViewMode | undefined {
  if (mode == null) return undefined;
  if (mode === "pretty-debug") return "pretty-raw";
  return mode;
}

/**
 * Resolve the active mode for a stream. Unknown or unsupported modes
 * (e.g. `pretty` on a secrets stream) fall back to the stream default so
 * filter/body surfaces stay consistent with the header.
 */
export function streamViewMode(search: StreamViewSearch, streamPath: string): StreamViewMode {
  const requested = normalizeStreamViewMode(search.mode);
  if (requested == null) return defaultModeForStream(streamPath);
  const offered = modesForStream(streamPath);
  // Non-agent streams have no mode tabs — only `raw` is valid (implicit).
  if (offered.length === 0) return "raw";
  return offered.some((entry) => entry.id === requested)
    ? requested
    : defaultModeForStream(streamPath);
}

export function modeCapabilities(
  search: StreamViewSearch,
  streamPath: string,
): StreamModeCapabilities {
  const mode = streamViewMode(search, streamPath);
  const base = mode === "pretty" ? PRETTY_CAPS : mode === "pretty-raw" ? PRETTY_RAW_CAPS : RAW_CAPS;
  return base;
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
 * inspector, the processors sheet, and (on full-panel layouts) the Events
 * sheet. They share the same screen edge, so every setter keeps them
 * mutually exclusive; if a hand-edited URL asks for more than one, the
 * inspector beats the processors sheet, which beats the Events sheet.
 * (The inspector renders INSIDE the Events sheet's feed, so those two
 * compose rather than compete.)
 */
export function useStreamViewPanels(): {
  inspectedOffset: number | null;
  focusedProcessorKey: string | null;
  processorsPanelOpen: boolean;
  eventsSheetOpen: boolean;
  inspectEvent: (offset: number) => void;
  closeInspector: () => void;
  focusProcessor: (subscriptionKey: string) => void;
  openProcessorsOverview: () => void;
  closeProcessorsPanel: () => void;
  openEventsSheet: () => void;
  closeEventsSheet: () => void;
} {
  const { search, setSearch } = useStreamViewSearch();
  const inspectedOffset = search.event ?? null;
  const focusedProcessorKey = search.processor ?? null;
  const processorsPanelOpen =
    inspectedOffset == null && (search.panel === true || focusedProcessorKey != null);
  const eventsSheetOpen = search.events === true && !processorsPanelOpen;
  const inspectEvent = useCallback(
    (offset: number) => setSearch({ event: offset, panel: undefined, processor: undefined }),
    [setSearch],
  );
  const closeInspector = useCallback(() => setSearch({ event: undefined }), [setSearch]);
  const focusProcessor = useCallback(
    (subscriptionKey: string) =>
      setSearch({ panel: true, processor: subscriptionKey, event: undefined, events: undefined }),
    [setSearch],
  );
  const openProcessorsOverview = useCallback(
    () => setSearch({ panel: true, processor: undefined, event: undefined, events: undefined }),
    [setSearch],
  );
  const closeProcessorsPanel = useCallback(
    () => setSearch({ panel: undefined, processor: undefined }),
    [setSearch],
  );
  const openEventsSheet = useCallback(
    () => setSearch({ events: true, panel: undefined, processor: undefined }),
    [setSearch],
  );
  const closeEventsSheet = useCallback(() => setSearch({ events: undefined }), [setSearch]);
  return {
    inspectedOffset,
    focusedProcessorKey,
    processorsPanelOpen,
    eventsSheetOpen,
    inspectEvent,
    closeInspector,
    focusProcessor,
    openProcessorsOverview,
    closeProcessorsPanel,
    openEventsSheet,
    closeEventsSheet,
  };
}
