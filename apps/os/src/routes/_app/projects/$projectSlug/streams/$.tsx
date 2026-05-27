import { createFileRoute } from "@tanstack/react-router";
import { createBrowserOpenApiClient, orpc } from "~/orpc/client.ts";
import { ProjectStreamView } from "~/components/project-stream-view.tsx";
import { streamPathFromSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/$")({
  ssr: false,
  loader: async ({ context, params }) => {
    const streamPath = streamPathFromSplat(params._splat);
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: streamPath,
      project,
      streamPath,
      streamBreadcrumb: {
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath,
      },
    };
  },
  component: ProjectStreamDetailPage,
});

function ProjectStreamDetailPage() {
  const params = Route.useParams();
  const { project, streamPath } = Route.useLoaderData();

  async function submitMessage(message: string) {
    await createBrowserOpenApiClient().project.streams.appendBatch({
      events: [
        {
          type: "events.iterate.com/agent-chat/user-message-added",
          payload: { channel: "web", content: message },
        },
      ],
      projectSlugOrId: project.id,
      streamPath,
    });
  }

  return (
    <ProjectStreamView
      defaultComposerMode="raw"
      messageComposer={{
        onSubmit: submitMessage,
        placeholder: "Message this stream",
      }}
      projectSlug={params.projectSlug}
      projectSlugOrId={project.id}
      streamPath={streamPath}
    />
  );
}
