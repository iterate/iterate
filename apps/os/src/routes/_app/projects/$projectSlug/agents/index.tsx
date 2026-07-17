import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "@iterate-com/ui/components/sonner";
import { AgentCatalog } from "~/components/agents/agent-catalog.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { useItx, useLiveState } from "~/itx/itx-react.tsx";
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
  const itx = useItx();
  const agents =
    useLiveState(
      (projectItx) => projectItx.liveState,
      (state) => state.agents,
      [],
    ).value ?? {};

  async function togglePinned(agent: AgentRecord): Promise<void> {
    try {
      await itx.agents.get(agent.path).setMetadata({ pinned: !agent.metadata.pinned });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update pin.");
    }
  }

  return (
    <ProjectStreamView
      layout="fullPanel"
      panel={
        <AgentCatalog
          agents={agents}
          projectSlug={params.projectSlug}
          onOpen={(path) => void navigate(linkOptionsForStreamPath(params.projectSlug, path))}
          onTogglePinned={togglePinned}
        />
      }
      projectId={project.id}
      streamPath={AGENTS_ROOT}
      emptyLabel="No events on the agents catalog stream yet."
    />
  );
}
