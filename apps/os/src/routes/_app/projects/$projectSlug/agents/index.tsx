import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveState } from "iterate/react";
import { AgentCatalog } from "~/components/agents/agent-catalog.tsx";
import { patchAgentMetadata } from "~/components/agents/agent-metadata.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

const AGENTS_ROOT = "/agents";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
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
          projectSlug={params.projectSlug}
          onOpen={(path) => void navigate(linkOptionsForStreamPath(params.projectSlug, path))}
          onTogglePinned={(agent) =>
            patchAgentMetadata(project.id, agent.path, { pinned: !agent.metadata.pinned })
          }
        />
      }
      projectId={project.id}
      streamPath={AGENTS_ROOT}
      emptyLabel="No events on the agents catalog stream yet."
    />
  );
}
