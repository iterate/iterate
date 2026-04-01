import { useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { StreamPage } from "~/components/stream-page.tsx";
import { ROOT_STREAM_PATH } from "~/lib/utils.ts";
import { validateStreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/streams/")({
  // Root stream and child-stream routes share the same view-state contract so
  // the header controls work the same way on `/streams/` and `/streams/$`.
  validateSearch: validateStreamViewSearch,
  loader: () => ({
    breadcrumb: ROOT_STREAM_PATH,
  }),
  component: StreamsIndexPage,
});

function StreamsIndexPage() {
  const { event, renderer } = Route.useSearch();
  const navigate = Route.useNavigate();
  const updateEventOffset = useCallback(
    (nextEventOffset?: number) => {
      // TanStack Router's functional `search` updater preserves sibling view
      // state while only changing the event currently shown in the sheet.
      void navigate({
        search: (previous) => ({
          ...previous,
          event: nextEventOffset,
        }),
        replace: true,
      });
    },
    [navigate],
  );
  const updateRenderer = useCallback(
    (nextRenderer: typeof renderer) => {
      // Renderer mode is URL state on purpose so switching between pretty/raw
      // survives refresh and can be shared as a link.
      void navigate({
        search: (previous) => ({
          ...previous,
          renderer: nextRenderer,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <StreamPage
      streamPath={ROOT_STREAM_PATH}
      rendererMode={renderer}
      openEventOffset={event}
      onOpenEventOffsetChange={updateEventOffset}
      onRendererModeChange={updateRenderer}
    />
  );
}
