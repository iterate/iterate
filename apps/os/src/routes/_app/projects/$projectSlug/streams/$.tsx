import { createFileRoute } from "@tanstack/react-router";
import { createBrowserOpenApiClient } from "~/orpc/client.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/$")({
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
    const streamPath = params._splat;
    const { project } = context;

    return breadcrumbLoaderData({
      breadcrumb: streamPath,
      project,
      streamPath,
      streamBreadcrumb: {
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath,
      },
    });
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
