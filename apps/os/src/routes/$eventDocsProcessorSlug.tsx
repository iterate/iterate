import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProcessorOverviewPage } from "~/components/docs-portal.tsx";
import { getProcessorDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/$eventDocsProcessorSlug")({
  beforeLoad: ({ context }) => {
    if (!context.isEventDocsHost) throw notFound();
  },
  component: EventDocsProcessorAliasRoute,
});

function EventDocsProcessorAliasRoute() {
  const { eventDocsProcessorSlug } = Route.useParams();
  const processor = getProcessorDocByPath(eventDocsProcessorSlug);
  if (!processor) throw notFound();
  return <ProcessorOverviewPage processor={processor} />;
}
