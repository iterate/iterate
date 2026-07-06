import { createFileRoute, notFound } from "@tanstack/react-router";
import { EventDocPage } from "~/components/event-docs-pages.tsx";
import { getEventDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/$eventDocsProcessorSlug/$")({
  beforeLoad: ({ context }) => {
    if (!context.isEventDocsHost) throw notFound();
  },
  component: EventDocsEventRoute,
});

function EventDocsEventRoute() {
  const { _splat, eventDocsProcessorSlug } = Route.useParams();
  if (!_splat) throw notFound();
  const event = getEventDocByPath(`${eventDocsProcessorSlug}/${_splat}`);
  if (!event) throw notFound();
  return <EventDocPage event={event} />;
}
