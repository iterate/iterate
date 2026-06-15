import { useMemo } from "react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { useItx } from "~/itx/itx-react.tsx";

const AGENTS_ROOT = StreamPath.parse("/agents");

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/")({
  // Agents ARE streams: the listing is just the stream explorer scoped to
  // /agents. useItx never SSRs (it throws on the server), and the tree paints
  // from its own live subscriptions once the socket connects.
  ssr: false,
  loader: ({ context }) => ({
    project: context.project,
  }),
  component: ProjectAgentsIndexPage,
});

function ProjectAgentsIndexPage() {
  return (
    <ItxBoundary>
      <ProjectAgentsIndexContent />
    </ItxBoundary>
  );
}

function ProjectAgentsIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const itx = useItx();
  const source = useMemo(() => (streamPath: StreamPathType) => itx.streams.get(streamPath), [itx]);

  function openPath(streamPath: StreamPathType) {
    // /agents itself is not an agent — open its raw stream. Anything under it
    // is an agent: open the chat view.
    if (streamPath === AGENTS_ROOT) {
      void navigate({
        to: "/projects/$projectSlug/streams/$",
        params: { projectSlug: params.projectSlug, _splat: streamPath },
      });
      return;
    }
    void navigate({
      to: "/projects/$projectSlug/agents/streams/$",
      params: { projectSlug: params.projectSlug, _splat: streamPath },
    });
  }

  const header = (
    <div className="flex items-center gap-2">
      <Link
        to="/projects/$projectSlug/agents/new"
        params={{ projectSlug: params.projectSlug }}
        className={buttonVariants({ size: "sm" })}
      >
        New agent
      </Link>
      <Link
        to="/projects/$projectSlug/agents/new-preset"
        params={{ projectSlug: params.projectSlug }}
        className={buttonVariants({ size: "sm", variant: "outline" })}
      >
        New preset
      </Link>
    </div>
  );

  return (
    <StreamExplorerTreePage
      header={header}
      source={source}
      rootPath={AGENTS_ROOT}
      onOpenPath={openPath}
    />
  );
}
