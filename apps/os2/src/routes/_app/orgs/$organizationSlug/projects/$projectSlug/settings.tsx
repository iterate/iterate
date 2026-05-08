import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import type { Project } from "@iterate-com/os2-contract";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { EventsDebugLink } from "~/components/events-debug-link.tsx";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/settings")(
  {
    loader: async ({ context, params }) => {
      await context.queryClient.ensureQueryData({
        ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
        staleTime: 30_000,
      });

      return {
        breadcrumb: "Settings",
      };
    },
    component: ProjectDetailPage,
  },
);

function ProjectDetailPage() {
  const params = Route.useParams();
  const { data: project } = useQuery({
    ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
    staleTime: 30_000,
  });

  if (!project) return null;

  return <ProjectDetailContent organizationSlug={params.organizationSlug} project={project} />;
}

function ProjectDetailContent({
  organizationSlug,
  project,
}: {
  organizationSlug: string;
  project: Project;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [customHostname, setCustomHostname] = useState(project.customHostname ?? "");
  const updateConfig = useMutation(
    orpc.projects.updateConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.projects.find.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.findBySlug.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
        void router.invalidate();
        toast.success("Project config saved.");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const handleUpdateConfig = useCallback(() => {
    updateConfig.mutate({
      id: project.id,
      customHostname: customHostname.trim() === "" ? null : customHostname,
    });
  }, [customHostname, project.id, updateConfig]);

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{project.slug}</h2>
        <p className="text-sm text-muted-foreground">
          Update hostname routing and inspect the stored project fields.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Slug</p>
          <p className="font-medium">{project.slug}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Project ID</p>
          <Identifier value={project.id} />
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Events namespace</p>
          <EventsDebugLink label="Open project in Events" namespace={project.id} streamPath="/" />
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Custom hostname</p>
          <div className="flex gap-2">
            <Input
              placeholder="app.example.com"
              value={customHostname}
              onChange={(event) => setCustomHostname(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && handleUpdateConfig()}
            />
            <Button size="sm" onClick={handleUpdateConfig} disabled={updateConfig.isPending}>
              {updateConfig.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
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

      <Button
        size="sm"
        variant="outline"
        nativeButton={false}
        render={<Link to="/orgs/$organizationSlug/projects" params={{ organizationSlug }} />}
      >
        Back to projects
      </Button>
    </section>
  );
}
