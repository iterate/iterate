import { createFileRoute } from "@tanstack/react-router";
import { StreamPage } from "../-stream-page.tsx";
import { STREAM_VIEWS } from "../-stream-views.ts";

export const Route = createFileRoute("/streams/")({
  // Root stream view. Keep this in sync with `/streams/$` so `/streams?view=browser-state`
  // behaves exactly like `/streams/foo?view=browser-state`, just for path `/`.
  validateSearch: (search): { view: string } => ({
    view:
      typeof search.view === "string" && STREAM_VIEWS.some((entry) => entry.slug === search.view)
        ? search.view
        : "browser-raw-events",
  }),
  component: StreamsIndexRoute,
});

function StreamsIndexRoute() {
  const { view } = Route.useSearch();
  return <StreamPage streamPath="/" viewSlug={view} />;
}
