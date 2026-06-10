import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProcessorOverviewPage } from "~/components/docs-portal.tsx";
import { getProcessorDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/docs/streams/processors/$processorSlug")({
  component: ProcessorRoute,
});

function ProcessorRoute() {
  const { processorSlug } = Route.useParams();
  const processor = getProcessorDocByPath(processorSlug);
  if (!processor) throw notFound();
  return <ProcessorOverviewPage processor={processor} />;
}
