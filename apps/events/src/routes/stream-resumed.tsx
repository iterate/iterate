import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamResumedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-resumed")({
  component: StreamResumedPageRoute,
});

function StreamResumedPageRoute() {
  return <EventTypePageView page={streamResumedPage} />;
}
