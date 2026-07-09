import { useEffect } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { z } from "zod";
import { ProjectCreationProgress } from "~/components/project-creation-progress.tsx";
import { ProjectCustomDomainsSettings } from "~/components/project-custom-domains-settings.tsx";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { ONBOARDING_AGENT_PATH, hasActiveOnboardingAgent } from "~/lib/onboarding-agent.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useLiveState } from "~/itx/itx-react.tsx";

const HomeSearch = StreamViewSearch.extend({
  /** Set by the create form: play the creation checklist, then hand over to
   * the onboarding agent if this route is reached before the direct agent URL. */
  welcome: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  validateSearch: HomeSearch,
  ssr: false,
  loader: async ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
      streamBreadcrumb: streamBreadcrumb(context.project, "/"),
    }),
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
  const lifecycle = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
    [],
  );
  const created = lifecycle.value?.created ?? false;
  // Onboarding phase: the onboarding agent exists and it has not appended its
  // completion event yet. This can happen before `project/created` now that the
  // agent is born during project/create-requested.
  const agents = lifecycle.value?.agents ?? [];
  const inOnboarding =
    lifecycle.value === undefined
      ? false
      : hasActiveOnboardingAgent({ agents, onboardingActive: lifecycle.value.onboardingActive });
  const handOffToOnboarding = welcome === true && inOnboarding;

  // The welcome handoff: arrived here from an older create/root redirect, so as
  // soon as the onboarding agent exists, continue into that agent.
  useEffect(() => {
    if (!handOffToOnboarding) return;
    void navigate({
      to: "/projects/$projectSlug/agents/streams/$",
      params: { projectSlug: params.projectSlug, _splat: ONBOARDING_AGENT_PATH },
      // Fresh view state: don't carry this page's stream params (or `welcome`)
      // into the agent view.
      search: {},
      replace: true,
    });
  }, [handOffToOnboarding, navigate, params.projectSlug]);

  const panel =
    lifecycle.value === undefined && welcome !== true ? (
      // No push yet on a plain navigation: this is LOADING, not "creating"
      // — a fully created project must not flash the checklist.
      <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
        Loading project…
      </div>
    ) : created && !handOffToOnboarding ? (
      <>
        {inOnboarding ? (
          <Link
            to="/projects/$projectSlug/agents/streams/$"
            params={{ projectSlug: params.projectSlug, _splat: ONBOARDING_AGENT_PATH }}
            search={{}}
            className={buttonVariants({ size: "lg", className: "w-full" })}
          >
            Continue onboarding
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </Link>
        ) : null}
        <ProjectSettingsPanel project={project} routeConfig={routeConfig} />
        <ProjectCustomDomainsSettings
          projectId={project.id}
          projectState={lifecycle.value}
          routeConfig={routeConfig}
        />
      </>
    ) : (
      // Creating, or the welcome handoff is in flight (the effect above is
      // navigating): keep showing the checklist rather than flashing settings.
      <ProjectCreationProgress state={lifecycle.value} />
    );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={project.id}
      streamPath="/"
      emptyLabel="No events in the project root stream yet."
    />
  );
}
