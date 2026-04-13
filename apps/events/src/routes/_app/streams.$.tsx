import { useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { StreamPage } from "~/components/stream-page.tsx";
import { streamPathFromSplat } from "~/lib/stream-links.ts";
import { validateStreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/streams/$")({
  // Match the root stream route's validated search contract so a stream detail
  // URL can carry the same renderer and event-sheet state.
  validateSearch: validateStreamViewSearch,
  loader: ({ params }) => {
    const streamPath = streamPathFromSplat(params._splat);

    return {
      breadcrumb: streamPath,
      streamPath,
    };
  },
  component: StreamsDetailPage,
});

type StreamRouteSearch = ReturnType<typeof Route.useSearch>;

function StreamsDetailPage() {
  const { streamPath } = Route.useLoaderData();
  const { composer, event, renderer } = Route.useSearch();
  const navigate = Route.useNavigate();
  const updateEventOffset = useCallback(
    (nextEventOffset?: number) => {
      // Search state is the source of truth for the open event sheet, which is
      // why Prev/Next and deep links all update `event=<offset>` rather than
      // using a local `useState`.
      void navigate({
        search: (previous: StreamRouteSearch) => ({
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
      void navigate({
        search: (previous: StreamRouteSearch) => ({
          ...previous,
          renderer: nextRenderer,
        }),
        replace: true,
      });
    },
    [navigate],
  );
  const updateComposer = useCallback(
    (nextComposer: typeof composer) => {
      void navigate({
        search: (previous: StreamRouteSearch) => ({
          ...previous,
          composer: nextComposer,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <StreamPage
      streamPath={streamPath}
      rendererMode={renderer}
      composerMode={composer}
      openEventOffset={event}
      onOpenEventOffsetChange={updateEventOffset}
      onRendererModeChange={updateRenderer}
      onComposerModeChange={updateComposer}
    />
  );
}
