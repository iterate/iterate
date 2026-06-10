import { useMemo } from "react";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import { itxKey, useItxClient } from "~/itx/react/index.ts";
import { prefetchItxQuery } from "~/itx/loader.ts";
import { projectStreamStateQuery } from "~/lib/itx-queries.ts";

const ROOT_STREAM_PATH = StreamPath.parse("/");

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/")({
  loader: async ({ context }) => {
    // Seed the root stream state — the query that gates the tree's first
    // paint — so SSR dehydrates it and client navigations land warm. Best
    // effort: prefetchItxQuery swallows failures, the component's own query
    // surfaces them inline.
    await prefetchItxQuery({
      queryClient: context.queryClient,
      query: projectStreamStateQuery({
        projectId: context.project.id,
        streamPath: ROOT_STREAM_PATH,
      }),
    });
    return {
      breadcrumb: "Tree",
      project: context.project,
    };
  },
  component: ProjectStreamsIndexPage,
});

function ProjectStreamsIndexPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const itxClient = useItxClient();
  const { project } = Route.useLoaderData();
  const source = useMemo(
    () => ({
      // StreamTreeBrowser keys node queries as [...key, "state", path], which
      // lands exactly on projectStreamStateKey(...) — the entry the route
      // loader seeds and the breadcrumb navigators read.
      key: itxKey.project(project.id, "streams"),
      getState: async (streamPath: StreamPathType) =>
        await projectStreamStateQuery({ projectId: project.id, streamPath }).queryFn(
          await itxClient.project(project.id),
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
