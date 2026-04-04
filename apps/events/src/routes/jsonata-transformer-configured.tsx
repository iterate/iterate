import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { jsonataTransformerConfiguredPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/jsonata-transformer-configured")({
  component: JsonataTransformerConfiguredPageRoute,
});

function JsonataTransformerConfiguredPageRoute() {
  return <EventTypePageView page={jsonataTransformerConfiguredPage} />;
}
