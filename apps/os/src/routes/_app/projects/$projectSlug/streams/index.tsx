import { createFileRoute } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/")({
  staticData: streamPageStaticData(),
  // The project root stream, full width. Stream NAVIGATION is ⌘K's job — the
  // pill in the header opens the one stream explorer; no tree panel here.
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
  const { project } = Route.useLoaderData();

  return (
    <ProjectStreamView
      projectId={project.id}
      streamPath="/"
      emptyLabel="No events in the project root stream yet."
    />
  );
}
