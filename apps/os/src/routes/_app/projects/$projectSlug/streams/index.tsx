import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { StreamPage } from "~/components/stream-page.tsx";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItx } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/")({
  // The project-wide stream explorer: the live stream tree in the side panel,
  // the root stream in the main space. useItx never SSRs (it throws on the
  // server — see ~/itx/itx-react.tsx); the tree paints from its own live
  // subscriptions once the socket connects.
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, "/"),
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
  const { project } = Route.useLoaderData();
  const itx = useItx();
  const source = useMemo(() => (streamPath: string) => itx.streams.get(streamPath), [itx]);

  return (
    <StreamPage
      panel={
        <StreamTreeBrowser
          source={source}
          onOpenPath={(streamPath) =>
            void navigate(linkOptionsForStreamPath(params.projectSlug, streamPath))
          }
        />
      }
      projectId={project.id}
      streamPath="/"
      emptyLabel="No events in the project root stream yet."
    />
  );
}
