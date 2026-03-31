import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamCreatedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-created")({
  component: StreamCreatedPage,
});

function StreamCreatedPage() {
  return <EventTypePageView page={streamCreatedPage} />;
}
