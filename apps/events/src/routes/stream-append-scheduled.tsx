import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamAppendScheduledPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-append-scheduled")({
  component: StreamAppendScheduledPageRoute,
});

function StreamAppendScheduledPageRoute() {
  return <EventTypePageView page={streamAppendScheduledPage} />;
}
