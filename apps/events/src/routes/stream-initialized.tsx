import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamInitializedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-initialized")({
  component: StreamInitializedPage,
});

function StreamInitializedPage() {
  return <EventTypePageView page={streamInitializedPage} />;
}
