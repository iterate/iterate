import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamPausedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-paused")({
  component: StreamPausedPageRoute,
});

function StreamPausedPageRoute() {
  return <EventTypePageView page={streamPausedPage} />;
}
