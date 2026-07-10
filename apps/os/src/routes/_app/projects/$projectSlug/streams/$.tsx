import { createFileRoute } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { useItx } from "~/itx/itx-react.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/$")({
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, params._splat),
    }),
  component: ProjectStreamDetailPage,
});

function ProjectStreamDetailPage() {
  return (
    <ItxBoundary>
      <ProjectStreamDetailContent />
    </ItxBoundary>
  );
}

function ProjectStreamDetailContent() {
  const { project } = Route.useLoaderData();
  const { _splat: streamPath } = Route.useParams();
  const itx = useItx();

  async function submitMessage(message: string) {
    await itx.streams.get(streamPath).append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: message, from: { kind: "user", origin: "web" } },
    });
  }

  return (
    <ProjectStreamView
      defaultComposerMode="raw"
      messageComposer={{
        onSubmit: submitMessage,
        placeholder: "Message this stream",
      }}
      projectId={project.id}
      projectSlug={project.slug}
      streamPath={streamPath}
    />
  );
}
