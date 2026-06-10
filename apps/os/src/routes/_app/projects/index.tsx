import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import type { Project } from "@iterate-com/os-contract";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { toast } from "@iterate-com/ui/components/sonner";
import { cacheCreatedProjectQueries } from "~/lib/cache-created-project-queries.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(projectsListQueryOptions({ limit: 20, offset: 0 }));

    return {
      routeConfig: await getPublicRouteConfig(),
    };
  },
  component: ProjectsIndexPage,
});

function buildProjectHostname(input: {
  slug: string;
  customHostname: string | null;
  projectHostnameBases: readonly string[];
}) {
  if (input.customHostname) return input.customHostname;
  const base = input.projectHostnameBases[0];
  if (!base) return null;
  return `${input.slug}.${normalizeProjectHostnameBase(base)}`;
}

function ProjectsIndexPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { routeConfig } = Route.useLoaderData();
  const { data: projectsData } = useQuery(projectsListQueryOptions({ limit: 20, offset: 0 }));

  const createProject = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: async (project) => {
        cacheCreatedProjectQueries({ project, queryClient });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
        await router.invalidate({ sync: true });
        await router.navigate({
          to: "/projects/$projectSlug",
          params: {
            projectSlug: project.slug,
          },
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const deleteProject = useMutation(
    orpc.projects.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const hasProjects = (projectsData?.projects.length ?? 0) > 0;

  return (
    <section className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Projects</h2>
          <p className="text-sm text-muted-foreground">Create and manage projects.</p>
        </div>
        {hasProjects ? (
          <Button type="button" size="sm" render={<Link to="/new-project" />}>
            New project
          </Button>
        ) : null}
      </div>

      {!hasProjects ? (
        <div className="rounded-xl border border-dashed bg-card/60 px-6 py-14 text-center">
          <div className="mx-auto flex max-w-md flex-col items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <FolderPlus className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold">No projects yet</h3>
              <p className="text-sm text-muted-foreground">
                Create your first project to start using OS.
              </p>
            </div>
            <Button type="button" size="sm" render={<Link to="/new-project" />}>
              Create new project
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <div className="grid min-w-[900px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_96px] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <div>ID</div>
            <div>Slug</div>
            <div>Custom hostname</div>
            <div>Hostname</div>
            <div>Created</div>
            <div />
          </div>
          {projectsData?.projects.map((project) => {
            const hostname = buildProjectHostname({
              slug: project.slug,
              customHostname: project.customHostname,
              projectHostnameBases: routeConfig.projectHostnameBases,
            });

            return (
              <div
                key={project.id}
                className="grid min-w-[900px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_96px] items-start gap-3 border-b px-3 py-3 text-sm last:border-b-0"
              >
                <Identifier value={project.id} textClassName="text-xs text-muted-foreground" />
                <ProjectSlugCell project={project} />
                <div className="truncate text-xs text-muted-foreground">
                  {project.isOrphanedProjectFromAuthService
                    ? "Not created in OS"
                    : (project.customHostname ?? "None")}
                </div>
                <div className="truncate text-xs">
                  {!project.isOrphanedProjectFromAuthService && hostname ? (
                    <a
                      href={`https://${hostname}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:underline"
                    >
                      {hostname}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{project.createdAt ?? "-"}</div>
                {project.isOrphanedProjectFromAuthService ? (
                  <Button
                    size="sm"
                    onClick={() => createProject.mutate({ id: project.id, slug: project.slug })}
                    disabled={createProject.isPending && createProject.variables?.id === project.id}
                  >
                    {createProject.isPending && createProject.variables?.id === project.id
                      ? "Creating..."
                      : "Create"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteProject.mutate({ id: project.id })}
                    disabled={deleteProject.isPending && deleteProject.variables?.id === project.id}
                  >
                    {deleteProject.isPending && deleteProject.variables?.id === project.id
                      ? "Deleting..."
                      : "Delete"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProjectSlugCell({ project }: { project: Project }) {
  if (project.isOrphanedProjectFromAuthService) {
    return (
      <div className="min-w-0">
        <div className="truncate font-medium">{project.slug}</div>
        <div className="text-xs text-muted-foreground">Available from Auth</div>
      </div>
    );
  }

  return (
    <Link
      to="/projects/$projectSlug"
      params={{
        projectSlug: project.slug,
      }}
      className="truncate font-medium hover:underline"
    >
      {project.slug}
    </Link>
  );
}
