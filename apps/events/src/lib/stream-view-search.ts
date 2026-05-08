import { z } from "zod";
import type { EventsStreamElementType } from "@iterate-com/ui/components/events/stream-feed";
import {
  DEFAULT_STREAM_RENDERER_MODE,
  streamRendererModes,
  type StreamRendererMode,
} from "~/lib/stream-feed-types.ts";

export const streamComposerModes = ["json", "yaml", "agent"] as const;
const DEFAULT_STREAM_COMPOSER_MODE = "json" as const;
export const streamFeedViewModes = ["current", "clean"] as const;
const DEFAULT_STREAM_FEED_VIEW_MODE = "clean" as const;

export type StreamComposerMode = (typeof streamComposerModes)[number];
export type StreamFeedViewMode = (typeof streamFeedViewModes)[number];

// Keep stream view state in the route search params so renderer choice and the
// currently open event sheet are shareable deep links instead of local UI state.
// TanStack Router docs:
// - Search params guide:
//   https://github.com/tanstack/router/blob/main/docs/router/guide/search-params.md
// - Navigate with search params:
//   https://github.com/tanstack/router/blob/main/docs/router/how-to/navigate-with-search-params.md
const StreamViewSearch = z.object({
  renderer: z.enum(streamRendererModes).optional(),
  composer: z.enum(streamComposerModes).optional(),
  view: z.enum(streamFeedViewModes).optional(),
  event: z.coerce.number().int().positive().optional(),
  hiddenElements: z.union([z.string(), z.array(z.string())]).optional(),
});

type StreamViewSearch = {
  renderer: StreamRendererMode;
  composer: StreamComposerMode;
  view: StreamFeedViewMode;
  event: number | undefined;
  hiddenElements: EventsStreamElementType[];
};

export const defaultStreamViewSearch: StreamViewSearch = {
  renderer: DEFAULT_STREAM_RENDERER_MODE,
  composer: DEFAULT_STREAM_COMPOSER_MODE,
  view: DEFAULT_STREAM_FEED_VIEW_MODE,
  event: undefined,
  hiddenElements: [],
};

export function validateStreamViewSearch(search: unknown): StreamViewSearch {
  // We intentionally return a fully resolved object with defaults applied so
  // route components do not need to reason about partial search state.
  const result = StreamViewSearch.safeParse(search);

  return {
    renderer: result.success
      ? (result.data.renderer ?? defaultStreamViewSearch.renderer)
      : defaultStreamViewSearch.renderer,
    composer: result.success
      ? (result.data.composer ?? defaultStreamViewSearch.composer)
      : defaultStreamViewSearch.composer,
    view: result.success
      ? (result.data.view ?? defaultStreamViewSearch.view)
      : defaultStreamViewSearch.view,
    event: result.success ? result.data.event : defaultStreamViewSearch.event,
    hiddenElements: result.success
      ? parseHiddenElementsParam(result.data.hiddenElements)
      : defaultStreamViewSearch.hiddenElements,
  };
}

function parseHiddenElementsParam(
  value: string | readonly string[] | undefined,
): EventsStreamElementType[] {
  if (value == null) {
    return [];
  }

  const values = typeof value === "string" ? value.split(",") : value;

  return [
    ...new Set(values.map((type) => type.trim()).filter(Boolean)),
  ] as EventsStreamElementType[];
}
