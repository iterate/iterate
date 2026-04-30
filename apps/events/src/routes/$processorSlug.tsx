import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProcessorOverviewPage } from "~/components/processor-doc-page.tsx";
import { getProcessorDocBySlug } from "~/lib/processor-docs.ts";

export const Route = createFileRoute("/$processorSlug")({
  component: ProcessorRoute,
});

function ProcessorRoute() {
  const { processorSlug } = Route.useParams();
  const processor = getProcessorDocBySlug(processorSlug);
  if (processor == null) {
    throw notFound();
  }

  return <ProcessorOverviewPage processor={processor} />;
}
