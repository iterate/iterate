import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { AgentChatView } from "~/components/agent-chat-view.tsx";
import {
  projectAgentRuntimeStateQueryOptions,
  projectAgentsListQueryOptions,
} from "~/lib/project-route-query.ts";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/streams/$")({
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
  const params = Route.useParams();
  const queryClient = useQueryClient();
  const { project, streamPath } = Route.useLoaderData();
  const agentsQueryOptions = projectAgentsListQueryOptions(project.id);
  const sendMessage = useMutation(
    orpc.project.agents.sendMessage.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: agentsQueryOptions.queryKey });
      },
    }),
  );

  async function submitAgentMessage(message: string) {
    await sendMessage.mutateAsync({
      agentPath: streamPath,
      message,
      projectSlugOrId: project.id,
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b px-3 py-1.5">
        {/* The raw event firehose stays one click away for debugging. */}
        <Link
          to="/projects/$projectSlug/streams/$"
          params={{ _splat: streamPath, projectSlug: params.projectSlug }}
          className={buttonVariants({ size: "sm", variant: "ghost" })}
        >
          View raw stream
        </Link>
      </div>
      <AgentChatView
        agentPath={String(streamPath)}
        onSend={submitAgentMessage}
        projectSlugOrId={project.id}
      />
    </div>
  );
}
