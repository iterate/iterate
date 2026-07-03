import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ProjectCreationProgress } from "~/components/project-creation-progress.tsx";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { StreamPage } from "~/components/stream-page.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { StreamPath } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItxState } from "~/itx/itx-react.tsx";
import type { ProjectProcessorState } from "~/types.ts";

const HomeSearch = StreamViewSearch.extend({
  /** Set by the create form: play the creation checklist, then hand over to
   * the onboarding agent the moment the bootstrap saga lands. */
  welcome: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  validateSearch: HomeSearch,
  ssr: false,
  loader: async ({ context, params }) => {
    return breadcrumbLoaderData({
      breadcrumb: "Home",
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
      streamBreadcrumb: {
        projectId: context.project.id,
        projectSlug: params.projectSlug,
        streamPath: StreamPath.parse("/"),
      },
    });
  },
  component: ProjectHomePage,
});

/**
 * The project home is the project ROOT STREAM's page: the stream takes the
 * main space, and the project's reduced state renders live in the side panel.
 * Until the bootstrap saga commits `project/created`, that panel is the
 * creation checklist (create redirects here immediately, before the saga
 * finishes, and every tick arrives as a processor push); afterwards it is the
 * settings view.
 */
function ProjectHomePage() {
  const { project, routeConfig } = Route.useLoaderData();
  const { welcome } = Route.useSearch();
  const params = Route.useParams();
  const navigate = useNavigate();
  const lifecycle = useItxState<ProjectProcessorState>(
    (itx, setState) => itx.processor.onStateChange(setState),
    [],
  );
  const created = lifecycle.state?.created ?? false;

  // The welcome handoff: arrived here from the create form, so once the saga
  // commits `project/created` (a push flips `created` live — possibly before
  // first paint on a fast deployment), continue into the onboarding agent.
  useEffect(() => {
    if (welcome !== true || !created) return;
    void navigate({
      to: "/projects/$projectSlug/agents/streams/$",
      params: { projectSlug: params.projectSlug, _splat: "/agents/onboarding" },
      replace: true,
    });
  }, [welcome, created, navigate, params.projectSlug]);

  const panel =
    lifecycle.state === undefined && welcome !== true ? (
      // No push yet on a plain navigation: this is LOADING, not "creating"
      // — a fully created project must not flash the checklist.
      <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
        Loading project…
      </div>
    ) : created && welcome !== true ? (
      <ProjectSettingsPanel project={project} routeConfig={routeConfig} />
    ) : (
      // Creating, or the welcome handoff is in flight (the effect above is
      // navigating): keep showing the checklist rather than flashing settings.
      <ProjectCreationProgress state={lifecycle.state} />
    );

  return (
    <StreamPage
      panel={panel}
      projectId={project.id}
      streamPath="/"
      emptyLabel="No events in the project root stream yet."
    />
  );
}
