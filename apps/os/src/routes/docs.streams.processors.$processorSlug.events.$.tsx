import { createFileRoute, notFound } from "@tanstack/react-router";
import { EventDocPage } from "~/components/docs-portal.tsx";
import { getEventDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/docs/streams/processors/$processorSlug/events/$")({
  component: ProcessorEventRoute,
});

function ProcessorEventRoute() {
  const { _splat, processorSlug } = Route.useParams();
  if (!_splat) throw notFound();
  const event = getEventDocByPath(`${processorSlug}/${_splat}`) ?? getEventDocByPath(_splat);
  if (!event) throw notFound();
  return <EventDocPage event={event} />;
}
