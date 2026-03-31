import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamMetadataUpdatedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-metadata-updated")({
  component: StreamMetadataUpdatedPageRoute,
});

function StreamMetadataUpdatedPageRoute() {
  return <EventTypePageView page={streamMetadataUpdatedPage} />;
}
