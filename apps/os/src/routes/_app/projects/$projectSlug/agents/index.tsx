import { Suspense, useMemo } from "react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { useItx } from "~/itx/use-itx.ts";

const AGENTS_ROOT = StreamPath.parse("/agents");

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/")({
  // Agents ARE streams: the listing is just the stream explorer scoped to
  // /agents. useItx never SSRs (it throws on the server), and the tree paints
  // from its own live subscriptions once the socket connects.
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "All",
    project: context.project,
  }),
  component: ProjectAgentsIndexPage,
});

function ProjectAgentsIndexPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectAgentsIndexContent />
    </Suspense>
  );
}

function ProjectAgentsIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project } = Route.useLoaderData();
  const itx = useItx(project.id);
  const source = useMemo(() => (streamPath: StreamPathType) => itx.streams.get(streamPath), [itx]);

  function openAgent(streamPath: StreamPathType) {
    void navigate({
      to: "/projects/$projectSlug/agents/streams/$",
      params: {
        projectSlug: params.projectSlug,
        _splat: streamPath,
      },
    });
  }

  return <StreamExplorerTreePage source={source} rootPath={AGENTS_ROOT} onOpenPath={openAgent} />;
}
