import { z } from "zod";
import {
  DEFAULT_STREAM_RENDERER_MODE,
  streamRendererModes,
  type StreamRendererMode,
} from "~/lib/stream-feed-types.ts";

// Keep stream view state in the route search params so renderer choice and the
// currently open event sheet are shareable deep links instead of local UI state.
// TanStack Router docs:
// - Search params guide:
//   https://github.com/tanstack/router/blob/main/docs/router/guide/search-params.md
// - Navigate with search params:
//   https://github.com/tanstack/router/blob/main/docs/router/how-to/navigate-with-search-params.md
const StreamViewSearch = z.object({
  renderer: z.enum(streamRendererModes).optional(),
  event: z.coerce.number().int().positive().optional(),
});

type StreamViewSearch = {
  renderer: StreamRendererMode;
  event: number | undefined;
};

export const defaultStreamViewSearch: StreamViewSearch = {
  renderer: DEFAULT_STREAM_RENDERER_MODE,
  event: undefined,
};

export function validateStreamViewSearch(search: unknown): StreamViewSearch {
  // We intentionally return a fully resolved object with defaults applied so
  // route components do not need to reason about partial search state.
  const result = StreamViewSearch.safeParse(search);

  return {
    renderer: result.success
      ? (result.data.renderer ?? defaultStreamViewSearch.renderer)
      : defaultStreamViewSearch.renderer,
    event: result.success ? result.data.event : defaultStreamViewSearch.event,
  };
}
