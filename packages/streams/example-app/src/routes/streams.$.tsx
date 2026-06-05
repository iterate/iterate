import { createFileRoute } from "@tanstack/react-router";
import { STREAM_VIEWS } from "./-stream-views.ts";
import { StreamSplatRoute } from "./-stream-splat-route.tsx";

export const Route = createFileRoute("/streams/$")({
  // `?view=` selects which of the three sibling views renders. Unknown values fall back to
  // the default (raw-events) so a stale link can never render a missing view.
  validateSearch: (search): { view: string } => ({
    view:
      typeof search.view === "string" && STREAM_VIEWS.some((entry) => entry.slug === search.view)
        ? search.view
        : "browser-raw-events",
  }),
  component: StreamSplatRoute,
});
