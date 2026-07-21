import { createFileRoute } from "@tanstack/react-router";
import { useLiveState } from "iterate/sdk/itx/react";
import { ProjectCreationProgress } from "~/components/project-creation-progress.tsx";
import { ProjectCustomDomainsSettings } from "~/components/project-custom-domains-settings.tsx";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

/**
 * Project settings over the root stream, in the standard full-panel layout
 * (like repos): the forms get the page, the root stream's events live in the
 * header's Events sheet.
 */
export const Route = createFileRoute("/_app/projects/$projectSlug/settings")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: async ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
      streamBreadcrumb: streamBreadcrumb(context.project, "/"),
      breadcrumb: "Settings",
    }),
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { project, routeConfig } = Route.useLoaderData();
  const lifecycle = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
    [project.id],
    { slug: project.id },
  );

  const panel = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 md:p-8">
        {lifecycle.value === undefined ? (
          <p className="text-sm text-muted-foreground" data-spinner="true">
            Loading project…
          </p>
        ) : !lifecycle.value.ready ? (
          // Same gate as project home: a not-yet-ready project shows the
          // bootstrap checklist, never live settings forms.
          <ProjectCreationProgress state={lifecycle.value} />
        ) : (
          <>
            <ProjectSettingsPanel project={project} routeConfig={routeConfig} />
            <ProjectCustomDomainsSettings
              projectId={project.id}
              projectState={lifecycle.value}
              routeConfig={routeConfig}
            />
          </>
        )}
      </div>
    </div>
  );

  return (
    <ProjectStreamView
      layout="fullPanel"
      panel={panel}
      projectId={project.id}
      streamPath="/"
      emptyLabel="No events in the project root stream yet."
    />
  );
}
