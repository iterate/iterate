import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useLiveState } from "iterate/sdk/itx/react";
import { ProjectCreationProgress } from "~/components/project-creation-progress.tsx";
import { ProjectDashboard } from "~/components/project-dashboard.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { ONBOARDING_AGENT_PATH, isOnboardingActive } from "~/lib/onboarding-agent.ts";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";

const HomeSearch = z.object({
  /** Set by the create form: play the creation checklist until `ready`, then
   * hand over to the onboarding agent. */
  welcome: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  staticData: breadcrumbStaticData("Home"),
  validateSearch: HomeSearch,
  ssr: false,
  component: ProjectHomePage,
});

/**
 * Project home is the lightweight dashboard (new-agent composer + recent
 * agents). Welcome/create still lands here with `?welcome` and hands off to
 * the onboarding agent after bootstrap — settings live at `/settings`.
 */
function ProjectHomePage() {
  const { project } = Route.useRouteContext();
  const { welcome } = Route.useSearch();
  const params = Route.useParams();
  const navigate = useNavigate();
  const lifecycle = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
    [project.id],
    { slug: project.id },
  );
  const ready = lifecycle.value?.ready ?? false;
  const inOnboarding = lifecycle.value === undefined ? false : isOnboardingActive(lifecycle.value);
  // Create lands here with `welcome` as soon as the project exists. Stay on
  // the checklist until bootstrap flips `ready`, then hand off to the
  // onboarding agent so the user watches the saga rather than waiting on the
  // create button.
  const handOffToOnboarding = welcome === true && ready && inOnboarding;
  // Only the create/welcome flow shows the bootstrap checklist. Once ready and
  // onboarding is done (or never started), fall through to the dashboard even
  // if a stale `?welcome` is still on the URL.
  const showWelcomeChecklist =
    welcome === true &&
    (lifecycle.value === undefined || !ready || inOnboarding || handOffToOnboarding);

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

  // Drop a leftover `?welcome` once the checklist is no longer the right UI.
  useEffect(() => {
    if (welcome !== true || showWelcomeChecklist) return;
    void navigate({
      to: "/projects/$projectSlug",
      params: { projectSlug: params.projectSlug },
      search: {},
      replace: true,
    });
  }, [navigate, params.projectSlug, showWelcomeChecklist, welcome]);

  if (showWelcomeChecklist) {
    return (
      <ProjectStreamView
        panel={<ProjectCreationProgress state={lifecycle.value} />}
        projectId={project.id}
        streamPath="/"
        emptyLabel="No events in the project root stream yet."
      />
    );
  }

  return (
    <ProjectDashboard
      projectId={project.id}
      projectSlug={params.projectSlug}
      showContinueOnboarding={inOnboarding}
    />
  );
}
