import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { EventDocPage } from "~/components/event-docs-pages.tsx";
import { getEventDocByProcessorRoute } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/docs/streams/processors/$processorSlug/events/$")({
  component: ProcessorEventRoute,
});

function ProcessorEventRoute() {
  const { _splat, processorSlug } = Route.useParams();
  if (!_splat) throw notFound();
  const event = getEventDocByProcessorRoute({ processorSlug, eventPath: _splat });
  if (!event) throw notFound();
  if (event.routeParams.processorSlug !== processorSlug || event.routeParams._splat !== _splat) {
    throw redirect({ href: event.href, replace: true });
  }
  return <EventDocPage event={event} />;
}
