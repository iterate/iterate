import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { getBrowserItx } from "~/itx/use-itx.ts";
import { projectAgentRuntimeStateQueryOptions } from "~/lib/project-route-query.ts";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { orpc } from "~/orpc/client.ts";

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
  loader: async ({ context, params }) => {
    const agentPath = params._splat;
    const { project } = context;
    await context.queryClient.ensureQueryData(
      projectAgentRuntimeStateQueryOptions({ agentPath, projectId: project.id }),
    );

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
  // feed itself does NOT depend on itx — it mirrors the project-streams socket
  // directly — so a dropped itx connection must never blank this page.
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
  // the new events arrive over the socket.
  const sendMessage = useMutation(orpc.project.agents.sendMessage.mutationOptions());

  async function submitAgentMessage(message: string) {
    await sendMessage.mutateAsync({
      agentPath: streamPath,
      message,
      projectSlugOrId: project.id,
    });
  }

  async function interruptAgentMessage(llmRequestId: number) {
    await getBrowserItx(project.id).then((itx) =>
      itx.streams.get(streamPath).append({
        type: "events.iterate.com/agent/llm-request-cancelled",
        payload: {
          phase: "requested",
          llmRequestId,
          reason: "interrupted-by-user-input",
        },
      }),
    );
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
      projectSlugOrId={project.id}
      showCommandPaletteTrigger
      streamPath={streamPath}
    />
  );
}
