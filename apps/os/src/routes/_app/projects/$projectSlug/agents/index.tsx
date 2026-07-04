import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { StreamTree } from "~/components/stream-tree.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItx } from "~/itx/itx-react.tsx";

const AGENTS_ROOT = "/agents";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/")({
  // Agents ARE streams: this page is the /agents catalogue stream's view, with
  // the live agent tree in the side panel. useItx never SSRs (it throws on the
  // server), and the tree paints from its own live subscriptions once the
  // socket connects.
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, AGENTS_ROOT),
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
  const { project } = Route.useLoaderData();
  const itx = useItx();
  const source = useMemo(() => (streamPath: string) => itx.streams.get(streamPath), [itx]);

  const panel = (
    <>
      <Link
        to="/projects/$projectSlug/agents/new"
        params={{ projectSlug: params.projectSlug }}
        search={{}}
        className={buttonVariants({ size: "sm" })}
      >
        New agent
      </Link>
      {/* Anything under /agents is an agent and opens the chat view —
          linkOptionsForStreamPath encodes that. */}
      <StreamTree
        source={source}
        rootPath={AGENTS_ROOT}
        scope={project.id}
        onOpenPath={(streamPath) =>
          void navigate(linkOptionsForStreamPath(params.projectSlug, streamPath))
        }
      />
    </>
  );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={project.id}
      streamPath={AGENTS_ROOT}
      emptyLabel="No events on the agents catalogue stream yet."
    />
  );
}
