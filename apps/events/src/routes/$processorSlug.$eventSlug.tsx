import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProcessorEventPage } from "~/components/processor-doc-page.tsx";
import { getProcessorEventDoc } from "~/lib/processor-docs.ts";

export const Route = createFileRoute("/$processorSlug/$eventSlug")({
  component: ProcessorEventRoute,
});

function ProcessorEventRoute() {
  const { eventSlug, processorSlug } = Route.useParams();
  const event = getProcessorEventDoc({ processorSlug, eventSlug });
  if (event == null) {
    throw notFound();
  }

  return <ProcessorEventPage event={event} />;
}
