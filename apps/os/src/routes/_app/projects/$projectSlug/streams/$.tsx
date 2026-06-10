import { useMemo } from "react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { StreamExplorerDetail } from "~/components/stream-explorer.tsx";
import { useItxClient } from "~/itx/react/index.ts";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { StreamNavigationState } from "~/lib/stream-navigation-state.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { createBrowserOpenApiClient } from "~/orpc/client.ts";

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
  const navigate = useNavigate();
  const itxClient = useItxClient();
  const { project, streamPath } = Route.useLoaderData();
  const source = useMemo(
    () => ({
      key: ["project", project.id, "streams"] as const,
      getState: async (path: StreamPathType) =>
        StreamNavigationState.parse(
          await (await itxClient.project(project.id)).streams.get(path).getState(),
        ),
    }),
    [itxClient, project.id],
  );

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

  function openStream(path: StreamPathType) {
    void navigate({
      to: "/projects/$projectSlug/streams/$",
      params: {
        projectSlug: params.projectSlug,
        _splat: path,
      },
    });
  }

  return (
    <StreamExplorerDetail
      currentPath={streamPath}
      onOpenPath={openStream}
      source={source}
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
