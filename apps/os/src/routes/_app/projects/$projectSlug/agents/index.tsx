import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { StreamPage } from "~/components/stream-page.tsx";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { StreamPath } from "~/lib/stream-links.ts";
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
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: {
        projectId: context.project.id,
        projectSlug: params.projectSlug,
        streamPath: StreamPath.parse(AGENTS_ROOT),
      },
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

  function openPath(streamPath: string) {
    // Anything under /agents is an agent and opens the chat view —
    // linkOptionsForStreamPath encodes that.
    void navigate(linkOptionsForStreamPath(params.projectSlug, StreamPath.parse(streamPath)));
  }

  const panel = (
    <>
      <Link
        to="/projects/$projectSlug/agents/new"
        params={{ projectSlug: params.projectSlug }}
        className={buttonVariants({ size: "sm" })}
      >
        New agent
      </Link>
      <StreamTreeBrowser source={source} rootPath={AGENTS_ROOT} onOpenPath={openPath} />
    </>
  );

  return (
    <StreamPage
      panel={panel}
      projectId={project.id}
      streamPath={AGENTS_ROOT}
      emptyLabel="No events on the agents catalogue stream yet."
    />
  );
}
