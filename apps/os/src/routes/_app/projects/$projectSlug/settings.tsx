import { createFileRoute } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { useItxState } from "~/itx/itx-react.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import type { ProjectProcessorState } from "~/types.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/settings")({
  ssr: false,
  loader: async ({ context }) => ({
    ...breadcrumbLoaderData({
      breadcrumb: "Settings",
    }),
    project: context.project,
    routeConfig: await getPublicRouteConfig(),
  }),
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  return (
    <ItxBoundary>
      <ProjectSettingsContent />
    </ItxBoundary>
  );
}

function ProjectSettingsContent() {
  const { project, routeConfig } = Route.useLoaderData();
  const projectState = useItxState<ProjectProcessorState>(
    (itx, setState) => itx.processor.onStateChange(setState),
    [project.id],
  ).state;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <ProjectSettingsPanel
        project={project}
        projectState={projectState}
        routeConfig={routeConfig}
      />
    </main>
  );
}
