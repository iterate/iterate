import { createFileRoute } from "@tanstack/react-router";
import { useLiveState } from "iterate/sdk/itx/react";
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
 * Former project-home surface: root stream + project settings side panel.
 * The lightweight dashboard now owns `/projects/$slug`.
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

  const panel =
    lifecycle.value === undefined ? (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
        Loading project…
      </div>
    ) : (
      <>
        <ProjectSettingsPanel project={project} routeConfig={routeConfig} />
        <ProjectCustomDomainsSettings
          projectId={project.id}
          projectState={lifecycle.value}
          routeConfig={routeConfig}
        />
      </>
    );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={project.id}
      streamPath="/"
      emptyLabel="No events in the project root stream yet."
    />
  );
}
