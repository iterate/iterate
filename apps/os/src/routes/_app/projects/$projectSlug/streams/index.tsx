import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { useItx } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/")({
  // useItx never SSRs (it throws on the server — see ~/itx/itx-react.tsx), and
  // there is no loader prefetch anymore: the tree paints from its own live
  // subscriptions once the socket connects.
  ssr: false,
  loader: ({ context }) => ({
    project: context.project,
  }),
  component: ProjectStreamsIndexPage,
});

function ProjectStreamsIndexPage() {
  return (
    <ItxBoundary>
      <ProjectStreamsIndexContent />
    </ItxBoundary>
  );
}

function ProjectStreamsIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const itx = useItx();
  const source = useMemo(() => (streamPath: string) => itx.streams.get(streamPath), [itx]);

  function openStream(streamPath: string) {
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
