import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.tsx";
import { projectLifecycleStateQueryOptions } from "~/lib/project-route-query.ts";

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
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const lifecycleStateQuery = useQuery({
    ...projectLifecycleStateQueryOptions(project.id),
    refetchInterval: 2_500,
  });

  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-b p-4 md:border-r md:border-b-0">
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Reduced State</h2>
            <p className="text-sm text-muted-foreground">Project lifecycle processor</p>
          </div>
          <pre className="max-h-[calc(100vh-12rem)] overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(lifecycleStateQuery.data ?? null, null, 2)}
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
