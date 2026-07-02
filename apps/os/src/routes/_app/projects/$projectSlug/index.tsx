import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { useItx } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  ssr: false,
  loader: async ({ context }) => {
    return {
      breadcrumb: "Home",
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
    };
  },
  component: ProjectHomePage,
});

function ProjectHomePage() {
  const params = Route.useParams();
  const { project, routeConfig } = Route.useLoaderData();
  // The project lifecycle snapshot lives on the project's reduced-state
  // processor, reachable as `itx.processor.snapshot()`. A plain useQuery +
  // refetchInterval polls it until `created` flips true.
  const itx = useItx();
  const lifecycleStateQuery = useQuery({
    queryKey: ["itx", "project-lifecycle", project.id],
    queryFn: async () => await itx.processor.snapshot(),
    refetchInterval: (query) => (query.state.data?.state.created ? false : 2_500),
  });
  const created = lifecycleStateQuery.data?.state.created ?? false;

  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(24rem,38rem)_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-b p-4 md:border-r md:border-b-0">
        <div className="flex flex-col gap-6">
          {/* TODO(itx-v4 cutover): the onboarding-agent flow has no next-engine
              equivalent yet; `created` from the project processor is the only
              readiness signal for now. */}
          {created ? null : (
            <Alert className="border-2 p-4 text-base">
              <AlertTitle className="text-lg">Project setup in progress</AlertTitle>
              <AlertDescription>
                The project processor has not confirmed creation yet. This page refreshes
                automatically until the project is ready.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">Reduced State</h2>
              <p className="text-sm text-muted-foreground">Project lifecycle processor</p>
            </div>
            <pre className="max-h-[calc(100vh-12rem)] overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(lifecycleStateQuery.data ?? null, null, 2)}
            </pre>
          </div>
          <ProjectSettingsPanel project={project} routeConfig={routeConfig} />
        </div>
      </aside>
      <ProjectStreamView
        emptyLabel="No events in the project root stream yet."
        projectSlug={params.projectSlug}
        projectId={project.id}
        streamPath={StreamPath.parse("/")}
      />
    </section>
  );
}
