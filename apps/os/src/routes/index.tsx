import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTargetFromSession } from "../lib/auth.ts";
import { EventDocsIndexPage } from "~/components/event-docs-pages.tsx";
import { eventDocs, processorDocs } from "~/lib/event-docs.ts";
import { getRootProjectRedirectServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/")({
  loader: async ({ context, location }) => {
    if (context.isEventDocsHost) {
      return { kind: "event-docs" as const };
    }

    const target = requireAuthenticatedRootRedirectTargetFromSession(
      context.authSession,
      location,
      context.iterateAuthIssuer,
      context.currentProjectHostSlug,
      context.authError,
      context.appOrigin,
    );

    const decision = await getRootProjectRedirectServerFn({
      data: { preferredProjectSlug: target.projectSlug },
    });

    if (decision.kind === "project") {
      throw redirect({
        to: "/projects/$projectSlug",
        params: { projectSlug: decision.project.slug },
        search: decision.welcome ? { welcome: true } : {},
        replace: true,
      });
    }

    throw redirect({
      to: "/projects",
      replace: true,
    });
  },
  component: IndexRoute,
});

function IndexRoute() {
  const data = Route.useLoaderData();
  if (data?.kind !== "event-docs") return null;
  return <EventDocsIndexPage eventDocs={eventDocs} processorDocs={processorDocs} />;
}
