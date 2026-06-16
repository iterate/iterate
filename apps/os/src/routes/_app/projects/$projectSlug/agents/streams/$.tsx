import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { connectItx } from "~/itx/itx-react.tsx";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

const AGENTS_ROOT = StreamPath.parse("/agents");

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/streams/$")({
  staticData: {
    hideAppHeader: true,
    commandPalette: { stream: { mode: "agent", rootPath: AGENTS_ROOT } },
  },
  validateSearch: StreamViewSearch,
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  ssr: false,
  loader: ({ context, params }) => {
    const agentPath = params._splat;
    const { project } = context;

    return breadcrumbLoaderData({
      breadcrumb: agentPath,
      project,
      streamPath: agentPath,
      streamBreadcrumb: {
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath: agentPath,
      },
    });
  },
  component: ProjectAgentDetailPage,
});

function ProjectAgentDetailPage() {
  // The boundary is only for the lazily-loaded ProjectStreamView chunk. The
  // feed runtime dials itx imperatively, so a reconnect is handled inside the
  // stream mirror without blanking the whole page.
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading…</div>}>
      <ProjectAgentDetailContent />
    </Suspense>
  );
}

function ProjectAgentDetailContent() {
  const params = Route.useParams();
  const { project, streamPath } = Route.useLoaderData();
  // The stream view subscribes live, so a send needs no cache invalidation —
  // the new events arrive over the socket. Agent setup is owned by project and
  // agent processor facts; sendMessage only appends the user-facing input fact.
  async function submitAgentMessage(message: string) {
    const itx = await connectItx({ projectId: params.projectSlug });
    await itx.agents.sendMessage({ agentPath: streamPath, message, channel: "web" });
  }

  async function interruptAgentMessage(llmRequestId: number) {
    const itx = await connectItx({ projectId: params.projectSlug });
    await itx.streams.get(streamPath).append({
      event: {
        type: "events.iterate.com/agent/llm-request-cancelled",
        payload: {
          phase: "requested",
          llmRequestId,
          reason: "interrupted-by-user-input",
        },
      },
    });
  }

  return (
    <ProjectStreamView
      autoFocusMessageComposer
      emptyLabel="No events on this agent stream yet."
      messageComposer={{
        onInterrupt: interruptAgentMessage,
        onSubmit: submitAgentMessage,
        placeholder: "Message this agent",
      }}
      projectSlug={params.projectSlug}
      projectId={project.id}
      showCommandPaletteTrigger
      streamPath={streamPath}
    />
  );
}
