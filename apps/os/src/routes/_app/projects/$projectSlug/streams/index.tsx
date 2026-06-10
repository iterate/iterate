import { useMemo } from "react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import { useItxClient } from "~/itx/react/index.ts";
import { parseStreamNavigationState } from "~/lib/stream-navigation-state.ts";

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
        parseStreamNavigationState(
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

  return (
    <section className="flex min-h-0 flex-1 flex-col p-4">
      <StreamTreeBrowser source={source} onOpenPath={openStream} />
    </section>
  );
}
