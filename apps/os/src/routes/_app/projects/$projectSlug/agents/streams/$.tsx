import { createFileRoute } from "@tanstack/react-router";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { getBrowserItx } from "~/itx/use-itx.ts";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";

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
  const params = Route.useParams();
  const { project, streamPath } = Route.useLoaderData();

  // Mutate-only itx use: getBrowserItx in the handler — the composer surfaces
  // a rejection itself, and the stream view is already live over its own tail.
  async function submitAgentMessage(message: string) {
    const itx = await getBrowserItx(project.id);
    await itx.agents.sendMessage({ agentPath: streamPath, message });
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
