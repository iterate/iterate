import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { getProcessorDocBySlug } from "~/lib/processor-docs.ts";

export const Route = createFileRoute("/$processorSlug")({
  beforeLoad: ({ params }) => {
    const processor = getProcessorDocBySlug(params.processorSlug);
    if (processor == null) {
      throw notFound();
    }
  },
  component: ProcessorRoute,
});

function ProcessorRoute() {
  return <Outlet />;
}
