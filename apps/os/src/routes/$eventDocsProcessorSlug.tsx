import { Outlet, createFileRoute, notFound, useMatches } from "@tanstack/react-router";
import { ProcessorOverviewPage } from "~/components/event-docs-pages.tsx";
import { getProcessorDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/$eventDocsProcessorSlug")({
  beforeLoad: ({ context }) => {
    if (!context.isEventDocsHost) throw notFound();
  },
  component: EventDocsProcessorRoute,
});

function EventDocsProcessorRoute() {
  const matches = useMatches();
  const { eventDocsProcessorSlug } = Route.useParams();
  if (matches.at(-1)?.routeId === "/$eventDocsProcessorSlug/$") return <Outlet />;

  const processor = getProcessorDocByPath(eventDocsProcessorSlug);
  if (!processor) throw notFound();
  return <ProcessorOverviewPage processor={processor} />;
}
