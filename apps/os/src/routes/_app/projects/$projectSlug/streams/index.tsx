import { Suspense, useMemo } from "react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { useItx } from "~/itx/use-itx.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/")({
  // useItx never SSRs (it throws on the server — see ~/itx/use-itx.ts), and
  // there is no loader prefetch anymore: the tree paints from its own live
  // subscriptions once the socket connects.
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "Tree",
    project: context.project,
  }),
  component: ProjectStreamsIndexPage,
});

function ProjectStreamsIndexPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectStreamsIndexContent />
    </Suspense>
  );
}

function ProjectStreamsIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project } = Route.useLoaderData();
  const itx = useItx(project.id);
  const source = useMemo(() => (streamPath: StreamPathType) => itx.streams.get(streamPath), [itx]);

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
