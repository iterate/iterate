import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.find.queryOptions({ input: { id: params.projectId } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: project.slug,
      project,
    };
  },
  component: ProjectDetailPage,
});

function ProjectDetailPage() {
  const { project } = Route.useLoaderData();

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{project.slug}</h2>
        <p className="text-sm text-muted-foreground">
          Detail page for the nested breadcrumb os. The second crumb comes from the route loader,
          not from pathname parsing.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Slug</p>
          <p className="font-medium">{project.slug}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Identifier</p>
          <Identifier value={project.id} />
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Metadata</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {JSON.stringify(project.metadata, null, 2)}
          </pre>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
          <p className="text-sm text-muted-foreground">{project.createdAt}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
          <p className="text-sm text-muted-foreground">{project.updatedAt}</p>
        </div>
      </div>

      <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/projects" />}>
        Back to projects
      </Button>
    </section>
  );
}
