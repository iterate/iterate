import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { StreamExplorerDetail } from "~/components/stream-explorer.tsx";
import { useItx } from "~/itx/itx-react.tsx";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/$")({
  staticData: { hideAppHeader: true, commandPalette: { stream: { mode: "stream" } } },
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
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectStreamDetailContent />
    </Suspense>
  );
}

function ProjectStreamDetailContent() {
  const params = Route.useParams();
  const { project, streamPath } = Route.useLoaderData();
  const itx = useItx();

  async function submitMessage(message: string) {
    await itx.streams.get(streamPath).appendBatch({
      events: [
        {
          type: "events.iterate.com/agents/user-message-received",
          payload: { content: message, origin: "web" },
        },
      ],
    });
  }

  return (
    <StreamExplorerDetail
      currentPath={streamPath}
      showCommandPaletteTrigger
      streamView={{
        defaultComposerMode: "raw",
        messageComposer: {
          onSubmit: submitMessage,
          placeholder: "Message this stream",
        },
        projectSlug: params.projectSlug,
        projectSlugOrId: project.id,
      }}
    />
  );
}
