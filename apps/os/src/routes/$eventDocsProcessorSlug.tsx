import { Outlet, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getProcessorDocByPath } from "~/lib/event-docs.ts";

export const Route = createFileRoute("/$eventDocsProcessorSlug")({
  beforeLoad: ({ context, location, params }) => {
    if (!context.isEventDocsHost) throw notFound();

    const pathSegments = location.pathname.split("/").filter(Boolean);
    if (pathSegments.length !== 1) return;

    const processor = getProcessorDocByPath(params.eventDocsProcessorSlug);
    if (!processor) throw notFound();
    throw redirect({ href: processor.href, replace: true });
  },
  component: () => <Outlet />,
});
