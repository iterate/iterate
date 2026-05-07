import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "~/orpc/client.ts";
import { ProjectStreamView } from "~/components/project-stream-view.tsx";
import { streamPathFromSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/streams/$",
)({
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
        organizationSlug: params.organizationSlug,
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

  return (
    <ProjectStreamView
      organizationSlug={params.organizationSlug}
      projectSlug={params.projectSlug}
      projectSlugOrId={project.id}
      streamPath={streamPath}
    />
  );
}
