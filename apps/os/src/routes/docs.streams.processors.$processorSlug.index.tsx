import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProcessorOverviewPage } from "~/components/event-docs-pages.tsx";

export const Route = createFileRoute("/docs/streams/processors/$processorSlug/")({
  beforeLoad: ({ context, params }) => {
    if (context.processor.slug !== params.processorSlug) {
      throw redirect({ href: context.processor.href, replace: true });
    }
  },
  component: ProcessorIndexRoute,
});

function ProcessorIndexRoute() {
  const { processor } = Route.useRouteContext();
  return <ProcessorOverviewPage processor={processor} />;
}
