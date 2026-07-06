import { createFileRoute } from "@tanstack/react-router";
import { EventDocsIndexPage } from "~/components/event-docs-pages.tsx";
import { eventDocs, processorDocs } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/docs/streams/processors/")({
  component: () => <EventDocsIndexPage eventDocs={eventDocs} processorDocs={processorDocs} />,
});
