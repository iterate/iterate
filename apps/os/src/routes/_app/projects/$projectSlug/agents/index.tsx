import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveState } from "iterate/sdk/itx/react";
import { AgentCatalog } from "~/components/agents/agent-catalog.tsx";
import { updateAgentSummary } from "~/components/agents/agent-summary.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { AgentCatalogSearch } from "~/lib/agent-catalog-search.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

const AGENTS_ROOT = "/agents";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/")({
  staticData: streamPageStaticData(),
  validateSearch: AgentCatalogSearch,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, AGENTS_ROOT),
    }),
  component: ProjectAgentsIndexContent,
});

function ProjectAgentsIndexContent() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const { project } = Route.useLoaderData();
  const navigate = useNavigate();
  const agents = useLiveState(
    (projectItx) => projectItx.agents.liveState,
    (state) => state.agents,
    [],
  ).value;

  return (
    <ProjectStreamView
      layout="fullPanel"
      panel={
        <AgentCatalog
          agents={agents}
          projectId={project.id}
          projectSlug={params.projectSlug}
          view={search.view}
          onViewChange={(view) =>
            void navigate({
              to: "/projects/$projectSlug/agents",
              params,
              search: (previous) => ({ ...previous, view }),
              replace: true,
            })
          }
          onOpen={(path) => void navigate(linkOptionsForStreamPath(params.projectSlug, path))}
          onTogglePinned={(agent) =>
            updateAgentSummary(project.id, agent.path, { pinned: !agent.summary.pinned })
          }
        />
      }
      projectId={project.id}
      streamPath={AGENTS_ROOT}
      emptyLabel="No events on the agents catalog stream yet."
    />
  );
}
