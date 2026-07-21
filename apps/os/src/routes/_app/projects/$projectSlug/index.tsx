import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useLiveState } from "iterate/sdk/itx/react";
import { ProjectCreationProgress } from "~/components/project-creation-progress.tsx";
import { ProjectDashboard } from "~/components/project-dashboard.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { ONBOARDING_AGENT_PATH, isOnboardingActive } from "~/lib/onboarding-agent.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

const HomeSearch = StreamViewSearch.extend({
  /** Set by the create form: play the creation checklist until `ready`, then
   * hand over to the onboarding agent. */
  welcome: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  // Explicitly blank the label ("" suppresses the project layout's slug
  // fallback): the dashboard header shows only the Navigate ⌘K control.
  staticData: { breadcrumb: "" },
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
  // The checklist gates on the PROJECT's state, not the URL: any visit to a
  // not-yet-ready project (second tab, bookmark) sees the creation saga, never
  // a live dashboard. Before the first push we only know we're mid-create when
  // the create flow's `?welcome` says so; the handoff case keeps the checklist
  // up while its navigation is in flight.
  const showChecklist =
    lifecycle.value === undefined ? welcome === true : !ready || handOffToOnboarding;

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
  // A client-side effect (not beforeLoad) because the decision needs live
  // project state that only exists after the LiveState push arrives.
  useEffect(() => {
    if (welcome !== true || showChecklist) return;
    void navigate({
      to: "/projects/$projectSlug",
      params: { projectSlug: params.projectSlug },
      search: {},
      replace: true,
    });
  }, [navigate, params.projectSlug, showChecklist, welcome]);

  if (showChecklist) {
    return (
      <ProjectStreamView
        panel={<ProjectCreationProgress state={lifecycle.value} />}
        projectId={project.id}
        streamPath="/"
        emptyLabel="No events in the project root stream yet."
        // This route is not a stream page (no streamPageStaticData), so the
        // shell renders its own header — suppress the stream view's or the
        // checklist gets two stacked headers.
        showHeader={false}
      />
    );
  }

  // Before the first LiveState push we can't tell ready from mid-create:
  // hold a loading state rather than flashing a live composer at a project
  // that may still be bootstrapping.
  if (lifecycle.value === undefined) {
    return (
      <main className="flex min-h-full flex-1 items-center justify-center p-4">
        <p className="text-sm text-muted-foreground" data-spinner="true">
          Loading project…
        </p>
      </main>
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
