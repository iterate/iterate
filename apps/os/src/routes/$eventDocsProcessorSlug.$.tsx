import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getEventDocsRouteTarget } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/$eventDocsProcessorSlug/$")({
  beforeLoad: ({ context, params }) => {
    if (!context.isEventDocsHost) throw notFound();

    const target = getEventDocsRouteTarget(params);
    if (!target) throw notFound();
    throw redirect({
      href: target.kind === "processor" ? target.processor.href : target.event.href,
      replace: true,
    });
  },
});
