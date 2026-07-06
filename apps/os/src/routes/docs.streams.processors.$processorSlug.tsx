import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { getProcessorDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/docs/streams/processors/$processorSlug")({
  beforeLoad: ({ params }) => {
    const processor = getProcessorDocByPath(params.processorSlug);
    if (!processor) throw notFound();
    return { processor };
  },
  component: () => <Outlet />,
});
