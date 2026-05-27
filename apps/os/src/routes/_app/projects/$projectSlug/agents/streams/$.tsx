import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ProjectStreamView } from "~/components/project-stream-view.tsx";
import { streamPathFromSplat } from "~/lib/stream-links.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/streams/$")({
  ssr: false,
  loader: async ({ context, params }) => {
    const agentPath = streamPathFromSplat(params._splat);
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.agents.runtimeState.queryOptions({
        input: { agentPath, projectSlugOrId: project.id },
      }),
      staleTime: 5_000,
    });

    return {
      breadcrumb: agentPath,
      project,
      streamPath: agentPath,
      streamBreadcrumb: {
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath: agentPath,
      },
    };
  },
  component: ProjectAgentDetailPage,
});

function ProjectAgentDetailPage() {
  const params = Route.useParams();
  const queryClient = useQueryClient();
  const { project, streamPath } = Route.useLoaderData();
  const agentsQueryOptions = orpc.project.agents.list.queryOptions({
    input: { projectSlugOrId: project.id },
  });
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
    <ProjectStreamView
      emptyLabel="No events on this agent stream yet."
      messageComposer={{
        onSubmit: submitAgentMessage,
        placeholder: "Message this agent",
      }}
      projectSlug={params.projectSlug}
      projectSlugOrId={project.id}
      streamPath={streamPath}
    />
  );
}
