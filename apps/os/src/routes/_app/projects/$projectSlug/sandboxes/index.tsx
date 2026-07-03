import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { StreamPage } from "~/components/stream-page.tsx";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItx } from "~/itx/itx-react.tsx";

const SANDBOXES_ROOT = "/sandboxes";

export const Route = createFileRoute("/_app/projects/$projectSlug/sandboxes/")({
  // Sandboxes ARE streams (a Cloudflare sandbox lives at
  // /sandboxes/cloudflare/<name>): this page is the /sandboxes catalogue
  // stream's view, with the live sandbox tree in the side panel.
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, SANDBOXES_ROOT),
    }),
  component: ProjectSandboxesIndexPage,
});

function ProjectSandboxesIndexPage() {
  return (
    <ItxBoundary>
      <ProjectSandboxesIndexContent />
    </ItxBoundary>
  );
}

function ProjectSandboxesIndexContent() {
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
          rootPath={SANDBOXES_ROOT}
          onOpenPath={(streamPath) =>
            void navigate(linkOptionsForStreamPath(params.projectSlug, streamPath))
          }
        />
      }
      projectId={project.id}
      streamPath={SANDBOXES_ROOT}
      emptyLabel="No events on the sandboxes catalogue stream yet."
    />
  );
}
