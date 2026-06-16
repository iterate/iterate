import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
import { Button } from "@iterate-com/ui/components/button";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import type { ProjectProcessorState } from "~/domains/projects/stream-processors/project/contract.ts";
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
  // The project lifecycle snapshot lives on the Project DO's reduced-state
  // processor — reachable through the project handle as
  // `itx.project.processor.snapshot()` (replaces the oRPC `project.lifecycleState`).
  // A plain useQuery + refetchInterval polls it; the panel below reads hostname
  // status the same way, so there is no SSR loader prefetch.
  const itx = useItx();
  const lifecycleStateQuery = useQuery({
    queryKey: ["itx", "project-lifecycle", project.id],
    queryFn: () => itx.project.processor.snapshot() as Promise<unknown>,
    refetchInterval: 2_500,
  });
  const lifecycleSnapshot = lifecycleStateQuery.data as
    | { state?: Partial<ProjectProcessorState> }
    | undefined;
  const onboarding = lifecycleSnapshot?.state?.onboarding ?? "in-progress";

  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(24rem,38rem)_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-b p-4 md:border-r md:border-b-0">
        <div className="flex flex-col gap-6">
          {onboarding === "in-progress" ? (
            <Alert className="border-2 p-4 text-base">
              <AlertTitle className="text-lg">Continue onboarding</AlertTitle>
              <AlertDescription>
                This project has not finished onboarding. Continue the onboarding agent before
                treating the project memory as ready.
              </AlertDescription>
              <AlertAction>
                <Button
                  size="default"
                  render={
                    <Link
                      to="/projects/$projectSlug/agents/streams/$"
                      params={{
                        _splat: "/agents/onboarding",
                        projectSlug: params.projectSlug,
                      }}
                    />
                  }
                >
                  Continue
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
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
