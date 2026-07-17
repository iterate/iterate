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
const StreamViewModeRaw = z.enum(["pretty", "pretty-raw", "raw"]);
export type StreamViewMode = "pretty" | "pretty-raw" | "raw";

export const StreamViewSearch = z.object({
  /**
   * Active view mode; omitted on the stream's default (pretty for agents, raw
   * otherwise).
   */
  mode: StreamViewModeRaw.optional().catch(undefined),
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
  /** Inclusive lower offset bound for feed_items. */
  from: z.number().optional().catch(undefined),
  /** Inclusive upper offset bound for feed_items. */
  to: z.number().optional().catch(undefined),
  /** Offset of the raw event open in the inspector side panel. */
  event: z.number().optional().catch(undefined),
  /** llm-request-requested offset open in the LLM request inspector panel. */
  llmRequest: z.number().int().positive().optional().catch(undefined),
  /** Script execution id open in the code/result inspector panel. */
  scriptExecution: z
    .union([z.string().min(1), z.number().finite()])
    .transform(String)
    .optional()
    .catch(undefined),
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

/**
 * Resolve the active mode for a stream. Unknown or unsupported modes
 * (e.g. `pretty` on a secrets stream) fall back to the stream default so
 * filter/body surfaces stay consistent with the header.
 */
export function streamViewMode(search: StreamViewSearch, streamPath: string): StreamViewMode {
  const requested = search.mode;
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
 * Every key that claims the stream view's right screen edge. Openers spread
 * this before setting their own key, so mutual exclusion is structural — a
 * new edge surface joins by adding its key here rather than patching every
 * other opener. (`events` is deliberately absent: the inspectors render
 * INSIDE the Events sheet's feed, so they compose with it rather than
 * compete; the processor sheet openers clear it themselves.)
 */
const RELEASE_PANEL_EDGE = {
  event: undefined,
  llmRequest: undefined,
  scriptExecution: undefined,
  panel: undefined,
  processor: undefined,
} satisfies Partial<StreamViewSearch>;

/**
 * URL state for the stream view's right-edge sheets — the raw-event
 * inspector, the LLM request inspector, the script execution inspector, the
 * processors sheet, and (on full-panel layouts) the Events sheet. They share
 * the same screen edge, so every setter keeps them mutually exclusive; if a
 * hand-edited URL asks for more than one, an inspector beats the processors
 * sheet, which beats the Events sheet (StreamInspectorSheet owns inspector
 * precedence because it knows which modes can render the raw inspector).
 */
export function useStreamViewPanels(): {
  inspectedOffset: number | null;
  inspectedLlmRequestOffset: number | null;
  inspectedScriptExecutionId: string | null;
  focusedProcessorKey: string | null;
  processorsPanelOpen: boolean;
  eventsSheetOpen: boolean;
  inspectEvent: (offset: number) => void;
  closeInspector: () => void;
  inspectLlmRequest: (llmRequestOffset: number) => void;
  inspectScriptExecution: (executionId: string) => void;
  focusProcessor: (subscriptionKey: string) => void;
  openProcessorsOverview: () => void;
  closeProcessorsPanel: () => void;
  openEventsSheet: () => void;
  closeEventsSheet: () => void;
} {
  const { search, setSearch } = useStreamViewSearch();
  const inspectedOffset = search.event ?? null;
  // Inspector identifiers are surfaced as-is. Openers keep them mutually
  // exclusive, so multiple values mean a stale or hand-edited URL; precedence
  // is the RENDERER's call (StreamInspectorSheet), because only it knows
  // whether the active mode can actually show the raw inspector.
  const inspectedLlmRequestOffset = search.llmRequest ?? null;
  const inspectedScriptExecutionId = search.scriptExecution ?? null;
  const focusedProcessorKey = search.processor ?? null;
  const inspectorOpen =
    inspectedOffset != null ||
    inspectedLlmRequestOffset != null ||
    inspectedScriptExecutionId != null;
  const processorsPanelOpen =
    !inspectorOpen && (search.panel === true || focusedProcessorKey != null);
  // Full-panel layouts render inspectors inside the Events sheet. A direct
  // `?llmRequest=` / `?scriptExecution=` link therefore opens that containing
  // sheet even when `events=true` was not part of the shared URL.
  const eventsSheetOpen = !processorsPanelOpen && (search.events === true || inspectorOpen);
  const inspectEvent = useCallback(
    (offset: number) => setSearch({ ...RELEASE_PANEL_EDGE, event: offset }),
    [setSearch],
  );
  const closeInspector = useCallback(
    () =>
      setSearch({
        event: undefined,
        llmRequest: undefined,
        scriptExecution: undefined,
      }),
    [setSearch],
  );
  const inspectLlmRequest = useCallback(
    (llmRequestOffset: number) =>
      setSearch({ ...RELEASE_PANEL_EDGE, llmRequest: llmRequestOffset }),
    [setSearch],
  );
  const inspectScriptExecution = useCallback(
    (executionId: string) => setSearch({ ...RELEASE_PANEL_EDGE, scriptExecution: executionId }),
    [setSearch],
  );
  const focusProcessor = useCallback(
    (subscriptionKey: string) =>
      setSearch({
        ...RELEASE_PANEL_EDGE,
        events: undefined,
        panel: true,
        processor: subscriptionKey,
      }),
    [setSearch],
  );
  const openProcessorsOverview = useCallback(
    () => setSearch({ ...RELEASE_PANEL_EDGE, events: undefined, panel: true }),
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
  const closeEventsSheet = useCallback(
    () =>
      setSearch({
        event: undefined,
        events: undefined,
        llmRequest: undefined,
        scriptExecution: undefined,
      }),
    [setSearch],
  );
  return {
    inspectedOffset,
    inspectedLlmRequestOffset,
    inspectedScriptExecutionId,
    focusedProcessorKey,
    processorsPanelOpen,
    eventsSheetOpen,
    inspectEvent,
    closeInspector,
    inspectLlmRequest,
    inspectScriptExecution,
    focusProcessor,
    openProcessorsOverview,
    closeProcessorsPanel,
    openEventsSheet,
    closeEventsSheet,
  };
}
