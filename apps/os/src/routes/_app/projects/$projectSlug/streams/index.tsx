import { useMemo } from "react";
import { StreamState, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { useItxClient } from "~/itx/react/index.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/")({
  loader: ({ context }) => ({
    breadcrumb: "Tree",
    project: context.project,
  }),
  component: ProjectStreamsIndexPage,
});

function ProjectStreamsIndexPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const itxClient = useItxClient();
  const { project } = Route.useLoaderData();
  const source = useMemo(
    () => ({
      key: ["project", project.id, "streams"] as const,
      getState: async (streamPath: StreamPathType) =>
        StreamState.parse(
          await (await itxClient.project(project.id)).streams.get(streamPath).getState(),
        ),
    }),
    [itxClient, project.id],
  );

  function openStream(streamPath: StreamPathType) {
    void navigate({
      to: "/projects/$projectSlug/streams/$",
      params: {
        projectSlug: params.projectSlug,
        _splat: streamPath,
      },
    });
  }

  return <StreamExplorerTreePage source={source} onOpenPath={openStream} />;
}
