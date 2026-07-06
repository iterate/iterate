import { Outlet, createFileRoute, notFound, redirect, useMatches } from "@tanstack/react-router";
import { ProcessorOverviewPage } from "~/components/event-docs-pages.tsx";
import { getProcessorDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/docs/streams/processors/$processorSlug")({
  component: ProcessorRoute,
});

function ProcessorRoute() {
  const matches = useMatches();
  const { processorSlug } = Route.useParams();
  const processor = getProcessorDocByPath(processorSlug);
  if (!processor) throw notFound();
  if (matches.at(-1)?.routeId === "/docs/streams/processors/$processorSlug/events/$") {
    return <Outlet />;
  }
  if (processor.slug !== processorSlug) throw redirect({ href: processor.href, replace: true });
  return <ProcessorOverviewPage processor={processor} />;
}
