import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { useItx } from "~/itx/use-itx.ts";
import { useItxResource } from "~/itx/use-itx-resource.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  ssr: false,
  loader: async ({ context }) => {
    const { project } = context;

    return {
      breadcrumb: "Home",
      project,
    };
  },
  component: ProjectHomePage,
});

function ProjectHomePage() {
  return (
    <ItxBoundary>
      <ProjectHomeContent />
    </ItxBoundary>
  );
}

function ProjectHomeContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  // The project lifecycle snapshot lives on the Project DO's reduced-state
  // processor — reachable through the project handle's `project` surface as
  // `itx.project.processor.snapshot()` (replaces the oRPC `project.lifecycleState`).
  const itx = useItx(project.id);
  const { data: lifecycleState, refetch } = useItxResource(
    () => itx.project.processor.snapshot() as Promise<unknown>,
    [itx],
  );
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 2_500);
    return () => clearInterval(timer);
  }, [refetch]);

  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-b p-4 md:border-r md:border-b-0">
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Reduced State</h2>
            <p className="text-sm text-muted-foreground">Project lifecycle processor</p>
          </div>
          <pre className="max-h-[calc(100vh-12rem)] overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(lifecycleState ?? null, null, 2)}
          </pre>
        </div>
      </aside>
      <ProjectStreamView
        emptyLabel="No events in the project root stream yet."
        projectSlug={params.projectSlug}
        projectSlugOrId={project.id}
        streamPath={StreamPath.parse("/")}
      />
    </section>
  );
}
